# Stuff Finder

Private, on-device catalogue of your belongings and where they are. Installable iOS PWA, no build step.

## Install on iPhone
1. Host this folder over HTTPS (iOS requires it for installing and for secure crypto), e.g. drag the folder onto Netlify Drop
   (it honours `_headers`), or push to GitHub Pages. The host only ever serves static app files; your data never leaves the phone.
2. Open the URL in **Safari** -> Share -> **Add to Home Screen**.
3. Launch from the home-screen icon, create a passcode, and scan.

## Security model
- AES-256-GCM encryption of every record in IndexedDB; key = PBKDF2-SHA256 (600k rounds) of your passcode, non-extractable, memory only.
- Ciphertext is bound to its record (AAD), so records can't be swapped or tampered with undetected.
- Escalating delay after 3 wrong passcodes; auto-lock when backgrounded or idle; lock clears all decrypted data.
- Strict CSP: only same-origin scripts/connections; no third-party code, analytics or CDNs at runtime.
- Optional Claude mode (off by default, needs your own API key + a consent step): sends downscaled frames only to api.anthropic.com; the key is stored encrypted in the vault. CSP allows no other host.
- Detection runs on-device (YOLOS-tiny, ONNX/WASM). Photos/videos are never stored, only a small encrypted thumbnail per item.
- No passcode recovery by design. Use Settings -> Export encrypted backup.

## Local testing
`python -m http.server 8123` then open http://127.0.0.1:8123 (localhost counts as secure).
