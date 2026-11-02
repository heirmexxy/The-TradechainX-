// DEVELOPMENT ONLY. Seeds a local chain + database with demo accounts for every role so the whole
// platform can be clicked through. Run after `pnpm contracts:deploy:local` and `pnpm db:migrate`.
//
// Dev wallets are derived from DEV_WALLET_SEED + email — the same rule the web app's dev wallet uses —
// so signing in as a demo account in the browser gives you the wallet the seed set up.
import { createTestClient, createWalletClient, http, keccak256, toBytes, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { eq } from "drizzle-orm";
import { Tier, ONCHAIN_ROLE_NAME } from "@tradechainx/shared";
import { env } from "../env.ts";
import { db, schema, pool } from "../db/client.ts";
import { chain, contracts, publicClient, usdc } from "../chain.ts";
import { migrate } from "../db/migrate.ts";
import { recordRef, referenceHash } from "../lib/hash.ts";
import { metadataUri } from "../services/drafts.ts";
import { randomUUID } from "node:crypto";

if (env.NODE_ENV === "production" || !env.DEV_TOOLS || !env.DEV_WALLET_SEED) {
  throw new Error("Seeding is for development only (needs DEV_TOOLS=true and DEV_WALLET_SEED).");
}

// anvil account 0: deployer and initial Super Admin in deploy-local.sh. Public dev key.
const ANVIL_DEPLOYER = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;

export const devKeyFor = (email: string) => keccak256(toBytes(`${env.DEV_WALLET_SEED}:${email.toLowerCase()}`));

type Demo = {
  email: string;
  userType?: "trader" | "warehouse" | "sme" | "originator" | "investor" | "lender";
  tier?: number;
  name: string;
  org?: string;
  adminRoles?: string[];
};

const DEMO: Demo[] = [
  { email: "superadmin@tradechainx.local", name: "Super Admin", adminRoles: ["super_admin"] },
  { email: "reviewer@tradechainx.local", name: "Ada Reviewer", adminRoles: ["kyc_reviewer", "listing_reviewer", "pauser"] },
  { email: "ops@tradechainx.local", name: "Tunde Ops", adminRoles: ["warehouse_registrar", "asset_manager"] },
  { email: "warehouse@tradechainx.local", userType: "warehouse", tier: Tier.Business, name: "Iseyin Central Warehouse", org: "Iseyin Central Warehouse Ltd" },
  { email: "trader@tradechainx.local", userType: "trader", tier: Tier.Individual, name: "Bola Trader" },
  { email: "sme@tradechainx.local", userType: "sme", tier: Tier.Business, name: "Oyo Agro Supplies", org: "Oyo Agro Supplies Ltd" },
  { email: "originator@tradechainx.local", userType: "originator", tier: Tier.Business, name: "Green Savannah Carbon", org: "Green Savannah Carbon Ltd" },
  { email: "investor@tradechainx.local", userType: "investor", tier: Tier.Individual, name: "Chioma Investor" },
  { email: "lender@tradechainx.local", userType: "lender", tier: Tier.Institutional, name: "Demo MFB", org: "Demo Microfinance Bank" },
  { email: "spv@tradechainx.local", userType: "sme", tier: Tier.Business, name: "Iseyin Tractor SPV", org: "Iseyin Tractor SPV Ltd" },
];

const wallet = (key: Hex) => createWalletClient({ account: privateKeyToAccount(key), chain, transport: http(env.RPC_URL) });
const wait = (hash: Hex) => publicClient.waitForTransactionReceipt({ hash });

async function main() {
  await migrate(env.DATABASE_URL, () => {});
  const deployer = wallet(ANVIL_DEPLOYER);
  const addr: Record<string, Address> = {};
  for (const d of DEMO) addr[d.email] = privateKeyToAccount(devKeyFor(d.email)).address;

  // 1. Gas + mock USDC for everyone.
  for (const d of DEMO) {
    await wait(await deployer.sendTransaction({ to: addr[d.email]!, value: parseEther("10") }));
    await wait(await deployer.writeContract({ ...usdc, functionName: "mint", args: [addr[d.email]!, 500_000n * 1_000_000n] }));
  }

  // 2. On-chain roles, granted by the deployer (still Super Admin locally).
  const grants: [keyof typeof contracts, keyof typeof ONCHAIN_ROLE_NAME, string][] = [
    ["identityRegistry", "kyc_reviewer", "reviewer@tradechainx.local"],
    ["warehouseReceipt", "listing_reviewer", "reviewer@tradechainx.local"],
    ["lpoToken", "listing_reviewer", "reviewer@tradechainx.local"],
    ["carbonCredits", "listing_reviewer", "reviewer@tradechainx.local"],
    ["xownFactory", "listing_reviewer", "reviewer@tradechainx.local"],
    ["warehouseReceipt", "pauser", "reviewer@tradechainx.local"],
    ["lpoToken", "pauser", "reviewer@tradechainx.local"],
    ["carbonCredits", "pauser", "reviewer@tradechainx.local"],
    ["marketplace", "pauser", "reviewer@tradechainx.local"],
    ["xownFactory", "pauser", "reviewer@tradechainx.local"],
    ["warehouseRegistry", "warehouse_registrar", "ops@tradechainx.local"],
    ["xownFactory", "asset_manager", "ops@tradechainx.local"],
  ];
  for (const [c, role, email] of grants) {
    const roleId = keccak256(toBytes(ONCHAIN_ROLE_NAME[role]));
    await wait(
      await deployer.writeContract({
        address: contracts[c].address,
        abi: contracts[c].abi,
        functionName: "grantRole",
        args: [roleId, addr[email]!],
      } as never),
    );
  }

  // 3. Users in the database, KYC recorded on-chain by the demo reviewer.
  const reviewer = wallet(devKeyFor("reviewer@tradechainx.local"));
  const validUntil = BigInt(Math.floor(Date.now() / 1000) + 365 * 86_400);
  const ids: Record<string, string> = {};
  for (const d of DEMO) {
    const address = addr[d.email]!.toLowerCase();
    const values = {
      email: d.email,
      userType: d.userType ?? null,
      displayName: d.name,
      orgName: d.org ?? null,
      walletAddress: address,
      adminRoles: d.adminRoles ?? [],
    };
    const [u] = await db.insert(schema.users).values(values).onConflictDoUpdate({ target: schema.users.email, set: values }).returning();
    ids[d.email] = u!.id;

    if (d.tier) {
      const caseId = randomUUID();
      const ref = recordRef("kyc", caseId);
      const existing = await db.select().from(schema.kycCases).where(eq(schema.kycCases.userId, u!.id)).limit(1);
      if (existing.length === 0) {
        await db.insert(schema.kycCases).values({
          id: caseId,
          userId: u!.id,
          track: d.tier === Tier.Individual ? "individual" : "business",
          status: "approved",
          details: { seeded: true, name: d.name },
          recordRef: ref,
          approvedTier: d.tier,
          approvedValidUntil: Number(validUntil),
        });
        await wait(
          await reviewer.writeContract({
            ...contracts.identityRegistry,
            functionName: "setIdentity",
            args: [addr[d.email]!, d.tier, validUntil, ref],
          }),
        );
      }
    }
  }

  // 4. A registered warehouse, by the demo registrar.
  const ops = wallet(devKeyFor("ops@tradechainx.local"));
  const licence = "OYO/WR/2026/001";
  const licenceRef = referenceHash(licence);
  const draftId = randomUUID();
  await db.insert(schema.drafts).values({
    id: draftId,
    assetType: "warehouse",
    ownerUserId: ids["ops@tradechainx.local"]!,
    fields: {
      operatorEmail: "warehouse@tradechainx.local",
      name: "Iseyin Central Warehouse",
      licenceNumber: licence,
      address: "Km 3 Iseyin–Oyo Road, Iseyin",
      state: "Oyo",
      capacityTonnes: 5000,
      commodities: ["MAIZE", "SOYBEAN", "SORGHUM"],
    },
    terms: { operator: addr["warehouse@tradechainx.local"]!.toLowerCase(), licenceRef, metadataURI: metadataUri(draftId) },
    keyHash: licenceRef,
  });
  const licenceUsed = await publicClient.readContract({ ...contracts.warehouseRegistry, functionName: "licenceRegistered", args: [licenceRef] });
  if (!licenceUsed) {
    await wait(
      await ops.writeContract({
        ...contracts.warehouseRegistry,
        functionName: "registerWarehouse",
        args: [addr["warehouse@tradechainx.local"]!, licenceRef, metadataUri(draftId)],
      }),
    );
  }

  // 5. Hand Super Admin (DEFAULT_ADMIN_ROLE) to the demo super admin via the contracts' 2-step transfer,
  //    so role management and unpausing work from the admin console. Local chain only.
  const superAdmin = addr["superadmin@tradechainx.local"]!;
  const adminContracts = [
    contracts.identityRegistry,
    contracts.warehouseRegistry,
    contracts.warehouseReceipt,
    contracts.lpoToken,
    contracts.carbonCredits,
    contracts.marketplace,
    contracts.xownFactory,
  ];
  const currentAdmin = await publicClient.readContract({ ...contracts.marketplace, functionName: "defaultAdmin" });
  if (currentAdmin.toLowerCase() !== superAdmin.toLowerCase()) {
    for (const c of adminContracts) {
      await wait(await deployer.writeContract({ address: c.address, abi: c.abi, functionName: "beginDefaultAdminTransfer", args: [superAdmin] } as never));
    }
    const test = createTestClient({ mode: "anvil", chain, transport: http(env.RPC_URL) });
    await test.increaseTime({ seconds: 5 });
    await test.mine({ blocks: 1 });
    const sa = wallet(devKeyFor("superadmin@tradechainx.local"));
    for (const c of adminContracts) {
      await wait(await sa.writeContract({ address: c.address, abi: c.abi, functionName: "acceptDefaultAdminTransfer", args: [] } as never));
    }
  }

  console.log("\nSeeded. Sign in at the web app with any of these (the dev code shows on screen):");
  for (const d of DEMO) console.log(`  ${d.email.padEnd(32)} ${d.adminRoles?.join(", ") ?? d.userType}`);
  console.log("\nThe indexer picks up the on-chain changes within a few seconds.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
