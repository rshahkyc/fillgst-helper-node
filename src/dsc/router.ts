import type { Express, Request, Response } from "express";
import {
  listProviders,
  saveProviders,
  listCertificates,
  login,
  sign,
  sha256OfBase64,
} from "./pkcs11.js";
import type {
  DscErrorResponse,
  DscLoginRequest,
  DscProvider,
  DscSignRequest,
} from "./types.js";

/**
 * DSC HTTP routes mounted under /dsc. Every endpoint returns either
 *   { ok: true, ... data } or { ok: false, error, code? }.
 */
export function registerDscRoutes(app: Express): void {
  // ── Providers ─────────────────────────────────────────────

  app.get("/dsc/providers", async (_req, res) => {
    try {
      const providers = await listProviders();
      res.json({ ok: true, providers });
    } catch (err) {
      res.status(500).json(asError(err));
    }
  });

  app.post("/dsc/providers", async (req: Request, res: Response) => {
    try {
      const providers = req.body as DscProvider[];
      if (!Array.isArray(providers)) {
        return res.status(400).json({ ok: false, error: "expected array of providers" });
      }
      for (const p of providers) {
        if (!p.id || !p.name || !p.driverPath) {
          return res
            .status(400)
            .json({ ok: false, error: "each provider needs id, name, driverPath" });
        }
      }
      await saveProviders(providers);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json(asError(err));
    }
  });

  // ── Certificate enumeration + login + sign ────────────────

  app.post("/dsc/certificates", async (req: Request, res: Response) => {
    const { providerId } = req.body as { providerId?: string };
    if (!providerId) {
      return res.status(400).json({ ok: false, error: "providerId required" });
    }
    try {
      const certs = await listCertificates(providerId);
      res.json({ ok: true, certificates: certs });
    } catch (err) {
      res.status(501).json(asError(err));
    }
  });

  app.post("/dsc/login", async (req: Request, res: Response) => {
    const body = req.body as Partial<DscLoginRequest>;
    if (!body.providerId || typeof body.slot !== "number" || !body.pin) {
      return res
        .status(400)
        .json({ ok: false, error: "providerId, slot (number), and pin required" });
    }
    try {
      await login(body as DscLoginRequest);
      res.json({ ok: true });
    } catch (err) {
      res.status(501).json(asError(err));
    }
  });

  app.post("/dsc/sign", async (req: Request, res: Response) => {
    const body = req.body as Partial<DscSignRequest>;
    if (!body.providerId || typeof body.slot !== "number" || !body.payloadBase64) {
      return res
        .status(400)
        .json({ ok: false, error: "providerId, slot, and payloadBase64 required" });
    }
    try {
      const result = await sign(body as DscSignRequest);
      res.json({ ok: true, result });
    } catch (err) {
      res.status(501).json(asError(err));
    }
  });

  // EVC (OTP-based) fallback. Helper just hashes the payload; the web
  // app collects the OTP from the user and submits to GSTN itself.
  app.post("/dsc/hash", (req: Request, res: Response) => {
    const { payloadBase64 } = req.body as { payloadBase64?: string };
    if (!payloadBase64) {
      return res.status(400).json({ ok: false, error: "payloadBase64 required" });
    }
    res.json({
      ok: true,
      sha256: sha256OfBase64(payloadBase64),
      hashedAt: new Date().toISOString(),
    });
  });
}

function asError(err: unknown): DscErrorResponse {
  if (err && typeof err === "object" && "code" in err) {
    const e = err as { code?: DscErrorResponse["code"]; message?: string };
    return { ok: false, error: e.message ?? "unknown error", code: e.code };
  }
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}
