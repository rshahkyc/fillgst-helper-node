/**
 * Session keepalive.
 *
 * GSTN idle-timeouts a session after roughly 15 minutes of inactivity.
 * CompuGST's pattern (per docs/compugst-knowledge.md §2): hit
 * /returns/auth/api/keepalive and /services/auth/api/keepalive every
 * ~5 minutes while the user has an active session.
 *
 * The helper exposes this as a manual /portal/keepalive endpoint and
 * also schedules an internal interval per logged-in GSTIN.
 */

import type { BrowserContext } from "playwright-core";

const KEEPALIVE_PATHS = [
  "https://return.gst.gov.in/returns/auth/api/keepalive",
  "https://services.gst.gov.in/services/auth/api/keepalive",
];

const REFERER = "https://return.gst.gov.in/returns/auth/dashboard";

export async function pingKeepalive(context: BrowserContext): Promise<{ ok: boolean; statuses: number[] }> {
  const statuses: number[] = [];
  for (const url of KEEPALIVE_PATHS) {
    try {
      const resp = await context.request.get(url, { headers: { Referer: REFERER } });
      statuses.push(resp.status());
    } catch {
      statuses.push(0);
    }
  }
  return { ok: statuses.every((s) => s >= 200 && s < 400), statuses };
}

/**
 * Lightweight scheduler — wakes every `intervalMs` and pings keepalive
 * for the supplied context. Returns a stop() cancel function.
 */
export function startKeepaliveLoop(
  context: BrowserContext,
  options: {
    intervalMs?: number;
    onError?: (err: unknown) => void;
  } = {},
): () => void {
  const intervalMs = options.intervalMs ?? 4 * 60 * 1000; // 4 min — leaves slack vs the 5-min recommendation
  const handle = setInterval(() => {
    pingKeepalive(context).catch((err) => options.onError?.(err));
  }, intervalMs);
  return () => clearInterval(handle);
}
