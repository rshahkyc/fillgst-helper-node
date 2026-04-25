import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type {
  DscCertificate,
  DscLoginRequest,
  DscProvider,
  DscSignRequest,
  DscSignResult,
} from "./types.js";

/**
 * PKCS#11 wrapper. Phase 0 implementation is contract-only:
 *   - provider registry (read/write to ~/.fillgst-helper/dsc-providers.json)
 *   - listCertificates / login / sign throw a typed "not_implemented" until
 *     graphene-pk11 (or node-pkcs11js) is wired
 *
 * Real signing lands in Phase 3 alongside e-invoice (NIC IRP) and
 * e-waybill (NIC EWB). Both mandate DSC for authorised signatories.
 *
 * Wiring plan (Phase 3):
 *   1. `pnpm add graphene-pk11` (depends on pkcs11.h native binding)
 *   2. Replace `notImplemented()` below with graphene Module.load(driverPath)
 *   3. C_FindObjects → pull X.509 certs, return DER → PEM convert
 *   4. C_Login(slot, "user", pin) → start session
 *   5. C_SignInit(CKM_SHA256_RSA_PKCS) + C_Sign(payloadHash) → raw RSA sig
 *   6. Wrap into PKCS#7 SignedData using `node-forge` or native CMS lib
 */

const PROVIDER_REGISTRY = path.join(os.homedir(), ".fillgst-helper", "dsc-providers.json");

async function ensureRegistryDir() {
  await fs.mkdir(path.dirname(PROVIDER_REGISTRY), { recursive: true });
}

export async function listProviders(): Promise<DscProvider[]> {
  await ensureRegistryDir();
  try {
    const text = await fs.readFile(PROVIDER_REGISTRY, "utf-8");
    return JSON.parse(text) as DscProvider[];
  } catch {
    return DEFAULT_PROVIDERS;
  }
}

export async function saveProviders(providers: DscProvider[]): Promise<void> {
  await ensureRegistryDir();
  await fs.writeFile(PROVIDER_REGISTRY, JSON.stringify(providers, null, 2), "utf-8");
}

/**
 * Pre-seeded list of known Indian DSC drivers. Path may not exist on
 * every PC; the user can edit / add via the web app's DSC settings.
 */
export const DEFAULT_PROVIDERS: DscProvider[] = [
  {
    id: "epass2003",
    name: "eMudhra ePass2003",
    driverPath: "C:\\Windows\\System32\\eps2003csp11v2.dll",
  },
  {
    id: "proxkey",
    name: "WatchData ProxKey",
    driverPath: "C:\\Windows\\System32\\Wdpkcs.dll",
  },
  {
    id: "etoken",
    name: "SafeNet Authentication Client (eToken)",
    driverPath: "C:\\Windows\\System32\\eToken.dll",
  },
  {
    id: "trustkey",
    name: "Trust Key",
    driverPath: "C:\\Windows\\System32\\TrustKey.dll",
  },
];

class NotImplementedError extends Error {
  code = "not_implemented" as const;
  constructor(stage: string) {
    super(
      `DSC ${stage} not yet wired in fillgst-helper-node. ` +
        `Land in Phase 3 alongside e-invoice + e-waybill (graphene-pk11 binding required).`,
    );
  }
}

export async function listCertificates(_providerId: string): Promise<DscCertificate[]> {
  throw new NotImplementedError("certificate listing");
}

export async function login(_request: DscLoginRequest): Promise<{ ok: true }> {
  throw new NotImplementedError("login");
}

export async function sign(_request: DscSignRequest): Promise<DscSignResult> {
  throw new NotImplementedError("signing");
}

/**
 * Compute SHA-256 of base64 input. Used by /dsc/sign-evc fallback when
 * the user authorises via OTP rather than DSC token — the actual EVC
 * happens server-side at the GSTN portal; this helper just produces the
 * canonical hash the web app needs for record-keeping.
 */
export function sha256OfBase64(b64: string): string {
  const buf = Buffer.from(b64, "base64");
  return createHash("sha256").update(buf).digest("hex");
}
