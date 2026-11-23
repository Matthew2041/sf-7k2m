// Tiny DOM helpers. Data is only ever inserted as text nodes (never innerHTML).
export function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') e.value = v;
    else if (k === 'checked') e.checked = true;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}

const P = {
  find: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/>',
  scan: '<path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3.2"/>',
  places: '<path d="M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11Z"/><circle cx="12" cy="10" r="2.5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  box: '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4 7.5 8 4.5 8-4.5M12 12v9"/>',
  move: '<path d="M4 8h14M14 4l4 4-4 4M20 16H6M10 12l-4 4 4 4"/>',
  user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  photo: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><circle cx="9" cy="11" r="1.8"/><path d="m21 16-5-4.5L8 19"/>',
  cam: '<path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z"/><circle cx="12" cy="13" r="3.5"/>',
};
export function icon(name, cls = 'ico') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const doc = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg">${P[name]}</svg>`, 'image/svg+xml');
  for (const n of [...doc.documentElement.childNodes]) svg.append(document.importNode(n, true));
  return svg;
}

export function toast(msg) {
  const t = h('div', { class: 'toast glass', role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, 2200);
}

// Bottom sheet. build(close) returns the content nodes.
export function sheet(title, build) {
  const prev = document.activeElement;
  const scrim = h('div', { class: 'scrim' });
  const panel = h('div', { class: 'sheet glass', role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
  const close = () => {
    scrim.classList.add('out'); panel.classList.add('out');
    document.removeEventListener('keydown', onKey);
    setTimeout(() => { scrim.remove(); panel.remove(); prev?.focus?.(); }, 240);
  };
  const onKey = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey);
  scrim.addEventListener('click', close);
  panel.append(h('div', { class: 'grab' }), h('h2', { class: 'sheet-title' }, title), ...[build(close)].flat(Infinity).filter(Boolean));
  document.body.append(scrim, panel);
  return { close, panel };
}
