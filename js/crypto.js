// Encryption primitives (Web Crypto only, no third-party code).
// Passcode -> PBKDF2-SHA256 (600k iterations) -> AES-256-GCM key.
// The CryptoKey is non-extractable and only ever lives in memory.
export const ITERATIONS = 600000;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

export async function deriveKey(passcode, salt, iterations = ITERATIONS) {
  const base = await crypto.subtle.importKey(
    'raw', enc.encode(passcode.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// "aad" binds each ciphertext to its store+id so records can't be swapped around.
export async function seal(key, obj, aad) {
  const iv = rand(12);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, enc.encode(JSON.stringify(obj)));
  return { iv, ct };
}

export async function open(key, rec, aad) {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: rec.iv, additionalData: enc.encode(aad) }, key, rec.ct);
  return JSON.parse(dec.decode(pt));
}

export const b64 = (buf) => {
  const u = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};
export const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
