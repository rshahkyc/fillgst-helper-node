/**
 * GSTN portal API map loader.
 *
 * Sources its data from `data/gst-api-map.json` — a config-driven
 * catalogue of every documented portal endpoint (auth + navigation +
 * returns dashboard + GSTR-1/2A/2B/3B + IMS + e-invoice). When GSTN
 * changes a URL, edit the JSON and bump the helper without touching
 * dispatcher code.
 *
 * The map originates from a 2026-04 capture session and is the
 * canonical reference for every endpoint we know about. To extend
 * coverage (GSTR-9, e-waybill, etc.), add entries under the matching
 * top-level key.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface ApiEndpoint {
  url: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  notes?: string;
}

interface ApiMap {
  version?: string;
  captured_on?: string;
  base_domains?: Record<string, string>;
  auth?: Record<string, ApiEndpoint>;
  navigation?: Record<string, ApiEndpoint>;
  returns_dashboard_apis?: Record<string, ApiEndpoint>;
  gstr1?: Record<string, ApiEndpoint | Record<string, ApiEndpoint>>;
  gstr2a?: Record<string, ApiEndpoint>;
  gstr2b?: Record<string, ApiEndpoint>;
  gstr3b?: Record<string, ApiEndpoint | Record<string, ApiEndpoint>>;
  ims?: Record<string, ApiEndpoint | Record<string, ApiEndpoint>>;
  [key: string]: unknown;
}

let cached: ApiMap | null = null;

function repoRoot(): string {
  // src/portal/api-map.ts → ../../data/gst-api-map.json
  const here = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(here), "..", "..");
}

export async function loadApiMap(): Promise<ApiMap> {
  if (cached) return cached;
  const file = path.join(repoRoot(), "data", "gst-api-map.json");
  const text = await fs.readFile(file, "utf-8");
  cached = JSON.parse(text) as ApiMap;
  return cached;
}

/**
 * Look up an endpoint by section + key, with substitution of standard
 * placeholders ({gstin}, {period}, {random}).
 */
export async function lookupEndpoint(
  section: keyof ApiMap,
  key: string,
  substitutions: Record<string, string> = {},
): Promise<ApiEndpoint | null> {
  const map = await loadApiMap();
  const sec = map[section] as Record<string, ApiEndpoint | Record<string, ApiEndpoint>> | undefined;
  if (!sec) return null;
  const node = sec[key];
  if (!node || typeof node !== "object") return null;
  const ep = "url" in node ? (node as ApiEndpoint) : null;
  if (!ep) return null;
  const url = applySubstitutions(ep.url, substitutions);
  return { url, method: ep.method, notes: ep.notes };
}

function applySubstitutions(template: string, subs: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, name) => {
    if (name === "random") return String(Math.random());
    return subs[name] ?? `{${name}}`;
  });
}

export type { ApiEndpoint, ApiMap };
