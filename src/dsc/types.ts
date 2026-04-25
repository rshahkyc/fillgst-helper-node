/**
 * DSC bridge types.
 *
 * The Indian GSTN, NIC IRP (e-invoice), and NIC EWB (e-waybill) portals
 * all accept DER-encoded PKCS#7 SignedData (CMS) blobs produced by a
 * Class 2 or Class 3 USB-token DSC. This bridge exposes that signing
 * capability over local HTTP so the FillGST web app can request a
 * signature without ever touching the user's PIN or private key.
 *
 * Supported tokens (PKCS#11 driver paths shipped on the user's PC):
 *   - eMudhra ePass2003     C:\Windows\System32\eps2003csp11v2.dll
 *   - eMudhra ProxKey       C:\Windows\System32\eTPKCS11.dll
 *   - Watchdata Proxkey      C:\Windows\System32\Wdpkcs.dll
 *   - SafeNet Authentication C:\Windows\System32\eToken.dll
 *   - Aladdin eToken         C:\Windows\System32\eTPKCS11.dll
 *   - Trust Key              C:\Windows\System32\TrustKey.dll
 *
 * Users register the path of their installed driver in the helper's
 * options page, then plug in the token and enter the PIN once per
 * signing session.
 */

export interface DscProvider {
  /** Stable id (e.g., "epass2003"). */
  id: string;
  /** Human-readable label shown in UI. */
  name: string;
  /** Absolute path to the vendor PKCS#11 DLL/.so. */
  driverPath: string;
}

export interface DscCertificate {
  /** Slot id from PKCS#11 enumeration. */
  slot: number;
  /** Subject CN of the certificate. */
  subject: string;
  /** Serial number (hex). */
  serial: string;
  /** ISO date the cert is valid until. */
  notAfter: string;
  /** PEM-encoded X.509 cert. */
  certPem: string;
  /** SHA-256 fingerprint (hex). */
  fingerprint: string;
}

export interface DscSignRequest {
  providerId: string;
  /**
   * Slot number from {@link DscCertificate.slot}. The user is expected
   * to have already authenticated against this slot via /dsc/login;
   * /dsc/sign assumes an active session for the slot.
   */
  slot: number;
  /**
   * Base64-encoded payload to sign. For the GST portal this is the
   * UTF-8 JSON of the return body, exactly the same bytes the portal
   * receives.
   */
  payloadBase64: string;
  /**
   * Hash algorithm. GSTN currently expects SHA-256.
   */
  digestAlgo?: "sha256" | "sha384" | "sha512";
  /**
   * If true, return a detached PKCS#7 SignedData (no embedded payload).
   * Default false → embedded payload, which is what GSTN typically wants.
   */
  detached?: boolean;
}

export interface DscSignResult {
  /** Base64-encoded DER-encoded PKCS#7 SignedData (CMS). */
  signaturePkcs7Base64: string;
  /** Hex SHA-256 of the signature for client-side audit. */
  signatureSha256: string;
  /** ISO timestamp of when the signature was produced (helper PC clock). */
  signedAt: string;
  /** Certificate fingerprint that signed (helps catch wrong-token mishaps). */
  certFingerprint: string;
}

export interface DscLoginRequest {
  providerId: string;
  slot: number;
  pin: string;
}

export interface DscErrorResponse {
  ok: false;
  error: string;
  /** Stable error code so the web app can map to a user-friendly message. */
  code?:
    | "driver_not_found"
    | "no_token_inserted"
    | "wrong_pin"
    | "pin_locked"
    | "no_certificates"
    | "unsupported_algorithm"
    | "not_implemented";
}
