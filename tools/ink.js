// Turns the exercise drawings (light lines on a navy ground, RGB PNG) into ink on a transparent ground,
// so they sit on any background without blend tricks. Usage: node tools/ink.js images images/ink
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

const [srcDir, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
for (const f of fs.readdirSync(srcDir).filter((f) => f.endsWith(".png"))) {
  const img = readPng(path.join(srcDir, f));
  writePng(path.join(outDir, f), img.width, img.height, ink(img));
  console.log(f);
}
