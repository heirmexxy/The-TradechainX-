// Bootstrap: give a signed-up account admin access in the app (the UI gate).
//   pnpm --filter @tradechainx/api admin:grant <email> <role> [<role> …]
//   e.g. admin:grant emeka@kitovu.com.ng super_admin
// Roles: super_admin kyc_reviewer listing_reviewer warehouse_registrar asset_manager pauser
//
// This only changes what the person can SEE and prepare in the admin area. What they can DO is
// decided on-chain: the deploy script grants the matching contract roles, and Super Admin power sits
// with the Safe. Run it once for the first Super Admin; after that use Admin → People & roles.
import { eq } from "drizzle-orm";
import { ADMIN_ROLES, type AdminRole } from "@tradechainx/shared";
import { db, pool, schema } from "../db/client.ts";

const [email, ...roles] = process.argv.slice(2);
if (!email || roles.length === 0) {
  console.error("usage: admin:grant <email> <role> [<role> …]");
  process.exit(1);
}
const bad = roles.filter((r) => !ADMIN_ROLES.includes(r as AdminRole));
if (bad.length) {
  console.error(`Unknown role(s): ${bad.join(", ")}. Valid: ${ADMIN_ROLES.join(", ")}`);
  process.exit(1);
}
const [user] = await db.select().from(schema.users).where(eq(schema.users.email, email.toLowerCase())).limit(1);
if (!user) {
  console.error(`No account for ${email}. Ask them to sign in to the site once, then run this again.`);
  process.exit(1);
}
const next = [...new Set([...user.adminRoles, ...roles])];
await db.update(schema.users).set({ adminRoles: next, updatedAt: new Date() }).where(eq(schema.users.id, user.id));
console.log(`${email} now has: ${next.join(", ")}${user.walletAddress ? ` (wallet ${user.walletAddress})` : " (no wallet yet — they must sign in once)"}`);
await pool.end();
