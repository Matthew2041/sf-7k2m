// On-device object detection (YOLOS-tiny via transformers.js / ONNX Runtime Web).
// Model + runtime are served from this app's own origin; no images leave the phone.
let detectorP, RawImageRef;

async function load(onStatus) {
  const mod = await import('../vendor/transformers.min.js');
  const { pipeline, env, RawImage } = mod;
  RawImageRef = RawImage;
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = new URL('../models/', import.meta.url).href;
  env.useBrowserCache = false;
  env.backends.onnx.wasm.wasmPaths = new URL('../vendor/', import.meta.url).href;
  env.backends.onnx.wasm.numThreads = 1; // no cross-origin isolation on static hosts
  onStatus?.('Loading on-device model…');
  return pipeline('object-detection', 'Xenova/yolos-tiny', { dtype: 'q8', device: 'wasm' });
}

export const getDetector = (onStatus) => (detectorP ??= load(onStatus).catch((e) => { detectorP = undefined; throw e; }));

const IGNORE = new Set(['person']); // privacy: never catalogue people
const titleCase = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());

function crop(canvas, b) {
  const pw = (b.xmax - b.xmin) * 0.1, ph = (b.ymax - b.ymin) * 0.1;
  const x = Math.max(0, b.xmin - pw), y = Math.max(0, b.ymin - ph);
  const w = Math.min(canvas.width - x, b.xmax - b.xmin + 2 * pw);
  const hh = Math.min(canvas.height - y, b.ymax - b.ymin + 2 * ph);
  const s = 192 / Math.max(w, hh, 1);
  const t = document.createElement('canvas');
  t.width = Math.max(1, Math.round(w * s)); t.height = Math.max(1, Math.round(hh * s));
  t.getContext('2d').drawImage(canvas, x, y, w, hh, 0, 0, t.width, t.height);
  return t.toDataURL('image/jpeg', 0.72);
}

const frameCanvas = (src, sw, sh) => {
  const scale = Math.min(1, 1024 / Math.max(sw, sh));
  const c = document.createElement('canvas');
  c.width = Math.round(sw * scale); c.height = Math.round(sh * scale);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c;
};

async function* frames(file, maxFrames) {
  if (file.type.startsWith('video/')) {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
    await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('Could not read video')); });
    const dur = Number.isFinite(v.duration) ? v.duration : 1;
    const n = Math.max(1, Math.min(maxFrames, Math.ceil(dur)));
    for (let i = 0; i < n; i++) {
      v.currentTime = Math.min(dur - 0.05, (dur * (i + 0.5)) / n);
      await new Promise((res) => { v.onseeked = res; });
      yield frameCanvas(v, v.videoWidth, v.videoHeight);
    }
    URL.revokeObjectURL(url);
  } else {
    const bmp = await createImageBitmap(file);
    yield frameCanvas(bmp, bmp.width, bmp.height);
    bmp.close?.();
  }
}

// Returns [{label, name, count, score, thumb}] merged across every frame.
export async function scanFiles(files, { threshold = 0.6, maxFrames = 14, onStatus } = {}) {
  const det = await getDetector(onStatus);
  const found = new Map();
  let done = 0;
  for (const file of files) {
    for await (const canvas of frames(file, maxFrames)) {
      onStatus?.(`Looking… (frame ${++done})`);
      const out = await det(RawImageRef.fromCanvas(canvas), { threshold, percentage: false });
      const byLabel = new Map();
      for (const d of out) if (!IGNORE.has(d.label)) (byLabel.get(d.label) ?? byLabel.set(d.label, []).get(d.label)).push(d);
      for (const [label, ds] of byLabel) {
        const best = ds.reduce((a, b) => (b.score > a.score ? b : a));
        const cur = found.get(label);
        if (!cur) found.set(label, { label, name: titleCase(label), count: ds.length, score: best.score, thumb: crop(canvas, best.box), _c: canvas, _b: best.box });
        else {
          cur.count = Math.max(cur.count, ds.length);
          if (best.score > cur.score) { cur.score = best.score; cur.thumb = crop(canvas, best.box); cur._c = canvas; cur._b = best.box; }
        }
      }
      await new Promise((r) => setTimeout(r)); // let the UI breathe
    }
  }
  return finish([...found.values()].sort((a, b) => b.score - a.score));
}

// Context photo: the whole frame (downscaled) plus where the item sits in it, so
// the app can later circle the item on a picture of the place it was seen.
function ctxOf(c, b) {
  const s = Math.min(1, 720 / Math.max(c.width, c.height));
  const t = document.createElement('canvas');
  t.width = Math.round(c.width * s); t.height = Math.round(c.height * s);
  t.getContext('2d').drawImage(c, 0, 0, t.width, t.height);
  const n = (v, m) => Math.min(1, Math.max(0, v / m));
  return { img: t.toDataURL('image/jpeg', 0.6),
    box: { x: n(b.xmin, c.width), y: n(b.ymin, c.height), w: n(b.xmax - b.xmin, c.width), h: n(b.ymax - b.ymin, c.height) } };
}
function finish(list) {
  for (const f of list) { if (f._c && f._b) f.ctx = ctxOf(f._c, f._b); delete f._c; delete f._b; }
  return list;
}

// ---------------------------------------------------------------------------
// Optional cloud mode: sends downscaled frames to the Claude API (opt-in only).
// ---------------------------------------------------------------------------
export const CLAUDE_MODELS = [['claude-haiku-5-5', 'Haiku (fast, cheap)'], ['claude-sonnet-5-5', 'Sonnet (more accurate)']];

const TOOL = {
  name: 'catalogue',
  description: 'Report every distinct physical item visible in the frames.',
  input_schema: {
    type: 'object',
    properties: { items: { type: 'array', items: { type: 'object', properties: {
      name: { type: 'string', description: 'Short, specific, singular name, e.g. "Phillips screwdriver"' },
      count: { type: 'integer', description: 'How many of this item are visible together' },
      frame: { type: 'integer', description: '1-based number of the frame where it is clearest' },
      box: { type: 'object', description: 'Bounding box in that frame, 0-1000 normalised, origin top-left',
        properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } }, required: ['x', 'y', 'w', 'h'] },
    }, required: ['name', 'count', 'frame', 'box'] } } },
    required: ['items'],
  },
};

export async function scanWithClaude(files, { apiKey, model, maxFrames = 6, onStatus } = {}) {
  if (!apiKey) throw new Error('No Claude API key saved.');
  const canvases = [];
  onStatus?.('Preparing frames…');
  outer: for (const f of files) {
    for await (const c of frames(f, Math.max(1, Math.ceil(maxFrames / files.length)))) {
      canvases.push(c);
      if (canvases.length >= maxFrames) break outer;
    }
  }
  const content = [];
  canvases.forEach((c, i) => {
    content.push({ type: 'text', text: `Frame ${i + 1}:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: c.toDataURL('image/jpeg', 0.8).split(',')[1] } });
  });
  content.push({ type: 'text', text: 'Catalogue every distinct physical belonging you can see (tools, electronics, documents, clothing, kitchenware, etc.). ' +
    'Merge duplicates across frames. Be specific but concise. Ignore people, faces, walls, floors and furniture that is part of the room. Report via the catalogue tool.' });

  onStatus?.('Asking Claude…');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 90000);
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctl.signal, referrerPolicy: 'no-referrer', credentials: 'omit',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model, max_tokens: 2048, tools: [TOOL], tool_choice: { type: 'tool', name: 'catalogue' }, messages: [{ role: 'user', content }] }),
    });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'Claude took too long.' : 'Could not reach the Claude API.');
  } finally { clearTimeout(timer); }
  if (res.status === 401) throw new Error('Claude rejected the API key.');
  if (res.status === 429) throw new Error('Rate limited by Claude. Try again shortly.');
  if (!res.ok) throw new Error(`Claude API error (${res.status}).`);
  const data = await res.json();
  const items = data.content?.find((b) => b.type === 'tool_use')?.input?.items ?? [];

  const found = new Map();
  for (const it of items) {
    const name = String(it.name ?? '').trim().slice(0, 80);
    if (!name || IGNORE.has(name.toLowerCase())) continue;
    const c = canvases[Math.min(canvases.length, Math.max(1, it.frame | 0)) - 1];
    const k = 1000, b = it.box ?? {};
    const box = { xmin: (b.x / k) * c.width, ymin: (b.y / k) * c.height, xmax: ((b.x + b.w) / k) * c.width, ymax: ((b.y + b.h) / k) * c.height };
    const ok = [box.xmin, box.ymin, box.xmax, box.ymax].every(Number.isFinite) && box.xmax > box.xmin && box.ymax > box.ymin;
    const label = name.toLowerCase();
    const cur = found.get(label);
    if (cur) cur.count = Math.max(cur.count, Math.max(1, it.count | 0));
    else found.set(label, { label, name: titleCase(name), count: Math.max(1, it.count | 0), score: null, source: 'claude', thumb: crop(c, ok ? box : { xmin: 0, ymin: 0, xmax: c.width, ymax: c.height }), _c: ok ? c : null, _b: ok ? box : null });
  }
  return finish([...found.values()]);
}
