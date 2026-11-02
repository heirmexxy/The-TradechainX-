import type { MetadataRoute } from "next";
import { SEGMENTS } from "@/content/segments";

const SITE = "https://tradechainx.com";

export default function sitemap(): MetadataRoute.Sitemap {
  const pages = ["", "/marketplace", "/xown", "/how-it-works", "/security", ...SEGMENTS.map((s) => `/for/${s.slug}`)];
  return pages.map((p) => ({ url: `${SITE}${p}`, changeFrequency: p === "/marketplace" ? "daily" : "monthly", priority: p === "" ? 1 : 0.7 }));
}
