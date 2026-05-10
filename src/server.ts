/**
 * FillGST Local Helper — Express HTTP server running on each user's PC.
 *
 * Listens on http://localhost:9876
 * The FillGST web app (cloud or LAN) is opened in the user's browser.
 * From the user's browser, the web app calls http://localhost:9876
 * directly — which means each user's portal session + DSC signing run
 * LOCALLY on their PC.
 *
 * Key endpoints:
 *   GET  /health              → { ok: true, version }
 *   POST /portal/login        → start login flow (opens visible Chromium)
 *   POST /portal/captcha      → submit captcha
 *   POST /portal/otp          → submit OTP
 *   POST /portal/fetch2b      → fetch GSTR-2B JSON for a period
 *   POST /portal/disconnect   → close browser and clear state
 *   GET  /dsc/providers       → list configured PKCS#11 driver paths
 *   POST /dsc/providers       → save provider list
 *   POST /dsc/certificates    → enumerate certs on a token
 *   POST /dsc/login           → unlock token with PIN
 *   POST /dsc/sign            → return PKCS#7 SignedData over a payload
 *   POST /dsc/hash            → SHA-256 of payload (EVC fallback)
 */

import express from "express";
import cors from "cors";
import { runPortalServer } from "./portal-runner.js";
import { registerDscRoutes } from "./dsc/router.js";
import { registerPortalDispatcherRoutes } from "./portal/router.js";

const PORT = Number(process.env.FILLGST_HELPER_PORT ?? "9876");
const VERSION = "0.4.0";

const app = express();

// Single-source-of-truth allowlist used by both the CORS check and the
// Private Network Access (PNA) header echo below.
function isAllowedOrigin(origin: string): boolean {
  return (
    origin === "https://fillgst.com" ||
    origin === "https://fillgst.in" ||
    origin === "https://fillgst.ai" ||
    origin === "https://fillgst.vercel.app" ||
    /^https:\/\/[a-z0-9-]+\.fillgst\.(com|in|ai)$/.test(origin) ||
    /^https:\/\/fillgst-[a-z0-9-]+\.vercel\.app$/.test(origin) ||
    origin.startsWith("http://localhost") ||
    origin.startsWith("http://127.0.0.1") ||
    origin.startsWith("http://192.168.") ||
    origin.startsWith("http://10.") ||
    origin.startsWith("http://172.")
  );
}

// 2026-05-10: Chrome Private Network Access (PNA) preflight support.
//
// When fillgst.com (HTTPS, public) makes a request to localhost:9876
// (HTTP, loopback) Chrome considers that a "private network access".
// Since Chrome 130+ the browser sends an extra preflight header
// `Access-Control-Request-Private-Network: true` and refuses the call
// unless the server responds with `Access-Control-Allow-Private-Network:
// true`. The default `cors` middleware doesn't echo this header, so we
// add it here. MUST run before cors() so the header is set on the same
// response cors() ends for OPTIONS preflight.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Private-Network", "true");
  }
  next();
});

// Allow CORS from cloud FillGST domains + any LAN origin (Local Edition).
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (isAllowedOrigin(origin)) return cb(null, true);
      return cb(new Error("Origin not allowed: " + origin));
    },
    credentials: false,
  }),
);
app.use(express.json({ limit: "1mb" }));

// Health check + version (used by web app to detect helper)
app.get("/health", (_req, res) => {
  res.json({ ok: true, version: VERSION, name: "FillGST Local Helper" });
});

// Mount portal routes (login / captcha / OTP / fetch2b / disconnect)
runPortalServer(app);

// Mount the action-code dispatcher (covers every other GSTN call)
// + keepalive heartbeat
registerPortalDispatcherRoutes(app);

// Mount DSC routes
registerDscRoutes(app);

app.listen(PORT, "127.0.0.1", () => {
  console.log(`FillGST Local Helper v${VERSION}`);
  console.log(`Listening on http://localhost:${PORT}`);
  console.log(`Press Ctrl+C to stop.`);
});
