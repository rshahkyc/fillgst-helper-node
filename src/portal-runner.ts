/**
 * Portal runner — wraps Playwright with the same login/2B logic as
 * FillGSTV1's session-manager.ts, but runs on the user's PC.
 *
 * Cookies are stored encrypted in ~/.fillgst-helper/cookies-{gstin}.enc
 * so subsequent fetches skip captcha + OTP for ~30 days.
 */

import type { Express } from "express";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
} from "playwright-core";
import CryptoJS from "crypto-js";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

// Prefer user's installed Chrome; fall back to Edge (ships with Windows 11).
// Never falls through to Playwright's bundled Chromium — we don't ship it.
async function launchUserBrowser(opts: { headless: boolean }): Promise<Browser> {
  try {
    return await chromium.launch({ ...opts, channel: "chrome" });
  } catch {
    return await chromium.launch({ ...opts, channel: "msedge" });
  }
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const ENC_KEY = process.env.FILLGST_HELPER_KEY ?? "fillgst-local-key-min16!!";

const COOKIE_DIR = path.join(os.homedir(), ".fillgst-helper");

// Per-GSTIN session map (one user PC may handle multiple clients)
interface Session {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  gstin: string;
}
const sessions = new Map<string, Session>();

// ── Cookie persistence ─────────────────────────────────────

async function ensureCookieDir() {
  await fs.mkdir(COOKIE_DIR, { recursive: true });
}

function cookieFile(gstin: string): string {
  return path.join(COOKIE_DIR, `cookies-${gstin}.enc`);
}

async function loadCookies(gstin: string): Promise<unknown[] | null> {
  try {
    const enc = await fs.readFile(cookieFile(gstin), "utf-8");
    const bytes = CryptoJS.AES.decrypt(enc, ENC_KEY);
    return JSON.parse(bytes.toString(CryptoJS.enc.Utf8)) as unknown[];
  } catch {
    return null;
  }
}

async function saveCookies(gstin: string, cookies: unknown[]): Promise<void> {
  await ensureCookieDir();
  const enc = CryptoJS.AES.encrypt(JSON.stringify(cookies), ENC_KEY).toString();
  await fs.writeFile(cookieFile(gstin), enc, "utf-8");
}

// ── Page-load verification ────────────────────────────────

async function verifyPageOpen(
  p: Page,
  checkpoint: string,
  expectedUrlContains: string[],
  expectedAnchorSelectors: string[],
  timeoutMs = 15000,
): Promise<void> {
  const startedAt = Date.now();

  await p
    .waitForFunction(() => document.readyState === "complete", undefined, {
      timeout: timeoutMs,
    })
    .catch(() => {
      throw new Error(
        `[${checkpoint}] document.readyState never reached "complete" within ${timeoutMs}ms`,
      );
    });

  await new Promise((r) => setTimeout(r, 500));
  const actualUrl = p.url();
  const urlMatches = expectedUrlContains.some((pat) => actualUrl.includes(pat));
  if (!urlMatches) {
    throw new Error(
      `[${checkpoint}] URL mismatch — got "${actualUrl}", expected one of: ${expectedUrlContains.join(", ")}`,
    );
  }

  const remaining = Math.max(2000, timeoutMs - (Date.now() - startedAt));
  let foundAnchor: string | null = null;
  for (const sel of expectedAnchorSelectors) {
    try {
      const el = await p.waitForSelector(sel, {
        timeout: remaining / expectedAnchorSelectors.length,
        state: "visible",
      });
      if (el) {
        foundAnchor = sel;
        break;
      }
    } catch {
      // try next
    }
  }
  if (!foundAnchor) {
    throw new Error(
      `[${checkpoint}] No anchor element became visible. Tried: ${expectedAnchorSelectors.join(", ")}`,
    );
  }

  const jitter = 300 + Math.floor(Math.random() * 500);
  await new Promise((r) => setTimeout(r, jitter));
}

async function establishReturnsSession(p: Page): Promise<void> {
  await p.goto(
    "https://services.gst.gov.in/services/auth/quicklinks/returns",
    { waitUntil: "domcontentloaded", timeout: 20000 },
  );

  await verifyPageOpen(
    p,
    "services-returns-quicklinks",
    [
      "services.gst.gov.in/services/auth/quicklinks/returns",
      "services.gst.gov.in/services/auth",
    ],
    ['a:has-text("Returns Dashboard")', "a.col-sm-3", ".content-pannel", "body"],
    20000,
  );

  await p.evaluate(() => {
    const links = Array.from(document.querySelectorAll("a"));
    const target = links.find((a) =>
      a.textContent?.includes("Returns Dashboard"),
    );
    if (target) target.click();
  });

  await verifyPageOpen(
    p,
    "returns-dashboard",
    [
      "return.gst.gov.in/returns/auth/dashboard",
      "return.gst.gov.in/returns/auth",
    ],
    [
      "select#fin",
      "select#mon",
      ".btn-search",
      'button:has-text("Search")',
      ".return-period",
      "body",
    ],
    25000,
  );
}

// ── Session management ────────────────────────────────────

function isOnDashboard(url: string): boolean {
  if (url.includes("/login") || url.includes("/error")) return false;
  return url.includes("/fowelcome") || url.includes("/auth/dashboard");
}

async function startSession(
  gstin: string,
  username: string,
  password: string,
): Promise<{ step: string; captchaImage?: string; message: string }> {
  // Close any existing session for this GSTIN
  const existing = sessions.get(gstin);
  if (existing) {
    await existing.browser.close().catch(() => {});
    sessions.delete(gstin);
  }

  // VISIBLE browser — user sees what's happening on their own PC
  const browser = await launchUserBrowser({ headless: false });

  const storedCookies = await loadCookies(gstin);
  const ctxOpts: BrowserContextOptions = {
    userAgent: UA,
    viewport: { width: 1366, height: 768 },
    locale: "en-IN",
    timezoneId: "Asia/Kolkata",
  };
  if (storedCookies) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ctxOpts as any).storageState = { cookies: storedCookies, origins: [] };
  }
  const context = await browser.newContext(ctxOpts);
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  const page = await context.newPage();
  page.setDefaultTimeout(20000);

  await page.goto("https://services.gst.gov.in/services/login", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await new Promise((r) => setTimeout(r, 3000));

  if (isOnDashboard(page.url())) {
    // Cookies still valid — establish returns session, save
    await establishReturnsSession(page);
    const cookies = await context.cookies();
    await saveCookies(gstin, cookies);
    sessions.set(gstin, { browser, context, page, gstin });
    return {
      step: "done",
      message: `Logged in from saved cookies (${cookies.length} cookies)`,
    };
  }

  // On login page — fill credentials
  // Find inputs heuristically (selectors vary)
  const inputs = await page.$$eval("input", (els) =>
    els.map((el) => ({ id: el.id, name: el.name, type: el.type, placeholder: el.placeholder })),
  );
  const userField = inputs.find(
    (i) => /user/i.test(i.id) || /user/i.test(i.name) || /user/i.test(i.placeholder),
  );
  const passField = inputs.find((i) => i.type === "password");

  if (userField) {
    const sel = userField.id ? `#${userField.id}` : `input[name="${userField.name}"]`;
    await page.fill(sel, username).catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
  }

  // GST portal has TWO password fields (one hidden decoy + the real visible
  // one). Picking the first `type=password` match grabs the hidden one and
  // silently fails. Iterate visible-first candidates — same pattern as
  // FILLGSTV1/src/lib/portal/session-manager.ts.
  const pwdSelectors = [
    'input[placeholder*="Password" i]',
    'input[type="password"]:visible',
    passField?.id ? `#${passField.id}` : null,
    '#user_pass',
  ].filter((s): s is string => typeof s === "string");
  for (const ps of pwdSelectors) {
    try {
      const el = await page.$(ps);
      if (el && (await el.isVisible())) {
        await el.fill(password);
        break;
      }
    } catch {
      // try next
    }
  }
  await new Promise((r) => setTimeout(r, 300));

  // Capture captcha image
  const captchaSelectors = [
    "img.captcha-image",
    "#captchaImg",
    'img[alt*="captcha" i]',
    'img[src*="captcha" i]',
    ".captcha img",
    "#imgCaptcha",
  ];
  let captchaImage: string | null = null;
  for (const sel of captchaSelectors) {
    try {
      const el = await page.waitForSelector(sel, { timeout: 3000 });
      if (el) {
        const buf = await el.screenshot({ type: "png" });
        captchaImage = `data:image/png;base64,${buf.toString("base64")}`;
        break;
      }
    } catch {
      // try next
    }
  }

  sessions.set(gstin, { browser, context, page, gstin });

  if (!captchaImage) {
    return { step: "error", message: "Could not capture captcha image" };
  }
  return {
    step: "captcha",
    captchaImage,
    message: "Enter the captcha shown",
  };
}

async function fetch2b(gstin: string, period: string): Promise<{ data: unknown; size: number }> {
  let session = sessions.get(gstin);

  // If no live session, try to spin up a headless one with stored cookies
  if (!session) {
    const cookies = await loadCookies(gstin);
    if (!cookies) {
      throw new Error("No active session and no stored cookies. Login first.");
    }
    const browser = await launchUserBrowser({ headless: true });
    const ctxOpts: BrowserContextOptions = {
      userAgent: UA,
      viewport: { width: 1366, height: 768 },
      locale: "en-IN",
      timezoneId: "Asia/Kolkata",
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ctxOpts as any).storageState = { cookies, origins: [] };
    const context = await browser.newContext(ctxOpts);
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20000);

    try {
      await establishReturnsSession(page);
    } catch (err) {
      await browser.close().catch(() => {});
      throw new Error(
        `Failed to establish returns session: ${err instanceof Error ? err.message : String(err)}. Cookies may have expired.`,
      );
    }

    session = { browser, context, page, gstin };
  } else {
    // Verify the live session is still on returns dashboard
    try {
      await verifyPageOpen(
        session.page,
        "returns-dashboard-recheck",
        ["return.gst.gov.in/returns/auth"],
        ["select#fin", "select#mon", ".btn-search", "body"],
        8000,
      );
    } catch {
      await establishReturnsSession(session.page);
    }
  }

  // Random delay before firing the API call
  await new Promise((r) => setTimeout(r, 400 + Math.floor(Math.random() * 600)));

  // GSTR-2B endpoints:
  //   v4.0 (Oct 2024+):  /gstr2b/auth/gstr2bdwld?rtnprd={period}
  //   legacy:            /gstr2b/auth/api/gstr2b/getjson?rtnprd={period}
  // Try v4.0 first; fall back on 404/410. Both return the same envelope
  // shape; the FillGST web-app parser handles flat (v4.0) or rate-wise
  // (legacy) tax fields.
  const endpoints = [
    `https://gstr2b.gst.gov.in/gstr2b/auth/gstr2bdwld?rtnprd=${period}`,
    `https://gstr2b.gst.gov.in/gstr2b/auth/api/gstr2b/getjson?rtnprd=${period}`,
  ];
  let resp;
  let lastStatus = 0;
  for (const url of endpoints) {
    resp = await session.context.request.get(url, {
      headers: { Referer: "https://return.gst.gov.in/returns/auth/dashboard" },
    });
    lastStatus = resp.status();
    if (lastStatus === 404 || lastStatus === 410) {
      continue;
    }
    break;
  }
  if (!resp || !resp.ok()) {
    throw new Error(`GST portal returned HTTP ${lastStatus}`);
  }
  const json = await resp.json();
  if (!json || (json.status !== undefined && json.status !== 1 && !json.data)) {
    const msg =
      typeof json?.error?.message === "string"
        ? json.error.message
        : "Portal returned unexpected response — session may have expired";
    throw new Error(msg);
  }

  // Refresh saved cookies (portal may have rotated tokens)
  await saveCookies(gstin, await session.context.cookies());

  const text = JSON.stringify(json);
  return { data: json, size: text.length };
}

// ── Express routes ────────────────────────────────────────

export function runPortalServer(app: Express): void {
  app.post("/portal/login", async (req, res) => {
    try {
      const { gstin, username, password } = req.body as {
        gstin: string;
        username: string;
        password: string;
      };
      if (!gstin || !username || !password) {
        return res.status(400).json({ ok: false, error: "gstin, username, password required" });
      }
      const result = await startSession(gstin, username, password);
      return res.json({ ok: true, ...result });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post("/portal/captcha", async (req, res) => {
    try {
      const { gstin, captchaText } = req.body as { gstin: string; captchaText: string };
      const session = sessions.get(gstin);
      if (!session) return res.status(400).json({ ok: false, error: "No active session" });

      // Type captcha and submit
      const inputs = await session.page.$$eval("input", (els) =>
        els.map((el) => ({ id: el.id, name: el.name, placeholder: el.placeholder })),
      );
      const captchaField = inputs.find(
        (i) =>
          /captcha/i.test(i.id) ||
          /captcha/i.test(i.name) ||
          /captcha/i.test(i.placeholder) ||
          /characters/i.test(i.placeholder),
      );
      if (captchaField) {
        const sel = captchaField.id ? `#${captchaField.id}` : `input[name="${captchaField.name}"]`;
        await session.page.fill(sel, captchaText);
      }
      await new Promise((r) => setTimeout(r, 300));
      // Click login
      await session.page.click('button[type="submit"]').catch(() => {});
      await new Promise((r) => setTimeout(r, 3000));

      if (isOnDashboard(session.page.url())) {
        await establishReturnsSession(session.page);
        await saveCookies(gstin, await session.context.cookies());
        return res.json({ ok: true, step: "done", message: "Logged in (no OTP)" });
      }
      // OTP needed?
      const otpVisible = await session.page.isVisible('input[name="otp"], #otp').catch(() => false);
      if (otpVisible) {
        return res.json({ ok: true, step: "otp", message: "Enter OTP" });
      }
      return res.json({ ok: false, error: "Unexpected state after captcha" });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post("/portal/otp", async (req, res) => {
    try {
      const { gstin, otp } = req.body as { gstin: string; otp: string };
      const session = sessions.get(gstin);
      if (!session) return res.status(400).json({ ok: false, error: "No active session" });

      await session.page.fill('input[name="otp"], #otp', otp).catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
      await session.page.click('button[type="submit"]').catch(() => {});
      await new Promise((r) => setTimeout(r, 3000));

      if (isOnDashboard(session.page.url())) {
        await establishReturnsSession(session.page);
        await saveCookies(gstin, await session.context.cookies());
        return res.json({ ok: true, step: "done", message: "OTP accepted" });
      }
      return res.json({ ok: false, error: "OTP failed" });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post("/portal/fetch2b", async (req, res) => {
    try {
      const { gstin, period } = req.body as { gstin: string; period: string };
      if (!gstin || !period) {
        return res.status(400).json({ ok: false, error: "gstin and period required" });
      }
      const result = await fetch2b(gstin, period);
      return res.json({ ok: true, ...result });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post("/portal/disconnect", async (req, res) => {
    try {
      const { gstin } = req.body as { gstin: string };
      const session = sessions.get(gstin);
      if (session) {
        await session.browser.close().catch(() => {});
        sessions.delete(gstin);
      }
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
