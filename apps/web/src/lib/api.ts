export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** JSON request to the TradeChainX API with the session cookie and CSRF header. */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    credentials: "include",
    headers: {
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      "X-TradeChainX": "1",
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(res.status, data.error ?? "error", data.message ?? "Something went wrong.");
  return data as T;
}

/** Upload one document (multipart). */
export async function uploadDocument(file: File, kind: string) {
  const form = new FormData();
  form.append("kind", kind);
  form.append("file", file);
  const res = await fetch(`${API_URL}/documents`, {
    method: "POST",
    credentials: "include",
    headers: { "X-TradeChainX": "1" },
    body: form,
  });
  const data = await res.json();
  if (!res.ok) throw new ApiError(res.status, data.error ?? "error", data.message ?? "Upload failed.");
  return data.document as UploadedDocument;
}

export type UploadedDocument = { id: string; kind: string; filename: string; mime: string; sizeBytes: number; sha256: string };

export const documentUrl = (id: string) => `${API_URL}/documents/${id}`;
