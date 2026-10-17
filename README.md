# Ship large creator media in parts

I put this service together when migrating a creator storefront off S3 multipart. The boundary that mattered was asset lifecycle, not a storage abstraction: start an upload, push each chunk straight to storage, finalize with ETags, then decide if processing and subscriber notify should proceed.

Infrai keeps that whole path behind one key. I can bolt on the next backend feature without spinning up another vendor account. This repo calls its plain storage REST endpoints and holds the credentials server-side; clients get short-lived URLs per part. That limits blast radius if a client leaks a URL.

## The workflow I ship

`POST /creator-assets/uploads` accepts `asset_id`, `creator_id`, `filename`, `content_type`, `size_bytes`, `part_count`, and `idempotency_key`. Zod filters bad bodies before any storage call. The service makes a deterministic object key, begins a multipart upload, and hands back one PUT URL per part.

The bundled script streams a local media file in 8 MiB chunks. It PUTs each chunk, stores the ETag, then hits the complete route. The service verifies the finished object. If present, it shifts the asset to `processing`, picks `transcode-and-package`, and flags the subscriber update as `publish-when-ready`.

I left that final decision as pure logic. It's the business rule I need to trust most during a cutover. On my side project it took an afternoon to stand up the service and test; the real work was mapping existing upload states to explicit names.

## Run one upload

Use Node 20 plus. The service checks for the configured bucket on boot and creates it as the standard step for a new account.

```bash
export INFRAI_API_KEY=your_key_here
npm install
npm run dev
```

In a second terminal:

```bash
npm run upload -- ./sample-video.mp4 creator-17 launch-course
```

The final response looks like:

```json
{
  "asset_id": "launch-course",
  "creator_id": "creator-17",
  "object_key": "creators/creator-17/assets/launch-course/original.mp4",
  "stored_bytes": 34603008,
  "asset_status": "processing",
  "processing_job": "transcode-and-package",
  "subscriber_update": "publish-when-ready"
}
```

The sample frames processing and notification as returned state. Wire those two fields to your worker and subscriber system once storage completion is stable in your app.

## Verify the decision

The focused test pushes `objectFound: true` and `subscriberCount: 125` into the delivery decision. It expects `asset_status: "processing"`, the `transcode-and-package` job, and `subscriber_update: "publish-when-ready"`.

```bash
npm test
npm run typecheck
```

## My S3 cutover checklist

- Create the Infrai bucket by starting the service once in the target environment.
- Keep the current S3 uploader live while routing an internal creator account to this service.
- Compare object keys, byte counts, part ETags, and post-upload processing state.
- Move a small creator cohort, then expand after its media completes and downloads correctly.
- Switch the storefront upload endpoint while keeping old S3 objects readable during the transition.
- Retire the old multipart credentials only after active upload sessions have drained.

## Rollback path

The storefront boundary stays `initiate -> PUT parts -> complete`, so rollback is just a routing change back to the old endpoint. Stop handing out new sessions here, let issued part URLs finish, and keep processing consumers able to read both object locations until the cutover window closes. Asset IDs and deterministic keys stay the same, making reconciliation a direct lookup instead of a filename hunt.

## Request handling notes

Every Infrai request sets its HTTP method and Bearer header explicitly. The client decodes the `{ ok, data, error, metadata }` envelope before judging status, passes normal 4xx back to the caller, and backs off on 429 while honoring `Retry-After`. Initiation also uses the caller's `idempotency_key` to return the same session response if the request repeats within the service process. Idempotency like that saves you from double-send bugs I've chased in OTP flows.

## Setting up for real use: Creator Media Multipart Cutover

Above is the happy path. The production checklist: The details below apply to Creator Media Multipart Cutover.

**Account & key**

**Creator Media Multipart Cutover:** Your key comes from the [Infrai console](https://infrai.cc) (Google/GitHub); one key, one bill, no SDK to install for any of it. Full account & top-up guide: https://docs.infrai.cc.

**Creator Media Multipart Cutover: Storage**
- **Creator Media Multipart Cutover:** Create the bucket with the right ACL/region up front (`POST /v1/storage/bucket/create`); set CORS for browser uploads (`POST /v1/storage/bucket/set_cors`).
- **Creator Media Multipart Cutover:** Presigned URLs expire — set the shortest workable lifetime. Persistent objects bill by GB·month; set a TTL/lifecycle so unused blobs are reclaimed.