/**
 * /portal/dispatch + /portal/keepalive HTTP routes.
 *
 * Exposes the action-code dispatcher and the keepalive heartbeat over
 * HTTP so the FillGST web app (or any caller on the LAN) can drive
 * arbitrary GSTN portal calls through the user's authenticated
 * Playwright context.
 */

import type { Express, Request, Response } from "express";
import { dispatch, type DispatchInput } from "./dispatcher.js";
import { pingKeepalive } from "./keepalive.js";
import { loadApiMap, lookupEndpoint } from "./api-map.js";
import { getSession } from "../portal-runner.js";

export function registerPortalDispatcherRoutes(app: Express): void {
  // ── /portal/api-map: introspect documented endpoints ──────
  app.get("/portal/api-map", async (_req, res) => {
    try {
      const map = await loadApiMap();
      // Stripped echo: don't ship arbitrary text fields back, just the
      // structured catalogue.
      res.json({ ok: true, map });
    } catch (err) {
      res
        .status(500)
        .json({ ok: false, error: err instanceof Error ? err.message : "load failed" });
    }
  });

  app.get("/portal/api-map/:section/:key", async (req, res) => {
    try {
      const { section, key } = req.params;
      const subs: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.query)) {
        if (typeof v === "string") subs[k] = v;
      }
      const ep = await lookupEndpoint(section, key, subs);
      if (!ep) return res.status(404).json({ ok: false, error: "not in api-map" });
      res.json({ ok: true, endpoint: ep });
    } catch (err) {
      res
        .status(500)
        .json({ ok: false, error: err instanceof Error ? err.message : "lookup failed" });
    }
  });

  app.post("/portal/dispatch", async (req: Request, res: Response) => {
    const body = req.body as { gstin?: string } & Partial<DispatchInput>;
    const gstin = body.gstin;
    if (!gstin) {
      return res.status(400).json({ ok: false, error: "gstin is required" });
    }
    if (!body.action || !body.formNo || !body.method) {
      return res
        .status(400)
        .json({ ok: false, error: "action, formNo, and method are required" });
    }
    const session = getSession(gstin);
    if (!session) {
      return res
        .status(409)
        .json({ ok: false, error: "no active session for this gstin; call /portal/login first" });
    }
    const result = await dispatch(session.context, {
      action: body.action,
      formNo: body.formNo,
      period: body.period,
      method: body.method,
      body: body.body,
      urlOverride: body.urlOverride,
      params: body.params,
    });
    return res.status(result.ok ? 200 : 502).json(result);
  });

  app.post("/portal/keepalive", async (req: Request, res: Response) => {
    const { gstin } = req.body as { gstin?: string };
    if (!gstin) {
      return res.status(400).json({ ok: false, error: "gstin is required" });
    }
    const session = getSession(gstin);
    if (!session) {
      return res.status(409).json({ ok: false, error: "no active session" });
    }
    const result = await pingKeepalive(session.context);
    return res.json(result);
  });
}
