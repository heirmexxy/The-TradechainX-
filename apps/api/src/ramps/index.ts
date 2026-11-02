import { env } from "../env.ts";
import type { RampProvider } from "./types.ts";
import { OmsRamp } from "./oms.ts";
import { PartnerRamp } from "./partner.ts";

let cached: RampProvider | null | undefined;

/** The configured ramp, or null when RAMP_PROVIDER=none. Built lazily so a bad config doesn't stop the API. */
export function ramp(): RampProvider | null {
  if (cached !== undefined) return cached;
  cached = env.RAMP_PROVIDER === "oms" ? new OmsRamp() : env.RAMP_PROVIDER === "partner" ? new PartnerRamp() : null;
  return cached;
}

export type { RampProvider } from "./types.ts";
