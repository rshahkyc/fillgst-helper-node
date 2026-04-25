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

const PORT = Number(process.env.FILLGST_HELPER_PORT ?? "9876");
const VERSION = "0.2.0";

const app = express();

// Allow CORS from cloud FillGST domains + any LAN origin (Local Edition).
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);

      // Cloud Edition
      if (
        origin === "https://fillgst.com" ||
        origin === "https://fillgst.in" ||
        origin === "https://fillgst.ai" ||
        origin === "https://fillgst.vercel.app" ||
        /^https:\/\/[a-z0-9-]+\.fillgst\.(com|in|ai)$/.test(origin) ||
        /^https:\/\/fillgst-[a-z0-9-]+\.vercel\.app$/.test(origin)
      ) {
        return cb(null, true);
      }

      // Local Edition / dev (LAN)
      if (
        origin.startsWith("http://localhost") ||
        origin.startsWith("http://127.0.0.1") ||
        origin.startsWith("http://192.168.") ||
        origin.startsWith("http://10.") ||
        origin.startsWith("http://172.")
      ) {
        return cb(null, true);
      }
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

// Mount portal routes
runPortalServer(app);

// Mount DSC routes
registerDscRoutes(app);

app.listen(PORT, "127.0.0.1", () => {
  console.log(`FillGST Local Helper v${VERSION}`);
  console.log(`Listening on http://localhost:${PORT}`);
  console.log(`Press Ctrl+C to stop.`);
});
