import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { env } from "../env.ts";

export interface Storage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
}

/** Development only: files on local disk. */
class LocalStorage implements Storage {
  private root = resolve(env.STORAGE_DIR);
  private path(key: string) {
    if (!/^[a-zA-Z0-9/_.-]+$/.test(key) || key.includes("..")) throw new Error("Invalid storage key");
    return join(this.root, key);
  }
  async put(key: string, body: Buffer) {
    const p = this.path(key);
    await mkdir(join(p, ".."), { recursive: true });
    await writeFile(p, body);
  }
  async get(key: string) {
    return readFile(this.path(key));
  }
}

/** Private bucket with server-side encryption. Files are only ever served through the API. */
class S3Storage implements Storage {
  // Works with AWS S3 and S3-compatible stores (Cloudflare R2, Backblaze B2, MinIO) via S3_ENDPOINT.
  private client = new S3Client({
    region: env.S3_REGION,
    ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT, forcePathStyle: true } : {}),
    ...(env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
      ? { credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY } }
      : {}),
  });
  async put(key: string, body: Buffer, contentType: string) {
    await this.client.send(
      new PutObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: key,
        Body: body,
        ContentType: contentType,
        // AWS needs this explicitly; R2/B2 encrypt at rest automatically and may reject the header.
        ...(env.S3_ENDPOINT ? {} : { ServerSideEncryption: "AES256" as const }),
      }),
    );
  }
  async get(key: string) {
    const out = await this.client.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
    const bytes = await out.Body!.transformToByteArray();
    return Buffer.from(bytes);
  }
}

export const storage: Storage = env.STORAGE_PROVIDER === "s3" ? new S3Storage() : new LocalStorage();

/** Health check: write and read back a tiny object. */
export async function storageRoundTrip(): Promise<void> {
  const key = "health/ping.txt";
  const body = Buffer.from(String(Date.now()));
  await storage.put(key, body, "text/plain");
  const back = await storage.get(key);
  if (!back.equals(body)) throw new Error("Storage read-back mismatch");
}
