import { createServer, type ServerResponse } from "node:http";
import { z } from "zod";
import { decideDelivery } from "./delivery_decision";
import { infrai, InfraiError } from "./infrai_storage";

const BUCKET = process.env.CREATOR_MEDIA_BUCKET ?? "creator-commerce-media";
const PORT = Number(process.env.PORT ?? 3000);

const initiateBody = z.object({
  asset_id: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/),
  creator_id: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/),
  filename: z.string().min(1),
  content_type: z.string().min(1),
  size_bytes: z.number().int().positive(),
  part_count: z.number().int().min(1).max(10_000),
  idempotency_key: z.string().min(8),
});

const completeBody = z.object({
  subscriber_count: z.number().int().nonnegative(),
  parts: z.array(z.object({
    part_number: z.number().int().positive(),
    etag: z.string().min(1),
  })).min(1),
});

const initiated = new Map<string, unknown>();
const sessions = new Map<string, { asset_id: string; creator_id: string; object_key: string }>();

async function ensureBucket(): Promise<void> {
  try {
    await infrai.storage.bucket.get(BUCKET);
  } catch (error) {
    if (!(error instanceof InfraiError) || error.status !== 404) throw error;
    await infrai.storage.bucket.create({ name: BUCKET });
  }
}

const bucketReady = ensureBucket();

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function readJson(request: AsyncIterable<Uint8Array>): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function keyFor(creatorId: string, assetId: string, filename: string): string {
  const extension = filename.includes(".") ? filename.slice(filename.lastIndexOf(".")) : "";
  return `creators/${creatorId}/assets/${assetId}/original${extension}`;
}

const server = createServer(async (request, response) => {
  try {
    await bucketReady;

    if (request.method === "POST" && request.url === "/creator-assets/uploads") {
      const input = initiateBody.parse(await readJson(request));
      const cached = initiated.get(input.idempotency_key);
      if (cached) return json(response, 200, cached);

      const objectKey = keyFor(input.creator_id, input.asset_id, input.filename);
      const created = await infrai.storage.multipart.create(BUCKET, { key: objectKey });
      const parts = await Promise.all(
        Array.from({ length: input.part_count }, async (_, index) => {
          const part_number = index + 1;
          const signed = await infrai.storage.multipart.presign_part(created.upload_id, part_number);
          return { part_number, upload_url: signed.url, method: "PUT" as const };
        }),
      );
      const result = {
        asset_id: input.asset_id,
        upload_id: created.upload_id,
        object_key: objectKey,
        content_type: input.content_type,
        size_bytes: input.size_bytes,
        part_size_min: created.part_size_min,
        parts,
        asset_status: "uploading",
      };
      initiated.set(input.idempotency_key, result);
      sessions.set(created.upload_id, {
        asset_id: input.asset_id,
        creator_id: input.creator_id,
        object_key: objectKey,
      });
      return json(response, 201, result);
    }

    const completeMatch = request.url?.match(/^\/creator-assets\/uploads\/([^/]+)\/complete$/);
    if (request.method === "POST" && completeMatch) {
      const input = completeBody.parse(await readJson(request));
      const uploadId = decodeURIComponent(completeMatch[1]);
      const session = sessions.get(uploadId);
      if (!session) return json(response, 404, { error: "upload_session_not_found" });
      const parts = input.parts.map(({ part_number, etag }) => ({
        part_number: part_number!,
        etag: etag!,
      }));
      const completed = await infrai.storage.multipart.complete(uploadId, { parts });
      const stored = await infrai.storage.object.head(BUCKET, session.object_key);
      const delivery = decideDelivery(stored.found, input.subscriber_count);
      sessions.delete(uploadId);
      return json(response, 200, {
        asset_id: session.asset_id,
        creator_id: session.creator_id,
        object_key: completed.key,
        stored_bytes: completed.size_bytes,
        ...delivery,
      });
    }

    const abortMatch = request.url?.match(/^\/creator-assets\/uploads\/([^/]+)$/);
    if (request.method === "DELETE" && abortMatch) {
      const uploadId = decodeURIComponent(abortMatch[1]);
      await infrai.storage.multipart.abort(uploadId);
      return json(response, 200, { upload_id: uploadId, asset_status: "cancelled" });
    }

    json(response, 404, { error: "route_not_found" });
  } catch (error) {
    if (error instanceof z.ZodError) {
      const validationError = error as { issues: unknown };
      return json(response, 400, { error: "invalid_request", issues: validationError.issues });
    }
    if (error instanceof InfraiError) {
      const status = error.status >= 400 && error.status < 500 ? error.status : 502;
      return json(response, status, { error: error.code, message: error.message });
    }
    console.error(error);
    json(response, 500, { error: "service_error" });
  }
});

server.listen(PORT, () => {
  console.log(`Creator media service listening on http://localhost:${PORT}`);
});
