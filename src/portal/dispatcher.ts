/**
 * GSTN action-code dispatcher.
 *
 * Mirrors CompuGST's GstApi.callApi() pattern but adapted to our
 * Playwright-on-user-PC model. Every portal call routes through one
 * function with a uniform envelope; per-form URL mapping happens in
 * `urlForAction()`.
 *
 * Reference: docs/compugst-knowledge.md sections 1, 2 in the FillGST
 * web-app repo. Mermaid sequences in
 * FILLGSTV1/docs/kb/computax/04-sequences-*.md.
 *
 * The shape:
 *   { action, formNo, period, method, body?, dataTag?, returnDataTag? }
 *
 * Returns:
 *   { ok: true, status: "P"|"IP"|"REC"|"PE"|"ER"|"OK", data?, refId?, raw? }
 *   { ok: false, errorCode?, error: string, retryable?: boolean,
 *     reauthNeeded?: "FORCELOGIN"|"FORCEOTP" }
 */

import type { BrowserContext } from "playwright-core";

export type FormNo =
  | "1" | "1a" | "2" | "2a" | "2b"
  | "3" | "3b"
  | "4" | "4a" | "4x"
  | "6" | "7" | "8"
  | "9" | "9a" | "9c"
  | "returns" | "ledger" | "ims" | "einv" | "ewb";

export type ActionCode =
  // Return-agnostic
  | "RETSAVE" | "RETSUBMIT" | "RETFILE" | "RETNEWPTF" | "RETFILER1A"
  | "RETSUM" | "RETSTATUS" | "RETACCEPT" | "RETOFFSET" | "GENERATE"
  | "CASH" | "RECORDS" | "FORCEOTP" | "FORCELOGIN"
  // Section-download
  | "B2B" | "B2BA" | "B2CL" | "B2CLA" | "B2CS" | "B2CSA"
  | "CDNR" | "CDNRA" | "CDNUR" | "CDNURA"
  | "EXP" | "EXPA" | "NIL" | "HSN" | "HSNSUM"
  | "DOC" | "DOCISS" | "AT" | "ATA" | "TXP" | "TXPA"
  | "TXOS" | "TXOSA" | "TXLI" | "ECOM"
  | "IMPG" | "IMPGSEZ" | "IMPS" | "ISD" | "ISDA"
  | "TDS" | "TCS" | "ITCRVSL"
  // IMS
  | "IMS_FETCH" | "IMS_ACTION" | "IMS_RESET" | "IMS_REFRESH"
  // E-invoice
  | "EINV_AUTH" | "EINV_GENIRN" | "EINV_BULKGEN" | "EINV_CANCEL"
  | "EINV_GETIRN" | "EINV_GETGSTIN" | "EINV_GETCANCEL"
  // E-waybill
  | "EWB_AUTH" | "EWB_GENERATE" | "EWB_UPDATE_VEHICLE" | "EWB_UPDATE_TRANSPORTER"
  | "EWB_EXTEND" | "EWB_CANCEL" | "EWB_GET" | "EWB_GETBYGST" | "EWB_MULTIVEHICLE";

export type Method = "GET" | "POST" | "PUT";

export interface DispatchInput {
  action: ActionCode;
  formNo: FormNo;
  /** "MMYYYY" — e.g. "032026". For quarterly GSTR-4, accepts 21-24 too. */
  period?: string;
  method: Method;
  /** Request body for POST/PUT. */
  body?: unknown;
  /** Override URL when the standard mapping doesn't apply. */
  urlOverride?: string;
  /** Extra query params to append. */
  params?: Record<string, string>;
}

export interface DispatchOk<T = unknown> {
  ok: true;
  /** GSTN status flag when present (P/IP/REC/PE/ER/OK). */
  status?: string;
  /** GSTN ref id (returned on RETSAVE/RETSUBMIT/RETFILE). */
  refId?: string;
  data?: T;
  raw: unknown;
  endpoint: string;
}

export interface DispatchErr {
  ok: false;
  /** Stable GSTN error code (e.g. RET191106, AUTH4033). */
  errorCode?: string;
  error: string;
  retryable?: boolean;
  /** When session expired, signals which re-auth flow to invoke. */
  reauthNeeded?: "FORCELOGIN" | "FORCEOTP";
}

export type DispatchResult<T = unknown> = DispatchOk<T> | DispatchErr;

/**
 * Quarterly period remap for GSTR-4 (DB stores 21-24; portal expects MM).
 * Reference: GstApis.js:341-351 per docs/compugst-knowledge.md §1.
 */
function remapQuarter(period: string): string {
  const map: Record<string, string> = { "21": "06", "22": "09", "23": "12", "24": "03" };
  if (period.length === 6) {
    const mm = period.slice(0, 2);
    if (map[mm]) return map[mm] + period.slice(2);
  }
  return period;
}

/**
 * Map an (action, formNo, period) tuple to the actual GSTN URL.
 * Documented in docs/compugst-knowledge.md sections 1+2.
 */
export function urlForAction(input: DispatchInput): { url: string; referer: string } {
  const period = input.period ? remapQuarter(input.period) : undefined;
  const params = new URLSearchParams(input.params ?? {});

  // GSTR-2B has its own subdomain and two endpoints (v4.0 + legacy).
  if (input.formNo === "2b" && input.action === "B2B") {
    if (period) params.set("rtnprd", period);
    const qs = params.toString();
    return {
      url: `https://gstr2b.gst.gov.in/gstr2b/auth/gstr2bdwld${qs ? "?" + qs : ""}`,
      referer: "https://return.gst.gov.in/returns/auth/dashboard",
    };
  }

  // IMS lives under /returns2 (introduced Oct 2024+).
  if (input.formNo === "ims") {
    if (period) params.set("rtnprd", period);
    const qs = params.toString();
    const action = input.action === "IMS_FETCH" ? "fetchIMS" : "actionIMS";
    return {
      url: `https://return.gst.gov.in/returns2/auth/api/${action}${qs ? "?" + qs : ""}`,
      referer: "https://return.gst.gov.in/returns/auth/dashboard",
    };
  }

  // Default: returns/auth dispatcher pattern matching CompuGST.
  if (period) params.set("ret_period", period);
  params.set("action", input.action);
  params.set("formno", input.formNo);
  const qs = params.toString();
  return {
    url: `https://return.gst.gov.in/returns/auth/api/dispatcher${qs ? "?" + qs : ""}`,
    referer: "https://return.gst.gov.in/returns/auth/dashboard",
  };
}

/**
 * Re-auth detector — looks at common GSTN error shapes.
 */
function detectReauth(json: unknown): "FORCELOGIN" | "FORCEOTP" | null {
  const j = json as { error?: { errorCode?: string; message?: string }; status?: string };
  const code = j?.error?.errorCode ?? "";
  if (code === "AUTH4033" || code === "AUTH4041") return "FORCELOGIN";
  if (code === "AUTH101" || code === "AUTH151" || code === "AUTH153" || code === "AUTH154") return "FORCEOTP";
  return null;
}

const RETRYABLE_CODES = new Set(["TEC4002", "SWEB_9003"]);

/**
 * Dispatch a portal call through Playwright's authenticated context.
 * Adds the WAF-required Referer header, handles common error shapes,
 * surfaces re-auth signals.
 */
export async function dispatch<T = unknown>(
  context: BrowserContext,
  input: DispatchInput,
): Promise<DispatchResult<T>> {
  const { url, referer } = input.urlOverride
    ? { url: input.urlOverride, referer: "https://return.gst.gov.in/returns/auth/dashboard" }
    : urlForAction(input);

  // Random small delay to soften the WAF rate-limit signal.
  await new Promise((r) => setTimeout(r, 300 + Math.floor(Math.random() * 400)));

  const init: { headers: Record<string, string>; data?: unknown } = {
    headers: {
      Referer: referer,
      Accept: "application/json",
    },
  };
  if (input.body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.data = input.body;
  }

  let resp;
  try {
    if (input.method === "GET") {
      resp = await context.request.get(url, { headers: init.headers });
    } else if (input.method === "POST") {
      resp = await context.request.post(url, { headers: init.headers, data: init.data });
    } else {
      resp = await context.request.put(url, { headers: init.headers, data: init.data });
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), retryable: true };
  }

  const status = resp.status();
  let json: unknown;
  try {
    json = await resp.json();
  } catch {
    json = await resp.text().catch(() => null);
  }

  if (status >= 500) {
    return {
      ok: false,
      error: `GSTN ${status} on ${url}`,
      retryable: true,
    };
  }

  if (!resp.ok()) {
    const errorCode =
      (json as { error?: { errorCode?: string } } | null)?.error?.errorCode ?? undefined;
    const reauth = detectReauth(json);
    return {
      ok: false,
      errorCode,
      error:
        (json as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${status}`,
      retryable: errorCode ? RETRYABLE_CODES.has(errorCode) : false,
      reauthNeeded: reauth ?? undefined,
    };
  }

  // Even on 200, GSTN occasionally returns `{status: 0, error: {...}}`.
  const j = json as {
    status?: number | string;
    error?: { errorCode?: string; message?: string };
    data?: unknown;
    ref_id?: string;
    chksum?: string;
  } | null;

  if (j && j.status !== undefined && j.status !== 1 && j.status !== "1" && !j.data) {
    const reauth = detectReauth(json);
    return {
      ok: false,
      errorCode: j.error?.errorCode,
      error: j.error?.message ?? "GSTN returned unexpected envelope",
      retryable: j.error?.errorCode ? RETRYABLE_CODES.has(j.error.errorCode) : false,
      reauthNeeded: reauth ?? undefined,
    };
  }

  return {
    ok: true,
    status: typeof j?.status === "string" ? j.status : undefined,
    refId: j?.ref_id,
    data: (j?.data ?? j) as T,
    raw: json,
    endpoint: url,
  };
}
