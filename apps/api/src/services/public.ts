// What a draft may reveal on public pages (asset pages, marketplace, token metadata).
// Everything not listed here stays private to the owner and reviewers.
const PUBLIC_FIELDS: Record<string, string[]> = {
  "warehouse-receipt": ["warehouseId", "commodity", "grade", "quantity", "unit", "depositDate", "expiryDate"],
  // Investors need to know who owes the money; the buyer's registration number and the LPO number stay private.
  lpo: ["buyerName", "description", "faceValue", "issueDate", "dueDate"],
  carbon: ["registry", "registryBatchId", "projectId", "projectName", "methodology", "vintage", "quantity", "country"],
  xown: [
    "name",
    "symbol",
    "maxShares",
    "pricePerShare",
    "subscriptionDeadline",
    "equipmentType",
    "description",
    "location",
    "expectedAnnualYieldPct",
  ],
  warehouse: ["name", "state", "capacityTonnes", "commodities"],
};

export function publicFields(assetType: string, fields: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!fields) return {};
  const allowed = PUBLIC_FIELDS[assetType] ?? [];
  const out: Record<string, unknown> = {};
  for (const k of allowed) if (k in fields) out[k] = fields[k];
  return out;
}
