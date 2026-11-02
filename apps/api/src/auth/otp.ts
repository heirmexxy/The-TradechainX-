import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { db, schema } from "../db/client.ts";
import { env } from "../env.ts";

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_CODES_PER_HOUR = 5;

const hashCode = (email: string, code: string) =>
  createHash("sha256").update(`${env.OTP_PEPPER}:${email}:${code}`).digest("hex");

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Issues a 6-digit code. Returns null when the email has asked for too many codes this hour. */
export async function issueCode(email: string): Promise<string | null> {
  const recent = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.loginCodes)
    .where(and(eq(schema.loginCodes.email, email), gt(schema.loginCodes.createdAt, new Date(Date.now() - 3600_000))));
  if ((recent[0]?.n ?? 0) >= MAX_CODES_PER_HOUR) return null;

  const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
  await db.insert(schema.loginCodes).values({
    email,
    codeHash: hashCode(email, code),
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  });
  return code;
}

/** Checks the most recent unused code. Each wrong guess counts; the code dies after MAX_ATTEMPTS. */
export async function consumeCode(email: string, code: string): Promise<boolean> {
  const [row] = await db
    .select()
    .from(schema.loginCodes)
    .where(and(eq(schema.loginCodes.email, email), isNull(schema.loginCodes.consumedAt)))
    .orderBy(desc(schema.loginCodes.createdAt))
    .limit(1);
  if (!row || row.expiresAt < new Date() || row.attempts >= MAX_ATTEMPTS) return false;

  const expected = Buffer.from(row.codeHash, "hex");
  const actual = Buffer.from(hashCode(email, code.trim()), "hex");
  const ok = expected.length === actual.length && timingSafeEqual(expected, actual);

  await db
    .update(schema.loginCodes)
    .set(ok ? { consumedAt: new Date() } : { attempts: row.attempts + 1 })
    .where(eq(schema.loginCodes.id, row.id));
  return ok;
}
