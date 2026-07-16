/**
 * Fusion worker for the World Scanner.
 *
 * The main thread stays nearly idle during an AR scan: per capture tick it
 * posts a copy of the raw depth buffer, the view matrices, and (occasionally)
 * downscaled camera pixels. This worker does everything expensive —
 * unprojection, voxel dedupe, point storage — and replies with just the
 * newly added points for rendering.
 *
 * Classic worker, zero imports. VOXEL and the 10-byte record layout must
 * match public/js/world-format.js.
 */
'use strict';

const VOXEL = 0.04;
const DEPTH_MIN = 0.25, DEPTH_MAX = 6.0;

let CAP = 0;
let count = 0;
let qpos = null;     // Int16Array  CAP*3
let cols = null;     // Uint8Array  CAP*3
let keys = null;     // Float64Array voxel hash (0 = empty, key+1 otherwise)
let mask = 0;
let phase = 0;
let lastCam = null;  // { data, w, h }
const groundCells = new Set();
const min = [Infinity, Infinity, Infinity];
const max = [-Infinity, -Infinity, -Infinity];

function init(cap) {
  CAP = cap;
  count = 0;
  qpos = new Int16Array(CAP * 3);
  cols = new Uint8Array(CAP * 3);
  let c = 1;
  while (c < CAP * 2) c *= 2;
  keys = new Float64Array(c);
  mask = c - 1;
}

/** returns true if this voxel is new and was stored */
function addPoint(x, y, z, r, g, b) {
  if (count >= CAP) return false;
  const qx = Math.round(x / VOXEL), qy = Math.round(y / VOXEL), qz = Math.round(z / VOXEL);
  if (qx < -32700 || qx > 32700 || qy < -32700 || qy > 32700 || qz < -32700 || qz > 32700) return false;

  const key = (qx + 32768) * 4294967296 + (qy + 32768) * 65536 + (qz + 32768) + 1;
  let h = ((qx * 73856093) ^ (qy * 19349663) ^ (qz * 83492791)) & mask;
  while (keys[h] !== 0) {
    if (keys[h] === key) return false;
    h = (h + 1) & mask;
  }
  keys[h] = key;

  const i = count * 3;
  qpos[i] = qx; qpos[i + 1] = qy; qpos[i + 2] = qz;
  cols[i] = r; cols[i + 1] = g; cols[i + 2] = b;
  count++;

  if (x < min[0]) min[0] = x; if (x > max[0]) max[0] = x;
  if (y < min[1]) min[1] = y; if (y > max[1]) max[1] = y;
  if (z < min[2]) min[2] = z; if (z > max[2]) max[2] = z;
  if (y < 1.0) groundCells.add(((qx >> 5) + 2048) * 4096 + ((qz >> 5) + 2048));
  return true;
}

function reply(outPos, outCol, added) {
  const msg = {
    type: 'points', n: added, total: count,
    ground: groundCells.size, min: min.slice(), max: max.slice(),
  };
  if (added > 0) {
    const p = outPos.slice(0, added * 3);
    const c = outCol.slice(0, added * 3);
    msg.pos = p.buffer; msg.col = c.buffer;
    postMessage(msg, [p.buffer, c.buffer]);
  } else {
    postMessage(msg);
  }
}

function fuse(m) {
  const w = m.w, h = m.h;
  const raw = m.isFloat ? new Float32Array(m.buf) : new Uint16Array(m.buf);
  const scale = m.scale;
  if (m.cam) lastCam = { data: new Uint8Array(m.cam.buf), w: m.cam.w, h: m.cam.h };
  const invD = m.invDepth, invP = m.invProj, view = m.viewMat;

  const sx = Math.max(1, Math.round(w / 96));
  const sy = Math.max(1, Math.round(h / 72)) * 2;   // every other row,
  phase = 1 - phase;                                 // alternating per tick
  const maxSamples = (Math.ceil(w / sx) + 1) * (Math.ceil(h / (sy >> 1)) + 1);
  const outPos = new Float32Array(maxSamples * 3);
  const outCol = new Uint8Array(maxSamples * 3);
  let added = 0;

  outer:
  for (let py = phase * (sy >> 1); py < h; py += sy) {
    const dv = (py + 0.5) / h;
    const row = py * w;
    for (let px = 0; px < w; px += sx) {
      const d = raw[row + px] * scale;
      if (!(d >= DEPTH_MIN && d <= DEPTH_MAX)) continue;
      const du = (px + 0.5) / w;

      // depth-buffer UV -> normalized view UV (handles portrait rotation)
      const u = invD[0] * du + invD[4] * dv + invD[12];
      const v = invD[1] * du + invD[5] * dv + invD[13];
      if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;

      // unproject through the inverse projection, scale to metric depth
      const nx = u * 2 - 1, ny = 1 - v * 2;
      const iw = 1 / (invP[3] * nx + invP[7] * ny + invP[11] * 0.5 + invP[15]);
      let X = (invP[0] * nx + invP[4] * ny + invP[8] * 0.5 + invP[12]) * iw;
      let Y = (invP[1] * nx + invP[5] * ny + invP[9] * 0.5 + invP[13]) * iw;
      let Z = (invP[2] * nx + invP[6] * ny + invP[10] * 0.5 + invP[14]) * iw;
      if (Z > -1e-6) continue;
      const s = d / -Z;
      X *= s; Y *= s; Z *= s;

      // rigid view transform into world space
      const wx = view[0] * X + view[4] * Y + view[8] * Z + view[12];
      const wy = view[1] * X + view[5] * Y + view[9] * Z + view[13];
      const wz = view[2] * X + view[6] * Y + view[10] * Z + view[14];

      let r, g, b;
      if (lastCam) {
        const cpx = Math.min(lastCam.w - 1, (u * lastCam.w) | 0);
        const cpy = Math.min(lastCam.h - 1, ((1 - v) * lastCam.h) | 0);
        const o = (cpy * lastCam.w + cpx) * 4;
        r = lastCam.data[o]; g = lastCam.data[o + 1]; b = lastCam.data[o + 2];
      } else {
        const t = Math.max(0, Math.min(1, (wy + 0.6) / 3.6));
        r = 16 + t * 180; g = 60 + t * 180; b = 120 + t * 135;
      }

      if (addPoint(wx, wy, wz, r, g, b)) {
        const j = added * 3;
        outPos[j] = wx; outPos[j + 1] = wy; outPos[j + 2] = wz;
        outCol[j] = r; outCol[j + 1] = g; outCol[j + 2] = b;
        added++;
      }
      if (count >= CAP) break outer;
    }
  }
  reply(outPos, outCol, added);
}

/** demo-generator path: plain [x,y,z,r,g,b]* records straight into the store */
function raw(m) {
  const pts = new Float32Array(m.buf);
  const n = Math.floor(pts.length / 6);
  const outPos = new Float32Array(n * 3);
  const outCol = new Uint8Array(n * 3);
  let added = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 6;
    if (addPoint(pts[o], pts[o + 1], pts[o + 2], pts[o + 3], pts[o + 4], pts[o + 5])) {
      const j = added * 3;
      outPos[j] = pts[o]; outPos[j + 1] = pts[o + 1]; outPos[j + 2] = pts[o + 2];
      outCol[j] = pts[o + 3]; outCol[j + 1] = pts[o + 4]; outCol[j + 2] = pts[o + 5];
      added++;
    }
  }
  reply(outPos, outCol, added);
}

/** pack the whole store into the shared 10-byte-per-point world format */
function encode() {
  const out = new Uint16Array(count * 5);
  for (let i = 0; i < count; i++) {
    const p = i * 3, o = i * 5;
    out[o]     = qpos[p]     + 32768;
    out[o + 1] = qpos[p + 1] + 32768;
    out[o + 2] = qpos[p + 2] + 32768;
    out[o + 3] = (cols[p] << 8) | cols[p + 1];
    out[o + 4] = cols[p + 2] << 8;
  }
  postMessage(
    { type: 'encoded', buf: out.buffer, total: count, min: min.slice(), max: max.slice() },
    [out.buffer]
  );
}

onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') init(m.cap);
    else if (m.type === 'fuse') fuse(m);
    else if (m.type === 'raw') raw(m);
    else if (m.type === 'encode') encode();
  } catch (err) {
    postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
