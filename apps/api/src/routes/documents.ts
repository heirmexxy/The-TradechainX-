import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { storage } from "../lib/storage.ts";
import { badRequest, notFound, forbidden } from "../lib/errors.ts";
import { requireUser } from "../plugins/auth.ts";

const ALLOWED = new Map([
  ["application/pdf", "pdf"],
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
]);
const MAX_BYTES = 15 * 1024 * 1024;

// PDFs and images are checked by magic bytes, not just the declared type.
function sniff(buf: Buffer): string | null {
  if (buf.subarray(0, 5).toString() === "%PDF-") return "application/pdf";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  return null;
}

export async function documentRoutes(app: FastifyInstance) {
  /** Upload one supporting document. Returns its id and SHA-256 (the value anchored on-chain). */
  app.post("/documents", async (req) => {
    const user = requireUser(req);
    return { document: publicDoc(await saveUploadedDocument(req, user.id)) };
  });

  app.get("/documents/:id", async (req, reply) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const [doc] = await db.select().from(schema.documents).where(eq(schema.documents.id, id)).limit(1);
    if (!doc) throw notFound();
    const isReviewer = user.adminRoles.some((r) =>
      ["kyc_reviewer", "listing_reviewer", "warehouse_registrar", "asset_manager", "super_admin"].includes(r),
    );
    if (doc.ownerUserId !== user.id && !isReviewer) throw forbidden();

    const body = await storage.get(doc.storageKey);
    reply
      .header("Content-Type", doc.mime)
      .header("Content-Disposition", `inline; filename="${doc.filename.replace(/[^\w.-]/g, "_")}"`)
      .header("Cache-Control", "private, no-store")
      .header("X-Content-Type-Options", "nosniff");
    return reply.send(body);
  });
}

/** Read one multipart file from the request, check it, store it and record it. Used by the app and the partner API. */
export async function saveUploadedDocument(req: FastifyRequest, ownerUserId: string) {
  const file = await req.file({ limits: { fileSize: MAX_BYTES, files: 1 } });
  if (!file) throw badRequest("Attach a file.");
  const kindField = file.fields["kind"];
  const kind =
    kindField && !Array.isArray(kindField) && "value" in kindField ? String(kindField.value).slice(0, 64) : "other";

  const buf = await file.toBuffer();
  if (file.file.truncated) throw badRequest("Files must be 15 MB or smaller.");
  const mime = sniff(buf);
  if (!mime || !ALLOWED.has(mime)) throw badRequest("Upload a PDF, JPG or PNG.");

  const sha256 = `0x${createHash("sha256").update(buf).digest("hex")}`;
  const id = randomUUID();
  const storageKey = `documents/${ownerUserId}/${id}.${ALLOWED.get(mime)}`;
  await storage.put(storageKey, buf, mime);

  const [doc] = await db
    .insert(schema.documents)
    .values({ id, ownerUserId, kind, filename: file.filename.slice(0, 200), mime, sizeBytes: buf.length, sha256, storageKey })
    .returning();
  return doc!;
}

export function publicDoc(d: typeof schema.documents.$inferSelect) {
  return { id: d.id, kind: d.kind, filename: d.filename, mime: d.mime, sizeBytes: d.sizeBytes, sha256: d.sha256, createdAt: d.createdAt };
}

/** Loads documents and checks they all belong to `ownerId`. */
export async function ownedDocuments(ownerId: string, ids: string[]) {
  if (ids.length === 0) return [];
  const docs = await db
    .select()
    .from(schema.documents)
    .where(and(inArray(schema.documents.id, ids), eq(schema.documents.ownerUserId, ownerId)));
  if (docs.length !== new Set(ids).size) throw badRequest("One or more documents weren't found.");
  return docs;
}
