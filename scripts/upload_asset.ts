import { open, stat } from "node:fs/promises";
import { basename } from "node:path";

const serviceUrl = process.env.CREATOR_MEDIA_URL ?? "http://localhost:3000";
const sourcePath = process.argv[2];
const creatorId = process.argv[3] ?? "maker-42";
const assetId = process.argv[4] ?? `asset-${Date.now()}`;
const partSize = 8 * 1024 * 1024;

if (!sourcePath) {
  console.error("Usage: npm run upload -- <media-path> [creator-id] [asset-id]");
  process.exit(1);
}

async function serviceCall<T>(path: string, method: "POST", body: unknown): Promise<T> {
  const response = await fetch(serviceUrl + path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? `Service returned HTTP ${response.status}`);
  return result;
}

const file = await stat(sourcePath);
const partCount = Math.ceil(file.size / partSize);
const upload = await serviceCall<{
  upload_id: string;
  object_key: string;
  parts: Array<{ part_number: number; upload_url: string; method: "PUT" }>;
}>("/creator-assets/uploads", "POST", {
  asset_id: assetId,
  creator_id: creatorId,
  filename: basename(sourcePath),
  content_type: "application/octet-stream",
  size_bytes: file.size,
  part_count: partCount,
  idempotency_key: `${creatorId}:${assetId}`,
});

const handle = await open(sourcePath, "r");
const completedParts: Array<{ part_number: number; etag: string }> = [];
try {
  for (const part of upload.parts) {
    const offset = (part.part_number - 1) * partSize;
    const length = Math.min(partSize, file.size - offset);
    const bytes = Buffer.alloc(length);
    await handle.read(bytes, 0, length, offset);
    const response = await fetch(part.upload_url, { method: part.method, body: bytes });
    if (!response.ok) throw new Error(`Part ${part.part_number} returned HTTP ${response.status}`);
    const etag = response.headers.get("etag");
    if (!etag) throw new Error(`Part ${part.part_number} did not return an ETag`);
    completedParts.push({ part_number: part.part_number, etag });
    console.log(`Uploaded part ${part.part_number}/${partCount}`);
  }
} finally {
  await handle.close();
}

const delivery = await serviceCall<Record<string, unknown>>(
  `/creator-assets/uploads/${encodeURIComponent(upload.upload_id)}/complete`,
  "POST",
  {
    subscriber_count: 125,
    parts: completedParts,
  },
);

console.log(JSON.stringify(delivery, null, 2));
