import { h, icon, toast, sheet } from './dom.js';
import * as DB from './db.js';
import * as PK from './passkey.js';
import { unb64 } from './crypto.js';
import { scanFiles, scanWithClaude, CLAUDE_MODELS } from './detect.js';

const S = { cfg: {}, key: null, items: [], locs: [], tab: 'find', q: '', filter: 'all', curLoc: '', nav: '', reconcile: false,
  hasPasskey: false, busy: false, pickerOpen: false, hiddenAt: 0 };
const app = document.getElementById('app');
const LS = { get: (k, d) => localStorage.getItem('sf.' + k) ?? d, set: (k, v) => localStorage.setItem('sf.' + k, v) };
const TABS = [['find', 'Find'], ['scan', 'Scan'], ['places', 'Places'], ['settings', 'Settings']];

// ---------- theme ----------
function applyTheme() {
  const t = LS.get('theme', 'auto');
  if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name=theme-color]').content = dark ? '#0c0d10' : '#f4f5f7';
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

// ---------- helpers ----------
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const btn = (label, cls, onClick, extra = {}) => h('button', { class: 'btn ' + cls, onClick, type: 'button', ...extra }, label);
const field = (label, input) => h('label', { class: 'field' }, h('span', { class: 'field-l' }, label), input);
const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const daysUntil = (d) => { // whole calendar days from today (0 = today, negative = past)
  if (!d) return null;
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.round((new Date(d + 'T00:00:00') - t) / 864e5);
};
const money = (n) => new Intl.NumberFormat(undefined, { style: 'currency', currency: LS.get('currency', 'USD'), maximumFractionDigits: 0 }).format(n);

// places form a tree via parentId; the "path" is what users see ("Garage › Shelf 2")
const byId = (id) => S.locs.find((l) => l.id === id);
function pathOf(id) {
  const parts = []; let c = byId(id), n = 0;
  while (c && n++ < 12) { parts.unshift(c.name); c = c.parentId ? byId(c.parentId) : null; }
  return parts.join(' › ');
}
const childrenOf = (pid) => S.locs.filter((l) => (l.parentId || '') === (pid || '')).sort((a, b) => a.name.localeCompare(b.name));
function descIds(id) {
  const out = new Set([id]);
  for (let grew = true; grew;) { grew = false; for (const l of S.locs) if (l.parentId && out.has(l.parentId) && !out.has(l.id)) { out.add(l.id); grew = true; } }
  return out;
}
const sortedLocs = () => S.locs.map((l) => ({ l, p: pathOf(l.id) })).sort((a, b) => a.p.localeCompare(b.p));

function placeSelect(value, { allowNone = true, exclude = null, none = 'No place yet' } = {}) {
  const ex = exclude ? descIds(exclude) : new Set();
  const s = h('select', { class: 'input' }, allowNone ? h('option', { value: '' }, none) : null,
    sortedLocs().filter(({ l }) => !ex.has(l.id)).map(({ l, p }) => h('option', { value: l.id }, p)));
  s.value = value || '';
  return s;
}

async function saveItem(it) {
  await DB.putRec('items', it.id, it, S.key);
  const i = S.items.findIndex((x) => x.id === it.id);
  if (i >= 0) S.items[i] = it; else S.items.unshift(it);
}
async function saveLoc(l) {
  await DB.putRec('locs', l.id, l, S.key);
  const i = S.locs.findIndex((x) => x.id === l.id);
  if (i >= 0) S.locs[i] = l; else S.locs.push(l);
}
async function deleteItem(id) { await DB.delRec('items', id); S.items = S.items.filter((x) => x.id !== id); }

// Changing an item's place keeps a short, readable history of where it has been.
async function moveItem(it, to, extra = {}) {
  if ((it.locationId || '') === (to || '')) return saveItem({ ...it, ...extra }).then(() => ({ ...it, ...extra }));
  const history = [...(it.history || []), { from: pathOf(it.locationId), to: pathOf(to), at: Date.now() }].slice(-20);
  const n = { ...it, ...extra, locationId: to || '', history };
  await saveItem(n);
  return n;
}

async function fileToJpeg(file, max = 1100, q = 0.7) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); bmp.close?.();
  return c.toDataURL('image/jpeg', q);
}

function pickFile(accept, onFile) {
  const input = h('input', { type: 'file', accept, class: 'hidden', tabindex: '-1' });
  const end = () => setTimeout(() => { S.pickerOpen = false; input.remove(); }, 800);
  input.addEventListener('change', async () => { end(); if (input.files[0]) onFile(input.files[0]); });
  input.addEventListener('cancel', end);
  document.body.append(input); S.pickerOpen = true; input.click();
}

function addPlaceSheet(onDone, parentId = '') {
  sheet('New place', (close) => {
    const name = h('input', { class: 'input', placeholder: 'e.g. Top drawer', maxlength: 60, autocomplete: 'off' });
    const parent = placeSelect(parentId, { none: 'Top level (no parent)' });
    const go = async () => {
      const n = name.value.trim();
      if (!n) return name.focus();
      const l = { id: crypto.randomUUID(), name: n, parentId: parent.value };
      await saveLoc(l); close(); onDone?.(l); toast('Place added');
    };
    name.addEventListener('keydown', (e) => e.key === 'Enter' && go());
    setTimeout(() => name.focus(), 300);
    return [field('Name', name), field('Inside', parent), btn('Add place', 'primary', go)];
  });
}

// ---------- lock / unlock ----------
function lock() {
  if (S.busy || S.pickerOpen || !S.key) return;
  S.key = null; S.items = []; S.locs = []; S.cfg = {}; S.q = '';
  document.querySelectorAll('.sheet,.scrim,.toast').forEach((n) => n.remove());
  renderLock();
}

async function finishUnlock(key) {
  S.key = key;
  S.items = (await DB.allRecs('items', S.key)).sort((a, b) => b.added - a.added);
  S.locs = await DB.allRecs('locs', S.key);
  S.cfg = (await DB.getCfg(S.key)) || {};
  S.hasPasskey = !!(await DB.getMeta())?.passkey;
  navigator.storage?.persist?.();
  S.tab = S.items.length ? 'find' : 'scan'; S.nav = '';
  renderShell();
}

async function renderLock() {
  const meta = await DB.getMeta();
  const first = !meta;
  const pass = h('input', { class: 'input', type: 'password', autocomplete: first ? 'new-password' : 'current-password',
    placeholder: first ? 'Create a passcode' : 'Passcode', 'aria-label': 'Passcode' });
  const pass2 = first ? h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'Confirm passcode', 'aria-label': 'Confirm passcode' }) : null;
  const msg = h('p', { class: 'msg', role: 'alert' });
  const go = h('button', { class: 'btn primary', type: 'submit' }, first ? 'Create vault' : 'Unlock');
  const face = !first && meta.passkey && PK.supported() ? h('button', { class: 'btn ghost', type: 'button', onClick: async () => {
    msg.textContent = '';
    try {
      S.pickerOpen = true;
      const prf = await PK.evalPrf(unb64(meta.passkey.credId), unb64(meta.passkey.salt));
      await finishUnlock(await DB.unlockWithPrf(prf));
    } catch { msg.textContent = 'Face ID unlock did not work. Use your passcode.'; }
    setTimeout(() => { S.pickerOpen = false; }, 800);
  } }, 'Unlock with Face ID') : null;
  const form = h('form', { class: 'lock-card glass', onSubmit: async (e) => {
    e.preventDefault(); msg.textContent = '';
    go.disabled = true;
    try {
      let key;
      if (first) {
        if (pass.value.length < 8) throw new Error('Use at least 8 characters. A short phrase works well.');
        if (pass.value !== pass2.value) throw new Error('Passcodes do not match.');
        msg.textContent = 'Securing…';
        key = await DB.createVault(pass.value);
      } else {
        msg.textContent = 'Unlocking…';
        const r = await DB.unlockVault(pass.value);
        if (r.wait && !r.key) throw new Error(`Too many attempts. Try again in ${r.wait}s.`);
        if (!r.key) throw new Error('Incorrect passcode.');
        key = r.key;
      }
      pass.value = ''; if (pass2) pass2.value = '';
      await finishUnlock(key);
    } catch (err) { msg.textContent = err.message; form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake'); }
    go.disabled = false;
  } },
  h('div', { class: 'lock-ico' }, icon('lock', 'ico big')),
  h('h1', {}, 'Stuff Finder'),
  h('p', { class: 'sub' }, first ? 'Your catalogue is encrypted on this device with a passcode only you know. There is no recovery, so keep it safe.' : 'Enter your passcode to unlock.'),
  pass, pass2, msg, go, face);
  // iOS keeps a browser tab's storage separate from the installed app's, so a vault made in a tab won't appear in the app.
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const installed = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  const notice = ios && !installed ? h('div', { class: 'notice', role: 'note' }, h('b', {}, 'Install before you start. '),
    'This is a browser tab, which keeps its own separate storage. Tap Share → Add to Home Screen, then open Stuff Finder from its icon. A passcode created here will not carry over.') : null;
  const persisted = await navigator.storage?.persisted?.().catch(() => null);
  const diag = h('p', { class: 'diag' }, `${installed ? 'Installed app' : 'Browser tab'} · ${first ? 'no vault yet' : 'vault found'} · storage ${persisted ? 'protected' : 'not protected'} · launch ${LS.get('launches', '1')}`);
  app.replaceChildren(h('div', { class: 'lock-wrap' }, h('div', { class: 'lock-col' }, notice, form, diag)));
  setTimeout(() => pass.focus(), 250);
}

// ---------- shell ----------
function renderShell() {
  const view = h('main', { id: 'view', tabindex: '-1' });
  const nav = h('nav', { class: 'tabbar glass', 'aria-label': 'Main' }, h('div', { class: 'ind' }),
    TABS.map(([id, label]) => h('button', { class: 'tab', type: 'button', 'data-tab': id, 'aria-label': label, onClick: () => go(id) }, icon(id), h('span', {}, label))));
  app.replaceChildren(view, nav);
  go(S.tab, true);
}

function go(tab, instant) {
  S.tab = tab;
  const idx = TABS.findIndex(([id]) => id === tab);
  const nav = document.querySelector('.tabbar');
  nav.style.setProperty('--i', idx);
  nav.querySelectorAll('.tab').forEach((b) => { const on = b.dataset.tab === tab; b.classList.toggle('on', on); b.setAttribute('aria-current', on ? 'page' : 'false'); });
  const view = document.getElementById('view');
  const keep = instant ? view.scrollTop : 0;
  const fresh = { find: renderFind, scan: renderScan, places: renderPlaces, settings: renderSettings }[tab]();
  view.replaceChildren(fresh);
  view.className = instant ? '' : 'enter';
  void view.offsetWidth; view.classList.add('enter');
  view.scrollTo(0, keep);
}

const header = (title, right, sub) => h('header', { class: 'head' }, h('div', {}, h('h1', {}, title), sub ? h('p', { class: 'head-sub' }, sub) : null), right);
const section = (label) => h('h3', { class: 'sec' }, label);

// ---------- Find ----------
function itemRow(it, onOpen) {
  const place = pathOf(it.locationId);
  const dw = daysUntil(it.warranty);
  const late = it.lent?.due && daysUntil(it.lent.due) < 0;
  const sub = it.lent
    ? h('div', { class: 'row-sub lent' + (late ? ' late' : '') }, icon('user', 'ico sm'), `Lent to ${it.lent.to}` + (it.lent.due ? ` · ${late ? 'overdue' : 'due ' + fmtDate(it.lent.due + 'T12:00:00')}` : ''))
    : h('div', { class: 'row-sub ' + (place ? 'where' : 'none') }, icon('places', 'ico sm'), place || 'No place set');
  return h('div', { class: 'row item glass' },
    h('button', { class: 'row-hit', type: 'button', onClick: () => onOpen(it) },
      it.thumb ? h('img', { class: 'thumb', src: it.thumb, alt: '' }) : h('div', { class: 'thumb ph' }, icon('box')),
      h('div', { class: 'row-main' },
        h('div', { class: 'row-title' }, it.name, it.count > 1 ? h('span', { class: 'badge' }, '×' + it.count) : null,
          dw != null && dw >= 0 && dw <= 60 ? h('span', { class: 'badge warn' }, `Warranty ${dw}d`) : null),
        sub)),
    h('button', { class: 'mv', type: 'button', 'aria-label': `Move ${it.name}`, onClick: () => moveSheet(it) }, icon('move', 'ico sm')));
}

function renderFind() {
  const list = h('div', { class: 'list' });
  const draw = () => {
    const q = S.q.trim().toLowerCase();
    const res = S.items.filter((i) => {
      if (S.filter === 'lent' && !i.lent) return false;
      if (S.filter === 'warranty') { const d = daysUntil(i.warranty); if (d == null || d > 90) return false; }
      return !q || [i.name, i.label, i.note, i.serial, i.lent?.to, pathOf(i.locationId)].some((t) => (t || '').toLowerCase().includes(q));
    });
    list.replaceChildren(...(res.length ? res.map((i) => itemRow(i, itemSheet)) : [
      h('div', { class: 'empty' }, icon('find', 'ico big'), h('p', {}, S.items.length ? 'Nothing matches.' : 'Nothing catalogued yet. Scan a photo or video to begin.'))]));
  };
  const chips = h('div', { class: 'chips' }, [['all', 'All'], ['lent', 'Lent out'], ['warranty', 'Warranty']].map(([v, l]) =>
    h('button', { class: 'chip' + (S.filter === v ? ' on' : ''), type: 'button', 'data-v': v, onClick: () => {
      S.filter = v; chips.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c.dataset.v === v)); draw(); } }, l)));
  const search = h('input', { class: 'input search', type: 'search', placeholder: 'Search your things…', value: S.q, 'aria-label': 'Search items',
    onInput: (e) => { S.q = e.target.value; draw(); } });
  draw();
  const total = S.items.reduce((s, i) => s + (Number(i.price) || 0), 0);
  const sub = `${plural(S.items.length, 'item')} · ${plural(S.locs.length, 'place')}` + (total ? ` · ${money(total)}` : '');
  return h('section', {}, header('Find', btn(icon('plus'), 'round glass', () => manualSheet(), { 'aria-label': 'Add item manually' }), sub),
    h('div', { class: 'searchwrap glass' }, icon('find', 'ico sm'), search), chips, list);
}

function moveSheet(it) {
  sheet('Move item', (close) => {
    const place = placeSelect(it.locationId);
    return [h('p', { class: 'sub tight' }, `${it.name} is ${pathOf(it.locationId) ? 'in ' + pathOf(it.locationId) : 'not in a place yet'}.`),
      field('Move to', place),
      btn('Move', 'primary', async () => { await moveItem(it, place.value); close(); go(S.tab, true); toast('Moved'); })];
  });
}

// The item's place photo with the item outlined, so you can see exactly where to look.
function ctxView(it) {
  if (!it.ctx) return it.thumb ? h('img', { class: 'hero', src: it.thumb, alt: '' }) : null;
  const mark = h('i', { class: 'mark' });
  const b = it.ctx.box;
  for (const k of ['x', 'y', 'w', 'h']) mark.style.setProperty('--' + k, b[k]);
  return h('div', { class: 'ctx' }, h('img', { src: it.ctx.img, alt: `Where ${it.name} was seen` }), mark);
}

function itemSheet(it) {
  sheet(it.name, (close) => {
    const name = h('input', { class: 'input', value: it.name, maxlength: 80 });
    const place = placeSelect(it.locationId);
    const note = h('textarea', { class: 'input', rows: 2, maxlength: 300, placeholder: 'Optional note' }); note.value = it.note || '';
    const price = h('input', { class: 'input', type: 'number', inputmode: 'decimal', min: '0', step: '0.01', placeholder: '0.00', value: it.price ?? '' });
    const bought = h('input', { class: 'input', type: 'date', value: it.purchased || '' });
    const warranty = h('input', { class: 'input', type: 'date', value: it.warranty || '' });
    const serial = h('input', { class: 'input', placeholder: 'Serial number', maxlength: 60, value: it.serial || '' });
    let receipt = it.receipt || '';
    const rbox = h('div', { class: 'rcpt' });
    const drawReceipt = () => rbox.replaceChildren(receipt
      ? h('div', { class: 'rcpt-has' }, h('img', { src: receipt, alt: 'Receipt' }), btn('Remove', 'danger', () => { receipt = ''; drawReceipt(); }))
      : btn([icon('photo', 'ico sm'), ' Add receipt photo'], 'ghost', () => pickFile('image/*', async (f) => { receipt = await fileToJpeg(f, 1200, 0.72); drawReceipt(); })));
    drawReceipt();

    const hasMore = it.price != null || it.purchased || it.warranty || it.serial || it.receipt;
    const more = h('details', { class: 'more', open: hasMore ? true : null }, h('summary', {}, 'Value & warranty'),
      h('div', { class: 'two' }, field('Price paid', price), field('Purchased', bought)),
      h('div', { class: 'two' }, field('Warranty ends', warranty), field('Serial', serial)), rbox);

    // lending
    const lendBox = h('div', { class: 'lend' });
    if (it.lent) {
      lendBox.append(h('p', { class: 'sub tight' }, `Lent to ${it.lent.to} on ${fmtDate(it.lent.at)}` + (it.lent.due ? `, due ${fmtDate(it.lent.due + 'T12:00:00')}` : '') + '.'),
        btn('Mark returned', 'ghost', async () => { await saveItem({ ...it, lent: null }); close(); go(S.tab, true); toast('Welcome back'); }));
    } else {
      const who = h('input', { class: 'input', placeholder: 'Lent to…', maxlength: 60 });
      const due = h('input', { class: 'input', type: 'date', 'aria-label': 'Due date' });
      lendBox.append(h('div', { class: 'two' }, field('Lend to', who), field('Due (optional)', due)),
        btn([icon('user', 'ico sm'), ' Lend out'], 'ghost', async () => {
          if (!who.value.trim()) return who.focus();
          await saveItem({ ...it, lent: { to: who.value.trim(), due: due.value, at: Date.now() } }); close(); go(S.tab, true); toast('Marked as lent');
        }));
    }

    const hist = (it.history || []).slice(-5).reverse();
    let armed = false;
    const del = btn('Delete', 'danger', async () => {
      if (!armed) { armed = true; del.textContent = 'Tap again to delete'; return; }
      await deleteItem(it.id); close(); go(S.tab, true); toast('Deleted');
    });
    return [ctxView(it), field('Name', name), field('Where is it?', place), field('Note', note), more,
      h('h3', { class: 'sec' }, 'Lending'), lendBox,
      hist.length ? [h('h3', { class: 'sec' }, 'Where it has been'), h('ul', { class: 'hist' }, hist.map((e) =>
        h('li', {}, h('span', {}, `${e.from || 'No place'} → ${e.to || 'No place'}`), h('time', {}, fmtDate(e.at)))))] : null,
      h('div', { class: 'btnrow' }, del, btn('Save', 'primary', async () => {
        const next = { ...it, name: name.value.trim() || it.name, note: note.value.trim(), price: price.value === '' ? null : Number(price.value),
          purchased: bought.value, warranty: warranty.value, serial: serial.value.trim(), receipt };
        await moveItem(next, place.value); close(); go(S.tab, true); toast('Saved');
      }))];
  });
}

function manualSheet() {
  sheet('Add item', (close) => {
    const name = h('input', { class: 'input', placeholder: 'e.g. Passport', maxlength: 80 });
    const place = placeSelect(S.curLoc);
    setTimeout(() => name.focus(), 300);
    return [field('Name', name), field('Where is it?', place), btn('Add', 'primary', async () => {
      if (!name.value.trim()) return name.focus();
      await saveItem({ id: crypto.randomUUID(), name: name.value.trim(), label: name.value.trim().toLowerCase(), count: 1, thumb: '', locationId: place.value, note: '', added: Date.now(), history: [] });
      close(); go('find'); toast('Added');
    })];
  });
}

// ---------- Scan ----------
const useClaude = () => LS.get('mode', 'device') === 'claude' && !!S.cfg.apiKey;

function renderScan() {
  const place = placeSelect(S.curLoc);
  place.addEventListener('change', () => { S.curLoc = place.value; });
  const sw = h('button', { class: 'switch', type: 'button', role: 'switch', 'aria-checked': String(S.reconcile), 'aria-label': 'Reconcile this place',
    onClick: () => { S.reconcile = !S.reconcile; sw.setAttribute('aria-checked', String(S.reconcile)); } }, h('i', {}));
  const status = h('p', { class: 'sub status' });
  const input = h('input', { type: 'file', accept: 'image/*,video/*', multiple: true, class: 'hidden', 'aria-hidden': 'true', tabindex: '-1' });
  const bigBtn = h('button', { class: 'capture', type: 'button', onClick: () => {
    if (S.reconcile && !S.curLoc) return toast('Choose a place to reconcile');
    S.pickerOpen = true; input.click();
  } }, h('span', { class: 'ring' }), icon('cam', 'ico big'), h('span', {}, 'Photo or video'));
  const endPick = () => { setTimeout(() => { S.pickerOpen = false; }, 800); };
  input.addEventListener('cancel', endPick);
  input.addEventListener('change', async () => {
    endPick();
    const files = [...input.files]; input.value = '';
    if (!files.length) return;
    S.busy = true; bigBtn.disabled = true; bigBtn.classList.add('working');
    try {
      const onStatus = (t) => { status.textContent = t; };
      const found = useClaude()
        ? await scanWithClaude(files, { apiKey: S.cfg.apiKey, model: S.cfg.model || CLAUDE_MODELS[0][0], onStatus })
        : await scanFiles(files, { onStatus });
      status.textContent = '';
      reviewSheet(found);
    } catch (e) { status.textContent = 'Could not analyse that: ' + e.message; }
    S.busy = false; bigBtn.disabled = false; bigBtn.classList.remove('working');
  });
  return h('section', {}, header('Scan'),
    h('div', { class: 'card glass' }, field('Where are you?', h('div', { class: 'inline' }, place, btn(icon('plus'), 'round glass', () => addPlaceSheet((l) => { S.curLoc = l.id; go('scan', true); }, S.curLoc), { 'aria-label': 'New place' }))),
      h('div', { class: 'switchrow' }, h('div', {}, h('div', { class: 'row-title' }, 'Reconcile this place'),
        h('div', { class: 'hint' }, 'Compare the scan with what is catalogued here: spot new, moved and missing items.')), sw)),
    h('div', { class: 'card glass' }, h('h3', {}, 'Recognition'),
      seg([['device', 'On-device'], ['claude', 'Claude (cloud)']], useClaude() ? 'claude' : 'device', (v) => setMode(v)),
      h('p', { class: 'hint' }, useClaude()
        ? 'Claude mode sends the frames you scan to Anthropic for analysis. Recognises almost anything.'
        : 'Analysis runs entirely on this phone. Recognises 80 common object types.')),
    h('div', { class: 'center' }, bigBtn, status, input),
    h('p', { class: 'hint c' }, 'Photos are not kept as files. Each item stores a small thumbnail and one reduced photo of where it was seen, encrypted. People are ignored.'));
}

function reviewRow({ thumb, name, sub, keep }) {
  const row = h('div', { class: 'row flat' }, thumb ? h('img', { class: 'thumb', src: thumb, alt: '' }) : h('div', { class: 'thumb ph' }, icon('box')));
  const main = h('div', { class: 'row-main' });
  if (name.editable) { const i = h('input', { class: 'input slim', value: name.value, maxlength: 80, 'aria-label': 'Item name' }); i.addEventListener('input', () => { name.value = i.value; }); main.append(i); }
  else main.append(h('div', { class: 'row-title' }, name.value));
  main.append(h('div', { class: 'row-sub none' }, sub));
  row.append(main);
  if (keep) {
    const chk = h('button', { class: 'check' + (keep.on ? ' on' : ''), type: 'button', role: 'checkbox', 'aria-checked': String(keep.on), 'aria-label': 'Include' }, icon('check'));
    chk.addEventListener('click', () => { keep.on = !keep.on; chk.classList.toggle('on', keep.on); chk.setAttribute('aria-checked', String(keep.on)); });
    row.append(chk);
  }
  return row;
}

const newItem = (f, place) => ({ id: crypto.randomUUID(), name: f.name.trim(), label: f.label, count: f.count, thumb: f.thumb, ctx: f.ctx || null,
  locationId: place, note: '', added: Date.now(), lastSeen: Date.now(), history: [] });
const seenInfo = (f) => (f.score == null ? `×${f.count} · via Claude` : `×${f.count} · ${Math.round(f.score * 100)}% sure`);

function reviewSheet(found) {
  if (S.reconcile && S.curLoc) return reconcileSheet(found, S.curLoc);
  sheet(found.length ? `Found ${found.length} item${found.length > 1 ? 's' : ''}` : 'Nothing recognised', (close) => {
    if (!found.length) return [h('p', { class: 'sub' }, 'Try a closer, brighter shot, switch to Claude mode for wider recognition, or add items by hand with the + on Find.'), btn('Done', 'primary', close)];
    const items = found.map((f) => ({ f, keep: { on: true }, name: { value: f.name, editable: true } }));
    const place = placeSelect(S.curLoc);
    return [field('File under', place), h('div', { class: 'list tight' }, items.map((x) => reviewRow({ thumb: x.f.thumb, name: x.name, sub: seenInfo(x.f), keep: x.keep }))),
      btn('Save to catalogue', 'primary', async () => {
        let n = 0;
        for (const x of items.filter((y) => y.keep.on && y.name.value.trim())) {
          const f = { ...x.f, name: x.name.value };
          const ex = S.items.find((i) => i.label === f.label && i.locationId === place.value);
          if (ex) await saveItem({ ...ex, count: Math.max(ex.count, f.count), thumb: f.thumb || ex.thumb, ctx: f.ctx || ex.ctx, lastSeen: Date.now() });
          else await saveItem(newItem(f, place.value));
          n++;
        }
        S.curLoc = place.value; close(); go('find'); toast(`${n} saved`);
      })];
  });
}

// Compare a fresh scan with what the catalogue says is in this place.
function reconcileSheet(found, placeId) {
  const mine = S.items.filter((i) => i.locationId === placeId);
  const claimed = new Set();
  const same = [], moved = [], fresh = [];
  for (const f of found) {
    const m = mine.find((i) => i.label === f.label && !claimed.has(i.id));
    if (m) { claimed.add(m.id); same.push({ f, m }); continue; }
    const o = S.items.find((i) => i.label === f.label && i.locationId !== placeId && !i.lent);
    if (o) moved.push({ f, o, keep: { on: true } }); else fresh.push({ f, keep: { on: true }, name: { value: f.name, editable: true } });
  }
  const missing = mine.filter((i) => !claimed.has(i.id) && !i.lent).map((m) => ({ m, keep: { on: false } }));
  sheet(`Reconcile: ${pathOf(placeId)}`, (close) => {
    const blocks = [];
    const add = (label, rows) => { if (rows.length) blocks.push(section(label), h('div', { class: 'list tight' }, rows)); };
    add(`New here (${fresh.length})`, fresh.map((x) => reviewRow({ thumb: x.f.thumb, name: x.name, sub: seenInfo(x.f), keep: x.keep })));
    add(`Moved here (${moved.length})`, moved.map((x) => reviewRow({ thumb: x.f.thumb, name: { value: x.o.name }, sub: `was in ${pathOf(x.o.locationId) || 'no place'}`, keep: x.keep })));
    add(`Still here (${same.length})`, same.map((x) => reviewRow({ thumb: x.m.thumb || x.f.thumb, name: { value: x.m.name }, sub: 'Confirmed' })));
    add(`Not seen (${missing.length})`, missing.map((x) => reviewRow({ thumb: x.m.thumb, name: { value: x.m.name }, sub: 'Tick to remove from catalogue', keep: x.keep })));
    if (!blocks.length) blocks.push(h('p', { class: 'sub' }, 'Nothing recognised and nothing catalogued here yet.'));
    return [...blocks, btn('Apply', 'primary', async () => {
      const now = Date.now();
      for (const x of fresh.filter((y) => y.keep.on && y.name.value.trim())) await saveItem(newItem({ ...x.f, name: x.name.value }, placeId));
      for (const x of moved.filter((y) => y.keep.on)) await moveItem(x.o, placeId, { thumb: x.f.thumb || x.o.thumb, ctx: x.f.ctx || x.o.ctx, lastSeen: now });
      for (const x of same) await saveItem({ ...x.m, count: Math.max(x.m.count, x.f.count), thumb: x.f.thumb || x.m.thumb, ctx: x.f.ctx || x.m.ctx, lastSeen: now });
      for (const x of missing.filter((y) => y.keep.on)) await deleteItem(x.m.id);
      close(); go('places'); toast('Place reconciled');
    })];
  });
}

// ---------- Recognition mode ----------
function setMode(v) {
  if (v === 'device') { LS.set('mode', 'device'); return go('scan', true); }
  if (!S.cfg.apiKey) { toast('Add your Claude API key in Settings first'); return go('scan', true); }
  if (LS.get('consent', '') === '1') { LS.set('mode', 'claude'); return go('scan', true); }
  sheet('Use Claude for recognition?', (close) => [
    h('p', { class: 'sub' }, 'In this mode, the frames you scan (downscaled JPEGs) are sent over HTTPS directly from your phone to Anthropic’s API, using your key. They are not sent anywhere else.'),
    h('p', { class: 'sub' }, 'Anything visible in the frame goes with it, so avoid scanning documents, screens or rooms you would not want shared. Anthropic’s data policy then applies. On-device mode never sends anything.'),
    h('div', { class: 'btnrow' }, btn('Keep on-device', 'ghost', () => { close(); go('scan', true); }),
      btn('I understand', 'primary', () => { LS.set('consent', '1'); LS.set('mode', 'claude'); close(); go('scan', true); }))]);
}

// ---------- Places (nested, with breadcrumbs) ----------
function renderPlaces() {
  if (S.nav && !byId(S.nav)) S.nav = '';
  const cur = S.nav;
  const ids = (id) => descIds(id);
  const countIn = (id) => { const s = ids(id); return S.items.filter((i) => s.has(i.locationId)).length; };
  const kids = childrenOf(cur);
  const here = S.items.filter((i) => (i.locationId || '') === cur);

  const trail = [];
  for (let c = cur ? byId(cur) : null, n = 0; c && n++ < 12; c = c.parentId ? byId(c.parentId) : null) trail.unshift(c);
  const crumbs = cur ? h('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' },
    h('button', { class: 'crumb', type: 'button', onClick: () => { S.nav = ''; go('places', true); } }, 'All places'),
    trail.map((c, i) => [h('span', { class: 'sep', 'aria-hidden': 'true' }, '›'),
      i === trail.length - 1 ? h('span', { class: 'crumb cur' }, c.name) : h('button', { class: 'crumb', type: 'button', onClick: () => { S.nav = c.id; go('places', true); } }, c.name)])) : null;

  const placeRows = kids.map((l) => {
    const n = childrenOf(l.id).length;
    return h('button', { class: 'row glass', type: 'button', onClick: () => { S.nav = l.id; go('places', true); } },
      h('div', { class: 'thumb ph' }, icon('places')),
      h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, l.name),
        h('div', { class: 'row-sub none' }, plural(countIn(l.id), 'item') + (n ? ` · ${plural(n, 'sub-place')}` : ''))));
  });
  const right = h('div', { class: 'actions' },
    cur ? btn(icon('settings'), 'round glass', () => placeSheet(byId(cur)), { 'aria-label': 'Edit place' }) : null,
    btn(icon('plus'), 'round glass', () => addPlaceSheet(() => go('places', true), cur), { 'aria-label': cur ? 'Add sub-place' : 'Add place' }));
  const title = cur ? byId(cur).name : 'Places';
  const sub = cur ? `${plural(kids.length, 'sub-place')} · ${plural(here.length, 'item')} here` : plural(S.locs.length, 'place');
  const out = [header(title, right, sub), crumbs];
  if (kids.length) out.push(cur ? section('Places inside') : null, h('div', { class: 'list' }, placeRows));
  if (here.length) out.push(section(cur ? 'Items here' : 'Not in a place yet'), h('div', { class: 'list' }, here.map((i) => itemRow(i, itemSheet))));
  if (!kids.length && !here.length) out.push(h('div', { class: 'list' }, h('div', { class: 'empty' }, icon('places', 'ico big'),
    h('p', {}, cur ? 'Nothing here yet. Add a sub-place like “Top drawer”, or scan this spot.' : 'Add places like “Kitchen”, then nest them: “Kitchen › Top drawer”.'))));
  return h('section', {}, out);
}

function placeSheet(l) {
  sheet(l.name, (close) => {
    const name = h('input', { class: 'input', value: l.name, maxlength: 60 });
    const parent = placeSelect(l.parentId, { none: 'Top level (no parent)', exclude: l.id });
    let armed = false;
    const del = btn('Delete place', 'danger', async () => {
      if (!armed) { armed = true; del.textContent = 'Tap again (contents move up a level)'; return; }
      const up = l.parentId || '';
      for (const c of childrenOf(l.id)) await saveLoc({ ...c, parentId: up });
      for (const i of S.items.filter((x) => x.locationId === l.id)) await saveItem({ ...i, locationId: up });
      await DB.delRec('locs', l.id); S.locs = S.locs.filter((x) => x.id !== l.id);
      if (S.curLoc === l.id) S.curLoc = up;
      S.nav = up; close(); go('places', true); toast('Place deleted');
    });
    return [field('Name', name), field('Inside', parent),
      h('div', { class: 'btnrow' }, del, btn('Save', 'primary', async () => {
        await saveLoc({ ...l, name: name.value.trim() || l.name, parentId: parent.value }); close(); go('places', true);
      }))];
  });
}

// ---------- Settings ----------
function seg(options, current, onPick) {
  const wrap = h('div', { class: 'seg', role: 'radiogroup' });
  options.forEach(([v, label]) => wrap.append(h('button', { class: 'segb' + (String(v) === String(current) ? ' on' : ''), type: 'button', role: 'radio', 'aria-checked': String(v) === String(current),
    onClick: () => { onPick(v); wrap.querySelectorAll('.segb').forEach((b) => b.classList.remove('on')); wrap.querySelector(`[data-v="${v}"]`).classList.add('on'); }, 'data-v': v }, label)));
  return wrap;
}

function renderSettings() {
  const file = h('input', { type: 'file', accept: 'application/json,.json', class: 'hidden', tabindex: '-1' });
  file.addEventListener('change', async () => {
    const f = file.files[0]; file.value = ''; S.pickerOpen = false;
    if (!f) return;
    try {
      await DB.importBackup(await f.text());
      S.key = null; S.items = []; S.locs = []; toast('Backup restored. Unlock with its passcode.'); renderLock();
    } catch (e) { toast(e.message); }
  });
  let armed = false;
  const erase = btn('Erase everything', 'danger', async () => {
    if (!armed) { armed = true; erase.textContent = 'Tap again to permanently erase'; return; }
    await DB.wipe(); S.key = null; S.items = []; S.locs = []; renderLock();
  });
  const cur = h('select', { class: 'input', 'aria-label': 'Currency', onChange: (e) => { LS.set('currency', e.target.value); } },
    ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF'].map((c) => h('option', { value: c }, c)));
  cur.value = LS.get('currency', 'USD');
  return h('section', {}, header('Settings'),
    h('div', { class: 'card glass' }, h('h3', {}, 'Appearance'),
      seg([['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']], LS.get('theme', 'auto'), (v) => { LS.set('theme', v); applyTheme(); }),
      field('Currency for item values', cur)),
    h('div', { class: 'card glass' }, h('h3', {}, 'Auto-lock'), h('p', { class: 'hint' }, 'Locks after the app is in the background this long, or after 5 minutes idle.'),
      seg([[0, 'Instantly'], [30, '30s'], [60, '1 min'], [300, '5 min']], LS.get('lock', '60'), (v) => LS.set('lock', v))),
    faceCard(), claudeCard(),
    h('div', { class: 'card glass' }, h('h3', {}, 'Security'),
      btn([icon('lock', 'ico sm'), ' Lock now'], 'ghost', () => { S.busy = S.pickerOpen = false; lock(); }),
      btn('Change passcode', 'ghost', changePassSheet)),
    h('div', { class: 'card glass' }, h('h3', {}, 'Backup'), h('p', { class: 'hint' }, 'Backups stay encrypted and need your passcode. iOS can clear web data if storage runs low, so export now and then.'),
      btn('Export encrypted backup', 'ghost', exportBackup),
      btn('Restore from backup', 'ghost', () => { S.pickerOpen = true; file.click(); }), file),
    h('div', { class: 'card glass' }, h('h3', {}, 'Privacy'),
      h('p', { class: 'hint' }, 'Everything is encrypted with AES-256-GCM. The vault key is wrapped by your passcode (PBKDF2, 600,000 rounds) and lives in memory only while unlocked. On-device detection makes no network requests; Claude mode, if you enable it, sends scanned frames to Anthropic.'), erase));
}

function faceCard() {
  if (!PK.supported()) return null;
  return h('div', { class: 'card glass' }, h('h3', {}, 'Face ID unlock'),
    h('p', { class: 'hint' }, 'Unlock with a passkey stored on this device instead of typing your passcode. Your passcode keeps working. Needs a recent iOS (18 or later).'),
    S.hasPasskey
      ? btn('Turn off Face ID unlock', 'danger', async () => { await DB.removePasskey(); S.hasPasskey = false; go('settings', true); toast('Face ID unlock off'); })
      : btn('Turn on Face ID unlock', 'ghost', faceSheet));
}

function faceSheet() {
  sheet('Turn on Face ID unlock', (close) => {
    const pass = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', placeholder: 'Confirm your passcode' });
    const msg = h('p', { class: 'msg', role: 'alert' });
    return [h('p', { class: 'sub tight' }, 'Confirm your passcode, then approve the Face ID prompt to create the passkey.'), pass, msg, btn('Continue', 'primary', async () => {
      msg.textContent = '';
      let raw;
      try { raw = await DB.masterRaw(pass.value); } catch { return (msg.textContent = 'Incorrect passcode.'); }
      try {
        S.pickerOpen = true;
        await DB.savePasskey(raw, await PK.createPasskey());
        S.hasPasskey = true; close(); go('settings', true); toast('Face ID unlock on');
      } catch (e) { msg.textContent = e.name === 'NotAllowedError' ? 'Cancelled.' : e.message; }
      setTimeout(() => { S.pickerOpen = false; }, 800);
    })];
  });
}

function claudeCard() {
  const has = !!S.cfg.apiKey;
  const keyIn = h('input', { class: 'input', type: 'password', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
    placeholder: has ? 'Key saved (enter a new one to replace)' : 'sk-ant-…', 'aria-label': 'Claude API key' });
  const save = async (patch) => { S.cfg = { ...S.cfg, ...patch }; await DB.putCfg(S.cfg, S.key); };
  return h('div', { class: 'card glass' }, h('h3', {}, 'Claude (optional)'),
    h('p', { class: 'hint' }, 'Add your own Anthropic API key to recognise almost any item. The key is stored encrypted in your vault and only ever sent to api.anthropic.com. Scans in Claude mode leave this device.'),
    keyIn,
    btn(has ? 'Replace key' : 'Save key', 'ghost', async () => {
      const k = keyIn.value.trim();
      if (!/^sk-ant-[\w-]{20,}$/.test(k)) return toast('That does not look like an Anthropic key');
      await save({ apiKey: k, model: S.cfg.model || CLAUDE_MODELS[0][0] }); keyIn.value = ''; toast('Key saved'); go('settings', true);
    }),
    has ? [h('div', { class: 'field-l' }, 'Model'),
      seg(CLAUDE_MODELS.map(([v, l]) => [v, l.split(' ')[0]]), S.cfg.model || CLAUDE_MODELS[0][0], (v) => save({ model: v })),
      btn('Remove key', 'danger', async () => { await save({ apiKey: '' }); LS.set('mode', 'device'); toast('Key removed'); go('settings', true); })] : null);
}

async function exportBackup() {
  const text = await DB.exportBackup();
  const f = new File([text], `stuff-finder-backup-${new Date().toISOString().slice(0, 10)}.json`, { type: 'application/json' });
  try {
    S.pickerOpen = true;
    if (navigator.canShare?.({ files: [f] })) await navigator.share({ files: [f] });
    else { const a = h('a', { href: URL.createObjectURL(f), download: f.name }); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
  } catch { /* cancelled */ }
  setTimeout(() => { S.pickerOpen = false; }, 800);
}

function changePassSheet() {
  sheet('Change passcode', (close) => {
    const o = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', placeholder: 'Current passcode' });
    const a = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'New passcode' });
    const b = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'Confirm new passcode' });
    const msg = h('p', { class: 'msg', role: 'alert' });
    return [o, a, b, msg, btn('Change passcode', 'primary', async () => {
      if (a.value.length < 8) return (msg.textContent = 'Use at least 8 characters.');
      if (a.value !== b.value) return (msg.textContent = 'Passcodes do not match.');
      msg.textContent = 'Updating…';
      try { await DB.changePasscode(o.value, a.value); close(); toast('Passcode changed'); } catch { msg.textContent = 'Current passcode is incorrect.'; }
    })];
  });
}

// ---------- auto-lock ----------
let idle;
const arm = () => { clearTimeout(idle); if (S.key) idle = setTimeout(lock, 5 * 60 * 1000); };
['pointerdown', 'keydown', 'scroll'].forEach((e) => addEventListener(e, arm, { passive: true }));
document.addEventListener('visibilitychange', () => {
  const secs = Number(LS.get('lock', '60'));
  if (document.hidden) { S.hiddenAt = Date.now(); if (secs === 0) lock(); }
  else if (S.key && Date.now() - S.hiddenAt >= secs * 1000) lock();
});
addEventListener('pagehide', () => { if (Number(LS.get('lock', '60')) === 0) lock(); });

// ---------- boot ----------
applyTheme();
navigator.storage?.persist?.(); // ask the browser not to evict our data
LS.set('launches', String(Number(LS.get('launches', '0')) + 1)); // visible on the lock screen to diagnose storage resets
renderLock();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
