// Turns the exercise drawings (light lines on a navy ground, RGB PNG) into ink on a transparent ground,
// so they sit on any background without blend tricks. Usage: node tools/ink.js images images/ink
// With tools/figures.json beside it, each drawing's lines are also thickened or thinned so that, once the pages
// scale every drawing to one body size (REF / body size), all lines show the same weight (LINE px at REF).
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const INK = [21, 21, 21];

function readPng(file) {
  const buf = fs.readFileSync(file);
  let pos = 8, width, height, idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString("ascii", pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 2 || data[12] !== 0) throw new Error(file + ": only 8-bit RGB, non-interlaced");
    } else if (type === "IDAT") idat.push(data);
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)), bpp = 3, stride = width * bpp, px = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, out = y * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i], a = i >= bpp ? px[out + i - bpp] : 0, b = y ? px[out - stride + i] : 0, c = i >= bpp && y ? px[out - stride + i - bpp] : 0;
      let v;
      if (f === 0) v = x; else if (f === 1) v = x + a; else if (f === 2) v = x + b; else if (f === 3) v = x + ((a + b) >> 1);
      else { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      px[out + i] = v & 255;
    }
  }
  return { width, height, px };
}

function crcTable() { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; }
const CRC = crcTable();
function crc(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]), c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}
function writePng(file, width, height, rgba) {
  const stride = width * 4, raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {   // filter "sub" per row: small and simple
    raw[y * (stride + 1)] = 1;
    for (let i = 0; i < stride; i++) raw[y * (stride + 1) + 1 + i] = (rgba[y * stride + i] - (i >= 4 ? rgba[y * stride + i - 4] : 0)) & 255;
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]));
}

function ink({ width, height, px }) {
  const lum = (i) => 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
  // the ground: median luminance of the border
  const border = [];
  for (let x = 0; x < width; x++) { border.push(lum(x * 3), lum(((height - 1) * width + x) * 3)); }
  for (let y = 0; y < height; y++) { border.push(lum(y * width * 3), lum((y * width + width - 1) * 3)); }
  border.sort((a, b) => a - b);
  const ground = border[border.length >> 1], top = 235;
  const out = Buffer.alloc(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    let a = (lum(p * 3) - ground - 4) / (top - ground);
    a = Math.max(0, Math.min(1, a));
    out[p * 4] = INK[0]; out[p * 4 + 1] = INK[1]; out[p * 4 + 2] = INK[2]; out[p * 4 + 3] = Math.round(a * 255);
  }
  return out;
}

// ---- kettlebells ----
// A kettlebell's body is a closed, round area of faint fill (or of solid ink when the drawing already filled it)
// that is not joined to the figure's body: a head, by contrast, runs into the torso through the neck.
function kettlebells(rgba, w, h) {
  const al = (p) => rgba[p * 4 + 3];
  const inner = (p) => al(p) > 8 && al(p) <= 140;      // faint body fill, between the lines
  const lab = new Int32Array(w * h).fill(-1), found = [];
  for (let s = 0; s < w * h; s++) {
    if (!inner(s) || lab[s] >= 0) continue;
    const id = found.length, stack = [s], px = [];
    lab[s] = id;
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    while (stack.length) {
      const p = stack.pop(), x = p % w, y = (p / w) | 0;
      px.push(p); if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const q of [p - 1, p + 1, p - w, p + w]) if (q >= 0 && q < w * h && Math.abs((q % w) - x) <= 1 && inner(q) && lab[q] < 0) { lab[q] = id; stack.push(q); }
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1, d = Math.max(bw, bh);
    const round = px.length / (Math.PI * d * d / 4), aspect = Math.min(bw, bh) / d;
    found.push({ px, x: (x0 + x1) / 2, y: (y0 + y1) / 2, d, round, aspect });
  }
  const balls = found.filter((c) => c.d >= 14 && c.d <= 60 && c.round > 0.62 && c.aspect > 0.72);
  // the handle: a small pocket of empty ground fully enclosed by ink, right next to the ball
  const empty = (p) => al(p) <= 8, seen = new Uint8Array(w * h), holes = [];
  for (let s = 0; s < w * h; s++) {
    if (!empty(s) || seen[s]) continue;
    const stack = [s]; seen[s] = 1; let n = 0, sx = 0, sy = 0, edge = false;
    while (stack.length) {
      const p = stack.pop(), x = p % w, y = (p / w) | 0;
      n++; sx += x; sy += y; if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true;
      for (const q of [p - 1, p + 1, p - w, p + w]) if (q >= 0 && q < w * h && Math.abs((q % w) - x) <= 1 && empty(q) && !seen[q]) { seen[q] = 1; stack.push(q); }
    }
    if (!edge && n >= 15 && n <= 500) holes.push({ x: sx / n, y: sy / n });
  }
  return balls.filter((c) => holes.some((o) => Math.hypot(o.x - c.x, o.y - c.y) < c.d * 0.95));
}

// A point inside each kettlebell drawn as an outline only (the others are already solid). The ball is filled solid
// ink from there, out to its own outline, so every kettlebell on the site reads black.
const KB = {
  "clean-press": [[178, 133], [366, 56, 16], [340, 42, 9]], "kb-halo": [[122, 128], [464, 118]], "suitcase-carry": [[143, 245], [352, 248]],
  "russian-twist": [[103, 220], [380, 272]], "renegade-row": [[392, 165], [305, 283]], "floor-press": [[183, 213], [478, 110]],
  "kb-row": [[207, 276], [383, 185]], "kb-swing": [[92, 300], [538, 105]], "single-leg-deadlift": [[83, 247], [490, 325]]
};
function fillKettlebells(rgba, w, h, seeds) {
  const al = (p) => rgba[p * 4 + 3];
  for (const [sx, sy, maxR = 30] of seeds) {   // optional third value: how far the fill may spread
    let start = -1;   // nearest faint pixel to the given point
    for (let r = 0; r <= 8 && start < 0; r++) for (let dy = -r; dy <= r && start < 0; dy++) for (let dx = -r; dx <= r; dx++) {
      const p = (sy + dy) * w + sx + dx; if (al(p) <= 140) { start = p; break; }
    }
    if (start < 0) continue;
    const seen = new Uint8Array(w * h), stack = [start]; seen[start] = 1;
    while (stack.length) {
      const p = stack.pop(), x = p % w, y = (p / w) | 0;
      rgba[p * 4 + 3] = 255;
      for (const q of [p - 1, p + 1, p - w, p + w]) {
        const qx = q % w, qy = (q / w) | 0;
        if (q < 0 || q >= w * h || Math.abs(qx - x) > 1 || seen[q]) continue;
        if (al(q) > 140) { rgba[q * 4 + 3] = 255; continue; }   // the outline's inner soft edge joins the fill, no light seam
        if (Math.hypot(qx - sx, qy - sy) > maxR) continue;   // never leak past the ball
        seen[q] = 1; stack.push(q);
      }
    }
  }
  return rgba;
}

// Every solid kettlebell is lightened to a flat dark grey (KB_ALPHA of full ink), edge included.
// Its core is where the solid ink lies more than 3.5 px from any edge (lines are never that thick). Everything within
// 5 px of the core is scaled to KB_ALPHA, fading back to full ink by 6.5 px, so the ball's own smooth edge is kept
// as it was, only lighter: no ring, no steps. Try other greys with KB_ALPHA=… node tools/ink.js images out
const KB_ALPHA = +(process.env.KB_ALPHA || 175);
function chamfer(d, w, h) {   // in place: distance to the nearest zero
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x; if (!d[p]) continue; let v = d[p];
    if (x > 0) v = Math.min(v, d[p - 1] + 1); if (y > 0) { v = Math.min(v, d[p - w] + 1); if (x > 0) v = Math.min(v, d[p - w - 1] + 1.414); if (x < w - 1) v = Math.min(v, d[p - w + 1] + 1.414); }
    d[p] = v;
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const p = y * w + x; if (!d[p]) continue; let v = d[p];
    if (x < w - 1) v = Math.min(v, d[p + 1] + 1); if (y < h - 1) { v = Math.min(v, d[p + w] + 1); if (x < w - 1) v = Math.min(v, d[p + w + 1] + 1.414); if (x > 0) v = Math.min(v, d[p + w - 1] + 1.414); }
    d[p] = v;
  }
  return d;
}
function softenSolids(rgba, w, h) {
  const INF = 1e6, edge = new Float32Array(w * h);
  for (let p = 0; p < w * h; p++) edge[p] = rgba[p * 4 + 3] > 200 ? INF : 0;
  chamfer(edge, w, h);                                   // depth inside the solid ink
  const core = new Float32Array(w * h);
  for (let p = 0; p < w * h; p++) core[p] = edge[p] > 3.5 ? 0 : INF;
  chamfer(core, w, h);                                   // distance to the nearest ball core
  const k = KB_ALPHA / 255;
  for (let p = 0; p < w * h; p++) {
    const m = Math.max(0, Math.min(1, (6.5 - core[p]) / 1.5));
    if (m > 0) rgba[p * 4 + 3] = Math.round(rgba[p * 4 + 3] * (1 - m * (1 - k)));
  }
  return rgba;
}

// ---- line weight ----
const REF = 270, LINE = 2.8;   // body size the pages scale to, and the line width wanted there

// mean width of the lines: horizontal and vertical runs of solid ink shorter than 14 px
function lineWidth(rgba, w, h) {
  const m = (p) => rgba[p * 4 + 3] > 140;
  let sum = 0, n = 0;
  const add = (r) => { if (r > 0 && r < 14) { sum += r; n++; } };
  for (let y = 0; y < h; y += 2) { let r = 0; for (let x = 0; x < w; x++) { if (m(y * w + x)) r++; else { add(r); r = 0; } } }
  for (let x = 0; x < w; x += 2) { let r = 0; for (let y = 0; y < h; y++) { if (m(y * w + x)) r++; else { add(r); r = 0; } } }
  return sum / n;
}

// grow (d > 0) or shrink (d < 0) the ink by |d| px per side, with sub-pixel precision: work at 8× resolution,
// take the running max (or min) over a square window in two passes, then average back down
const S = 8;
function upsample(rgba, w, h) {           // bilinear up-sampling of the alpha channel, done once per drawing
  const W = w * S, H = h * S, a = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(h - 1, Math.max(0, (y + 0.5) / S - 0.5)), y0 = Math.floor(sy), y1 = Math.min(h - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < W; x++) {
      const sx = Math.min(w - 1, Math.max(0, (x + 0.5) / S - 0.5)), x0 = Math.floor(sx), x1 = Math.min(w - 1, x0 + 1), fx = sx - x0;
      const a00 = rgba[(y0 * w + x0) * 4 + 3], a10 = rgba[(y0 * w + x1) * 4 + 3], a01 = rgba[(y1 * w + x0) * 4 + 3], a11 = rgba[(y1 * w + x1) * 4 + 3];
      a[y * W + x] = (a00 * (1 - fx) + a10 * fx) * (1 - fy) + (a01 * (1 - fx) + a11 * fx) * fy;
    }
  }
  return a;
}
// running max/min over a window of 2R+1 along one line (van Herk / Gil-Werman: cost does not grow with R)
function runLine(src, dst, n, start, step, R, grow, g, hb) {
  const k = 2 * R + 1, pad = n + 2 * R, fill = grow ? -Infinity : Infinity;
  const at = (i) => { const j = i - R; return j < 0 || j >= n ? fill : src[start + j * step]; };
  for (let b = 0; b < pad; b += k) {
    const e = Math.min(b + k, pad);
    g[b] = at(b); for (let i = b + 1; i < e; i++) { const v = at(i); g[i] = grow ? (v > g[i - 1] ? v : g[i - 1]) : (v < g[i - 1] ? v : g[i - 1]); }
    hb[e - 1] = at(e - 1); for (let i = e - 2; i >= b; i--) { const v = at(i); hb[i] = grow ? (v > hb[i + 1] ? v : hb[i + 1]) : (v < hb[i + 1] ? v : hb[i + 1]); }
  }
  for (let i = 0; i < n; i++) { const l = hb[i], r = g[i + 2 * R]; dst[start + i * step] = grow ? (l > r ? l : r) : (l < r ? l : r); }
}
function reweigh(rgba, w, h, d, up) {
  const R = Math.round(Math.abs(d) * S);
  if (!R) return rgba;
  const W = w * S, H = h * S, grow = d > 0, tmp = new Float32Array(W * H), a = new Float32Array(W * H);
  const g = new Float32Array(Math.max(W, H) + 2 * R + 1), hb = new Float32Array(Math.max(W, H) + 2 * R + 1);
  for (let y = 0; y < H; y++) runLine(up, tmp, W, y * W, 1, R, grow, g, hb);
  for (let x = 0; x < W; x++) runLine(tmp, a, H, x, W, R, grow, g, hb);
  const out = Buffer.from(rgba);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0; for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) s += a[(y * S + j) * W + x * S + i];
    out[(y * w + x) * 4 + 3] = Math.round(s / (S * S));
  }
  return out;
}

const [srcDir, outDir] = process.argv.slice(2);
const figFile = path.join(__dirname, "figures.json");
const bodies = fs.existsSync(figFile) ? JSON.parse(fs.readFileSync(figFile, "utf8")) : {};
fs.mkdirSync(outDir, { recursive: true });
const only = process.env.ONLY ? process.env.ONLY.split(",").map((n) => n + ".png") : null;
for (const f of fs.readdirSync(srcDir).filter((f) => f.endsWith(".png") && (!only || only.includes(f)))) {
  const img = readPng(path.join(srcDir, f));
  let rgba = ink(img);
  if (KB[f.slice(0, -4)]) rgba = fillKettlebells(rgba, img.width, img.height, KB[f.slice(0, -4)]);
  const body = bodies[f.slice(0, -4)];
  let note = "";
  if (body) {
    // the measured width does not grow linearly with the reweighing, so search for the amount that hits the target
    const have = lineWidth(rgba, img.width, img.height), want = LINE * body / REF;
    let lo = -1.5, hi = 1.5, best = rgba, bestErr = Math.abs(have - want);
    const up = upsample(rgba, img.width, img.height);
    for (let k = 0; k < 7; k++) {
      const d = (lo + hi) / 2, cand = reweigh(rgba, img.width, img.height, d, up), got = lineWidth(cand, img.width, img.height);
      if (Math.abs(got - want) < bestErr) { best = cand; bestErr = Math.abs(got - want); }
      if (got < want) lo = d; else hi = d;
    }
    rgba = best;
    note = ` line ${have.toFixed(2)} → ${lineWidth(rgba, img.width, img.height).toFixed(2)} (want ${want.toFixed(2)})`;
  }
  rgba = softenSolids(rgba, img.width, img.height);
  writePng(path.join(outDir, f), img.width, img.height, rgba);
  console.log(f + note);
}
