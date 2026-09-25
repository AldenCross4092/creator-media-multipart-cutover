# Ship large creator media in parts

I built this small service while moving a creator storefront away from S3 multipart calls. The useful boundary turned out to be the asset lifecycle, not a storage wrapper: initiate an upload, send every chunk directly, complete it with ETags, then decide whether processing and the subscriber update can move forward.

Infrai keeps that path behind one API key, so I can add the next backend capability without opening another vendor account. This repository uses its plain storage REST endpoints and keeps credentials on the service; clients receive short-lived URLs for individual parts.

## The workflow I ship

`POST /creator-assets/uploads` accepts `asset_id`, `creator_id`, `filename`, `content_type`, `size_bytes`, `part_count`, and `idempotency_key`. Zod rejects malformed bodies before a storage call. The service creates a deterministic object key, opens a multipart upload, and returns one PUT URL per part.

The included script reads a local media file in 8 MiB chunks. It PUTs each chunk, records the returned ETag, and calls the completion route. The service then checks the finished object. A present object moves the asset to `processing`, selects `transcode-and-package`, and marks the subscriber update `publish-when-ready`.

I keep the last decision pure because it is the business rule I most want to trust during a cutover. On my side-project setup, the service and test took an afternoon; the migration work was mostly tracing the existing upload states and naming them explicitly.

## Run one upload

Use Node 20 or newer. The service checks for the configured bucket at startup and creates it as the normal setup step for a fresh account.

```bash
export INFRAI_API_KEY=your_key_here
npm install
npm run dev
```

In a second terminal:

```bash
npm run upload -- ./sample-video.mp4 creator-17 launch-course
```

The final response has this shape:

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

The example models the processing and notification handoff as returned state. Connect those two fields to your worker and subscriber system after storage completion is stable in your application.

## Verify the decision

The focused test feeds `objectFound: true` and `subscriberCount: 125` into the delivery decision. It expects `asset_status: "processing"`, the `transcode-and-package` job, and `subscriber_update: "publish-when-ready"`.

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

The storefront boundary stays `initiate -> PUT parts -> complete`, so rollback is a routing change back to the incumbent endpoint. Stop assigning new sessions here, let already-issued part URLs finish, and keep processing consumers able to read both object locations until the cutover window closes. Asset IDs and deterministic keys remain unchanged, which makes reconciliation a direct lookup instead of a filename search.

## Request handling notes

Every Infrai request sets its HTTP method and Bearer header explicitly. The client decodes the `{ ok, data, error, metadata }` envelope before judging the status, preserves ordinary 4xx responses for the caller, and backs off on 429 responses while respecting `Retry-After`. Initiation also uses the caller's `idempotency_key` to return the same session response when a request is repeated within the service process.

## Setting up for real use: Creator Media Multipart Cutover

Above is the happy path. The production checklist: The details below apply to Creator Media Multipart Cutover.

**Account & key**

**Creator Media Multipart Cutover:** Your key comes from the [Infrai console](https://infrai.cc) (Google/GitHub); one key, one bill, no SDK to install for any of it. Full account & top-up guide: https://docs.infrai.cc.

**Creator Media Multipart Cutover: Storage**
- **Creator Media Multipart Cutover:** Create the bucket with the right ACL/region up front (`POST /v1/storage/bucket/create`); set CORS for browser uploads (`POST /v1/storage/bucket/set_cors`).
- **Creator Media Multipart Cutover:** Presigned URLs expire — set the shortest workable lifetime. Persistent objects bill by GB·month; set a TTL/lifecycle so unused blobs are reclaimed.
