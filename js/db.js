// Encrypted IndexedDB storage. Every record body is AES-256-GCM ciphertext.
//
// Key design: a random 256-bit master key encrypts all records. The master key is
// stored only in wrapped form: once wrapped by the passcode-derived key (PBKDF2),
// and optionally again by a passkey/Face ID-derived key (WebAuthn PRF).
// Changing the passcode just re-wraps the master key; records are not touched.
import { seal, open, deriveKey, rand, ITERATIONS, b64, unb64 } from './crypto.js';

const NAME = 'stuff-finder';
const STORES = ['meta', 'items', 'locs', 'cfg'];
let dbp;

const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const aad = (store, id) => `${store}:${id}`;
const enc = new TextEncoder();

function db() {
  return (dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open(NAME, 2);
    r.onupgradeneeded = () => STORES.forEach((s) => {
      if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s, { keyPath: 'id' });
    });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
}
const store = async (name, mode = 'readonly') => (await db()).transaction(name, mode).objectStore(name);

export const getMeta = async () => req((await store('meta')).get('meta'));
const setMeta = async (m) => req((await store('meta', 'readwrite')).put({ ...m, id: 'meta' }));
const importMaster = (raw) => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

async function prfWrapKey(prf) {
  const base = await crypto.subtle.importKey('raw', prf, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode('stuff-finder passkey v1') },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// ---- Passcode lifecycle -------------------------------------------------
export async function createVault(passcode) {
  const salt = rand(16);
  const passKey = await deriveKey(passcode, salt);
  const raw = rand(32);
  const wrap = await seal(passKey, { m: b64(raw) }, aad('meta', 'wrap'));
  const key = await importMaster(raw);
  const check = await seal(key, { ok: 1 }, aad('meta', 'check'));
  await setMeta({ salt, iterations: ITERATIONS, wrap, check, fails: 0, lockUntil: 0 });
  return key;
}

// Atomically move a pre-master-key vault (records encrypted directly by the
// passcode key) to the master-key scheme.
async function migrateLegacy(passKey, meta) {
  const items = await allRecs('items', passKey), locs = await allRecs('locs', passKey), cfg = await getCfg(passKey);
  const raw = rand(32);
  const key = await importMaster(raw);
  const wrap = await seal(passKey, { m: b64(raw) }, aad('meta', 'wrap'));
  const check = await seal(key, { ok: 1 }, aad('meta', 'check'));
  const rows = [];
  for (const [s, list] of [['items', items], ['locs', locs]]) for (const o of list) rows.push([s, { id: o.id, ...(await seal(key, o, aad(s, o.id))) }]);
  if (cfg) rows.push(['cfg', { id: 'claude', ...(await seal(key, cfg, aad('cfg', 'claude'))) }]);
  const d = await db();
  const tx = d.transaction(STORES, 'readwrite');
  for (const s of ['items', 'locs', 'cfg']) tx.objectStore(s).clear();
  for (const [s, r] of rows) tx.objectStore(s).put(r);
  tx.objectStore('meta').put({ ...meta, id: 'meta', wrap, check });
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = tx.onabort = () => rej(tx.error); });
  return key;
}

export async function unlockVault(passcode) {
  const meta = await getMeta();
  const now = Date.now();
  if (meta.lockUntil > now) return { wait: Math.ceil((meta.lockUntil - now) / 1000) };
  const passKey = await deriveKey(passcode, meta.salt, meta.iterations);
  let key, legacy = false;
  try {
    if (meta.wrap) key = await importMaster(unb64((await open(passKey, meta.wrap, aad('meta', 'wrap'))).m));
    else { await open(passKey, meta.check, aad('meta', 'check')); legacy = true; }
  } catch {
    const fails = (meta.fails || 0) + 1;
    // Escalating delay after 3 misses (2s, 4s, 8s ... capped at 5 min).
    const delay = fails >= 3 ? Math.min(2 ** (fails - 2), 300) * 1000 : 0;
    await setMeta({ ...meta, fails, lockUntil: delay ? now + delay : 0 });
    return { error: true, wait: delay / 1000 };
  }
  if (legacy) key = await migrateLegacy(passKey, meta);
  if (meta.fails) await setMeta({ ...(await getMeta()), fails: 0, lockUntil: 0 });
  return { key };
}

// Verifies the passcode and returns the raw master key bytes. Only used to re-wrap
// it (change passcode / enable Face ID); the live key is never extractable.
export async function masterRaw(passcode) {
  const meta = await getMeta();
  const passKey = await deriveKey(passcode, meta.salt, meta.iterations);
  return unb64((await open(passKey, meta.wrap, aad('meta', 'wrap'))).m);
}

export async function changePasscode(oldPass, newPass) {
  const raw = await masterRaw(oldPass);
  const meta = await getMeta();
  const salt = rand(16);
  const passKey = await deriveKey(newPass, salt);
  const wrap = await seal(passKey, { m: b64(raw) }, aad('meta', 'wrap'));
  await setMeta({ ...meta, salt, iterations: ITERATIONS, wrap, fails: 0, lockUntil: 0 });
}

// ---- Passkey (Face ID) unlock --------------------------------------------
export async function savePasskey(raw, { credId, prfSalt, prf }) {
  const meta = await getMeta();
  const wrap = await seal(await prfWrapKey(prf), { m: b64(raw) }, aad('meta', 'pk'));
  await setMeta({ ...meta, passkey: { credId: b64(credId), salt: b64(prfSalt), wrap } });
}
export async function unlockWithPrf(prf) {
  const meta = await getMeta();
  const { m } = await open(await prfWrapKey(prf), meta.passkey.wrap, aad('meta', 'pk'));
  return importMaster(unb64(m));
}
export async function removePasskey() {
  const { passkey, ...rest } = await getMeta();
  await setMeta(rest);
}

// ---- Records ------------------------------------------------------------
export async function putRec(name, id, obj, key) {
  const { iv, ct } = await seal(key, obj, aad(name, id));
  await req((await store(name, 'readwrite')).put({ id, iv, ct }));
}

export async function allRecs(name, key) {
  const rows = await req((await store(name)).getAll());
  const out = [];
  for (const r of rows) {
    try { out.push(await open(key, r, aad(name, r.id))); } catch { /* tampered or foreign: skip */ }
  }
  return out;
}

export const delRec = async (name, id) => req((await store(name, 'readwrite')).delete(id));

export async function getCfg(key) {
  const r = await req((await store('cfg')).get('claude'));
  if (!r) return null;
  try { return await open(key, r, aad('cfg', 'claude')); } catch { return null; }
}
export const putCfg = (cfg, key) => putRec('cfg', 'claude', cfg, key);

export async function wipe() {
  (await db()).close();
  dbp = undefined;
  await new Promise((res) => {
    const r = indexedDB.deleteDatabase(NAME);
    r.onsuccess = r.onerror = r.onblocked = () => res();
  });
}

// ---- Backup (ciphertext only: useless without the passcode) -------------
export async function exportBackup() {
  const meta = await getMeta();
  const pack = (x) => ({ iv: b64(x.iv), ct: b64(x.ct) });
  const dump = { app: 'stuff-finder', v: 1, meta: { salt: b64(meta.salt), iterations: meta.iterations, check: pack(meta.check), wrap: meta.wrap ? pack(meta.wrap) : null },
    items: [], locs: [], cfg: [] };
  for (const s of ['items', 'locs', 'cfg']) {
    for (const r of await req((await store(s)).getAll())) dump[s].push({ id: r.id, ...pack(r) });
  }
  return JSON.stringify(dump);
}

export async function importBackup(text) {
  const d = JSON.parse(text);
  if (d.app !== 'stuff-finder' || d.v !== 1) throw new Error('Not a Stuff Finder backup');
  const unpack = (x) => ({ iv: unb64(x.iv), ct: unb64(x.ct) });
  await wipe();
  await setMeta({ salt: unb64(d.meta.salt), iterations: d.meta.iterations, check: unpack(d.meta.check),
    ...(d.meta.wrap ? { wrap: unpack(d.meta.wrap) } : {}), fails: 0, lockUntil: 0 });
  for (const s of ['items', 'locs', 'cfg']) {
    for (const r of d[s] ?? []) await req((await store(s, 'readwrite')).put({ id: r.id, ...unpack(r) }));
  }
}
