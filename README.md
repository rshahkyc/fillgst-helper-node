# FillGST Local Helper (Node)

A small Node.js service that runs on each user's PC. Lets the FillGST web app talk to the GST portal directly via Playwright running locally on that user's machine — so the portal browser opens on the user's PC, not the office server.

This is the **second user-side option**, alongside the Chrome Extension. Install whichever you prefer:

| | Chrome Extension | Local Helper (this) |
|---|---|---|
| Browser | Chrome / Edge / Brave only | Any browser |
| Install size | ~80 MB | ~150 MB (bundles Playwright Chromium) |
| Runs as | Browser extension | Background service / system tray |
| Detection risk | Lowest (real Chrome) | Low (Playwright with patches) |
| Captcha UX | Real GST portal tab | Captured image in FillGST UI |

## Build & install (one-time per PC)

### Quick install

1. Make sure you have Node.js 20+ installed: <https://nodejs.org>
2. Download or copy this folder to your PC
3. Open Command Prompt in this folder and run:

```sh
npm install
npm run install-browsers
npm run build
```

That's it. To start the helper:

```sh
npm start
```

The helper listens on `http://localhost:9876`. Leave the terminal open.

### Run on Windows startup (optional)

To start the helper automatically when Windows boots:

1. Press `Win + R` → type `shell:startup` → Enter
2. Right-click → New → Shortcut
3. Browse to `npm` (or paste `C:\Program Files\nodejs\npm.cmd`)
4. Add arguments: `start --prefix "C:\path\to\fillgst-helper-node"`
5. Set "Run" to "Minimized"

Or use a tool like `node-windows` to install as a proper Windows service.

## How it works

```
[User's browser] ──► http://192.168.1.24:3000 (FillGST web app)
       │                          │
       │                          │ (returns HTML, JS)
       ▼                          ▼
[Browser fetches  ◄──── http://localhost:9876 (this helper)
 directly from                    │
 localhost — no                   │ (Playwright runs HERE on user's PC)
 server proxy]                    ▼
                       [Chromium opens on user's PC]
                                  │
                                  ▼
                       [GST Portal pages]
```

When the user clicks "Login" in FillGST:
1. FillGST page calls `http://localhost:9876/portal/login` (the user's own helper)
2. Helper launches a visible Chromium on the user's PC
3. User sees the GST portal opening locally
4. Helper captures captcha → sends to FillGST UI
5. User enters captcha + OTP in FillGST UI
6. Helper submits to portal, saves cookies locally
7. Future fetches: helper uses saved cookies, no captcha/OTP for ~30 days

## API endpoints

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/health` | — | `{ok, version, name}` |
| POST | `/portal/login` | `{gstin, username, password}` | `{step: 'captcha' \| 'done', captchaImage?}` |
| POST | `/portal/captcha` | `{gstin, captchaText}` | `{step: 'otp' \| 'done'}` |
| POST | `/portal/otp` | `{gstin, otp}` | `{step: 'done'}` |
| POST | `/portal/fetch2b` | `{gstin, period}` | `{data, size}` |
| POST | `/portal/disconnect` | `{gstin}` | `{ok}` |
| GET | `/dsc/providers` | — | `{ok, providers}` |
| POST | `/dsc/providers` | `DscProvider[]` | `{ok}` |
| POST | `/dsc/certificates` | `{providerId}` | `{ok, certificates}` |
| POST | `/dsc/login` | `{providerId, slot, pin}` | `{ok}` |
| POST | `/dsc/sign` | `{providerId, slot, payloadBase64, digestAlgo?, detached?}` | `{ok, result}` |
| POST | `/dsc/hash` | `{payloadBase64}` | `{ok, sha256, hashedAt}` |

## DSC signing (Phase 0 stub)

The `/dsc/*` endpoints expose a stable HTTP contract for PKCS#11 USB-token signing. The Phase 0 implementation is contract-only — `listCertificates`, `login`, and `sign` throw `not_implemented`. Real signing wires in Phase 3 alongside e-invoice (NIC IRP) and e-waybill (NIC EWB), both of which mandate DSC for authorised signatories.

Driver discovery is pre-seeded for common Indian DSC tokens:

| Token | Default driver path (Windows) |
|---|---|
| eMudhra ePass2003 | `C:\Windows\System32\eps2003csp11v2.dll` |
| WatchData ProxKey | `C:\Windows\System32\Wdpkcs.dll` |
| SafeNet eToken | `C:\Windows\System32\eToken.dll` |
| Trust Key | `C:\Windows\System32\TrustKey.dll` |

Provider list lives at `~/.fillgst-helper/dsc-providers.json` and can be edited via `POST /dsc/providers`.

## Storage

Cookies are encrypted with AES-128 and stored at `~/.fillgst-helper/cookies-{gstin}.enc`. Encryption key defaults to a built-in string; override with the `FILLGST_HELPER_KEY` environment variable.

## Why not just use the Chrome extension?

You should use the Chrome extension if all your users use Chrome. It's lighter and has zero detection fingerprint.

Use this Node helper if:
- Some of your users use Firefox / Safari (no Chromium)
- You want a uniform setup across all browsers
- You're more comfortable with a system service than a browser extension

Both can coexist — FillGST detects which one is installed and uses it.
