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

/**
 * Cross-module session accessor used by /portal/dispatch and
 * /portal/keepalive routes. Returns undefined when no live session
 * exists for the gstin.
 */
export function getSession(gstin: string): Session | undefined {
  return sessions.get(gstin);
}

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

/**
 * Dismiss the post-login pop-up gauntlet GST portal hits users with —
 * Aadhaar prompt, e-KYC nag, "geocoded address available", "update
 * bank details", etc. Each one of these blocks the rest of the page
 * with a backdrop and silently breaks any subsequent click-through if
 * not closed first. Ported verbatim from FILLGSTV1's session-manager.ts
 * (the hard-won list of dismissable button texts).
 */
async function dismissPortalModals(p: Page): Promise<void> {
  await p
    .evaluate(() => {
      const dismissTexts = [
        "REMIND ME LATER",
        "Remind Me Later",
        "Remind me later",
        "remind me later",
        "Close",
        "CLOSE",
        "Cancel",
        "CANCEL",
        "Skip",
        "SKIP",
        "No, Thanks",
        "Later",
      ];
      const allButtons = Array.from(
        document.querySelectorAll("button, a.btn, input[type='button']"),
      );
      for (const el of allButtons) {
        const txt = (el.textContent ?? (el as HTMLInputElement).value ?? "").trim();
        if (!txt) continue;
        if (dismissTexts.some((t) => txt.toLowerCase() === t.toLowerCase())) {
          const rect = (el as HTMLElement).getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            (el as HTMLElement).click();
          }
        }
      }
      // Also try clicking modal × close buttons.
      const closeIcons = Array.from(
        document.querySelectorAll(
          ".modal-header .close, button.close, .ui-dialog-titlebar-close",
        ),
      );
      for (const el of closeIcons) {
        const rect = (el as HTMLElement).getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          (el as HTMLElement).click();
        }
      }
    })
    .catch(() => {});
  // Give the close animations time to finish before the next interaction.
  await new Promise((r) => setTimeout(r, 800));
}

/**
 * Land the page on `return.gst.gov.in/returns/auth/dashboard` so the
 * subsequent GSTR-2B / IMS / ledger API calls hit a fully-warmed
 * session. Tolerant of post-login modals + the GSTN access-denied
 * interstitial — V1 hit both of those repeatedly.
 *
 * Sequence:
 *   1. Dismiss any modals already up (twice with a settle pause —
 *      modals chain).
 *   2. Soft-goto /services/auth/quicklinks/returns; if it bounces to
 *      /accessdenied or any other page we don't fail, we just continue
 *      to the click-through which usually works anyway.
 *   3. Click the "Returns Dashboard" anchor by text (resilient to
 *      class-name changes between portal updates).
 *   4. Wait for the dashboard's specific selects (#fin + #mon) to be
 *      visible — that's the unambiguous "we made it" signal.
 */
async function establishReturnsSession(p: Page): Promise<void> {
  await dismissPortalModals(p);
  await new Promise((r) => setTimeout(r, 600));
  await dismissPortalModals(p);

  await p
    .goto("https://services.gst.gov.in/services/auth/quicklinks/returns", {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    })
    .catch(() => {});

  // Detect the early accessdenied bounce. GSTN throws this when the
  // logged-in user can't access the returns area — usually because
  // Aadhaar / e-KYC is incomplete on that GSTIN's account. Surface
  // the exact URL substring "accessdenied" so the route handler can
  // map it to a user-actionable error.
  if (p.url().includes("error/accessdenied") || p.url().includes("access-denied")) {
    throw new Error(`[returns-quicklinks] bounced to accessdenied — current URL: ${p.url()}`);
  }

  await dismissPortalModals(p);
  await new Promise((r) => setTimeout(r, 3000));

  await p.evaluate(() => {
    const link = Array.from(document.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Returns Dashboard"),
    );
    if (link) (link as HTMLElement).click();
  });

  await p
    .waitForFunction(
      () => {
        if (window.location.hostname !== "return.gst.gov.in") return false;
        const fy = document.querySelector("select#fin, select[name='fin']");
        const mon = document.querySelector("select#mon, select[name='mon']");
        if (!fy || !mon) return false;
        const fyRect = (fy as HTMLElement).getBoundingClientRect();
        const monRect = (mon as HTMLElement).getBoundingClientRect();
        return fyRect.height > 0 && monRect.height > 0;
      },
      undefined,
      { timeout: 25000 },
    )
    .catch(() => {
      throw new Error(
        `[returns-dashboard] Dashboard dropdowns never visible. Current URL: ${p.url()}.`,
      );
    });

  await new Promise((r) => setTimeout(r, 1500));
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

  // Headless. The user types the captcha in the FillGST modal (which
  // shows a screenshot of the captcha img element) — not in this
  // browser window. Showing a visible Chrome window only created
  // confusion: users would try to type in the Playwright window
  // instead, which doesn't drive our flow. Headless is also faster
  // (no GPU, no window-decoration paint).
  //
  // GSTN's WAF doesn't differentiate headless vs headed for our
  // use case because:
  //   1. We strip navigator.webdriver via init script (line 217-ish)
  //   2. We use a real Chrome User-Agent string
  //   3. We use window.open + page.evaluate for the gstr2b popup,
  //      which behaves identically headless or headed.
  const browser = await launchUserBrowser({ headless: true });

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

  // If no live session, spin up a headless one with stored cookies.
  // (Headless is fine — see startSession comment above for why GSTN's
  // WAF doesn't differentiate.)
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

    // Navigate via JS-driven nav, not page.goto, to match what a real
    // user clicking a link looks like to the WAF.
    await page
      .evaluate(() => {
        window.location.href = "https://services.gst.gov.in/services/auth/quicklinks/returns";
      })
      .catch(() => {});
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 2000));
    await page
      .evaluate(() => {
        const link = Array.from(document.querySelectorAll("a")).find((a) =>
          a.textContent?.includes("Returns Dashboard"),
        );
        if (link) (link as HTMLElement).click();
      })
      .catch(() => {});
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));

    session = { browser, context, page, gstin };
    sessions.set(gstin, session);
  }

  // ─── Direct popup navigation to gstr2b.gst.gov.in/auth/gstr2b/summary ───
  //
  // The dashboard tile-click chain doesn't reliably work for every
  // account (RMR Marmo's bounces to /accessdenied on the dashboard
  // path). Skip it entirely. Use window.open from the logged-in
  // services.gst.gov.in/auth/fowelcome page to directly open the
  // gstr2b summary SPA in a new tab.
  //
  // Why this works:
  //   - window.open from a same-domain-family page (.gst.gov.in)
  //     is treated as a real user-initiated navigation by the WAF
  //   - The popup browser context has the AuthToken cookie on
  //     .gst.gov.in already (from login)
  //   - The popup's top-level navigation triggers GSTN's WAF JS
  //     challenge, which sets the gstr2b TS-cookie on the popup's
  //     subdomain
  //   - Once the SPA loads, same-origin fetch to /gstr2b/auth/api/...
  //     carries ALL relevant cookies (AuthToken + gstr2b TS) and
  //     bypasses the WAF
  const popupCapture = session.context.waitForEvent("page", { timeout: 15000 }).catch(() => null);
  const targetUrl = `https://gstr2b.gst.gov.in/gstr2b/auth/gstr2b/summary`;
  await session.page
    .evaluate((u: string) => {
      window.open(u, "_blank");
    }, targetUrl)
    .catch(() => {});
  let g2bPage = await popupCapture;

  // Fallback: if popup blocker (or cross-origin restriction) ate the
  // window.open, manually open a new page in the same context.
  if (!g2bPage) {
    g2bPage = await session.context.newPage().catch(() => null);
    if (g2bPage) {
      await g2bPage
        .evaluate((u: string) => {
          window.location.href = u;
        }, targetUrl)
        .catch(() => {});
      // about:blank → window.location.href doesn't fire if page never
      // loads anything; fall back to page.goto with a "look natural"
      // referer.
      if (!g2bPage.url().includes("gstr2b.gst.gov.in")) {
        await g2bPage
          .goto(targetUrl, {
            waitUntil: "domcontentloaded",
            timeout: 20000,
            referer: "https://services.gst.gov.in/services/auth/fowelcome",
          })
          .catch(() => {});
      }
    }
  }

  if (!g2bPage) {
    throw new Error("Couldn't open gstr2b.gst.gov.in popup — Playwright context.newPage failed.");
  }

  // Wait for the SPA to fully load + run its JS challenge. The WAF
  // sets a TS-cookie for the gstr2b subdomain during this window.
  await g2bPage.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 5000));

  // If we got bounced to /accessdenied, that's the same RBA / Aadhaar
  // / e-KYC issue we've been hitting. Surface it cleanly.
  const popupUrl = g2bPage.url();
  if (popupUrl.includes("accessdenied") || popupUrl.includes("error/accessdenied")) {
    await g2bPage.close().catch(() => {});
    throw new Error(
      `gstr2b.gst.gov.in bounced to /accessdenied. The current account/IP combination is flagged by GSTN's WAF — likely Aadhaar/e-KYC pending OR short-term IP throttle from too many automation attempts. Final URL: ${popupUrl}.`,
    );
  }
  if (!popupUrl.includes("gstr2b.gst.gov.in")) {
    await g2bPage.close().catch(() => {});
    throw new Error(
      `gstr2b popup landed on unexpected URL: ${popupUrl}. Expected gstr2b.gst.gov.in/...`,
    );
  }

  // Same-origin fetch via the popup's evaluate. Relative URL — cookies
  // attach automatically including the WAF cookie just issued.
  const g2bResult = (await g2bPage.evaluate(async (prd: string) => {
    const r = await fetch(`/gstr2b/auth/api/gstr2b/getjson?rtnprd=${prd}`, {
      credentials: "include",
    });
    return {
      status: r.status,
      ctype: r.headers.get("content-type") ?? "",
      body: await r.text(),
    };
  }, period)) as { status: number; ctype: string; body: string };

  await g2bPage.close().catch(() => {});

  if (g2bResult.status !== 200) {
    throw new Error(
      `GSTR-2B API returned HTTP ${g2bResult.status}. First 200 chars: ${g2bResult.body.slice(0, 200)}`,
    );
  }
  if (!g2bResult.ctype.includes("json")) {
    throw new Error(
      `GSTR-2B API returned non-JSON content-type=${g2bResult.ctype}. First 200 chars: ${g2bResult.body.slice(0, 200)}`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(g2bResult.body);
  } catch (e) {
    throw new Error(`GSTR-2B API JSON parse failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  await saveCookies(gstin, await session.context.cookies());
  return { data: json, size: g2bResult.body.length };
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
        // Login succeeded. We deliberately DO NOT navigate to
        // /services/auth/quicklinks/returns here — that URL bounces
        // to /services/error/accessdenied for many accounts (Aadhaar /
        // e-KYC pending, OR any auto-detection of automation), and a
        // bounce there leaves the page stuck and breaks every
        // subsequent step.
        //
        // CompuGST's live WOTP flow we captured (section 6 of the
        // doc) goes STRAIGHT from /authenticate to the GSTR-2B API
        // call — no /quicklinks/returns nav between. The doc's
        // section 8 line 463 says context.request.get() bypasses
        // the WAF; it doesn't actually require a prior dashboard
        // page-navigation as long as the auth cookies on
        // .gst.gov.in are present, which they are after a
        // successful authenticate.
        //
        // So: snapshot the cookies, return done; fetch2b will use
        // session.context.request.get() with the auth cookies + a
        // Referer pointing to the dashboard URL (which makes it
        // look legitimate without actually loading the page).
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
        // Same reasoning as the captcha success path: skip the
        // /quicklinks/returns nav (it bounces to /accessdenied).
        // fetch2b uses context.request.get with auth cookies +
        // Referer header to call gstr2b.gst.gov.in directly.
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
