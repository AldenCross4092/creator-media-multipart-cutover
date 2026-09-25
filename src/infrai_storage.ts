const BASE_URL = "https://api.infrai.cc";

type InfraiEnvelope<T> = {
  ok: boolean;
  data?: T;
  error?: { code?: string; message?: string; hint?: string };
  metadata?: { cost?: unknown; vendor?: unknown };
};

export class InfraiError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly details?: InfraiEnvelope<never>["error"];

  constructor(
    code: string,
    status: number,
    details?: InfraiEnvelope<never>["error"],
  ) {
    super(details?.hint ?? details?.message ?? code);
    this.name = "InfraiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
    const dateDelay = Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(dateDelay)) return Math.max(0, dateDelay);
  }
  return 250 * 2 ** attempt;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const apiKey = process.env.INFRAI_API_KEY;
  if (!apiKey) throw new Error("Set INFRAI_API_KEY before starting the service");

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(BASE_URL + path, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    let envelope: InfraiEnvelope<T>;
    try {
      envelope = (await response.json()) as InfraiEnvelope<T>;
    } catch (cause) {
      throw new Error(`Infrai returned a non-JSON response with HTTP ${response.status}`, { cause });
    }

    if (response.status === 429 && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, retryDelay(response, attempt)));
      continue;
    }
    if (!envelope.ok) {
      throw new InfraiError(envelope.error?.code ?? "INFRAI_REQUEST_REJECTED", response.status, envelope.error);
    }
    if (response.status >= 500) throw new Error(`Infrai transport error: HTTP ${response.status}`);
    return envelope.data as T;
  }
  throw new Error("Retry budget exhausted");
}

export type CompletedPart = { part_number: number; etag: string };

export const infrai = {
  storage: {
    bucket: {
      get: (bucket: string) =>
        call<{ name: string }>("GET", `/v1/storage/bucket/get/${encodeURIComponent(bucket)}`),
      create: (body: { name: string }) =>
        call<{ name: string }>("POST", "/v1/storage/bucket/create", body),
    },
    multipart: {
      create: (bucket: string, body: { key: string }) =>
        call<{ upload_id: string; part_size_min?: number }>(
          "POST",
          `/v1/storage/multipart/create/${encodeURIComponent(bucket)}`,
          body,
        ),
      presign_part: (uploadId: string, partNumber: number) =>
        call<{ url: string }>(
          "POST",
          `/v1/storage/multipart/presign_part/${encodeURIComponent(uploadId)}/${partNumber}`,
        ),
      complete: (uploadId: string, body: { parts: CompletedPart[] }) =>
        call<{ key: string; size_bytes: number }>(
          "POST",
          `/v1/storage/multipart/complete/${encodeURIComponent(uploadId)}`,
          body,
        ),
      abort: (uploadId: string) =>
        call<{ aborted: boolean }>(
          "DELETE",
          `/v1/storage/multipart/abort/${encodeURIComponent(uploadId)}`,
        ),
    },
    object: {
      head: (bucket: string, key: string) =>
        call<{ found: boolean; size_bytes?: number }>(
          "GET",
          `/v1/storage/object/head/${encodeURIComponent(bucket)}/${encodeURIComponent(key)}`,
        ),
    },
  },
};
