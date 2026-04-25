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
import { getSession } from "../portal-runner.js";

export function registerPortalDispatcherRoutes(app: Express): void {
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
