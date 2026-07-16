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
const DEPTH_MIN = 0.25, DEPTH_MAX = 4.0;  // ARCore depth error grows ~d² — past 4 m it's mush
const EDGE_REL = 0.08;      // reject pixels whose neighbor depth differs > 8% (flying pixels)
const CONFIRM_HITS = 2;     // a voxel must be seen in this many different capture ticks
const PENDING_SLOTS = 1 << 20;
const PENDING_MASK = PENDING_SLOTS - 1;
const PENDING_PROBE = 8;    // lossy cache: evict the stalest entry when a chain fills

let CAP = 0;
let count = 0;
let qpos = null;     // Int16Array  CAP*3
let cols = null;     // Uint8Array  CAP*3
let keys = null;     // Float64Array voxel hash (0 = empty, key+1 otherwise)
let mask = 0;
let phase = 0;
let tick = 0;        // capture-tick counter for temporal confirmation
let lastCam = null;  // { data, w, h }
// pending voxels awaiting confirmation (unconfirmed = probably noise)
let pkeys = null;    // Float64Array PENDING_SLOTS
let pinfo = null;    // Uint32Array  (lastTick << 8) | hitCount
let pcol = null;     // Uint32Array  first-seen color, r<<16|g<<8|b
const groundCells = new Set();
const min = [Infinity, Infinity, Infinity];
const max = [-Infinity, -Infinity, -Infinity];

function init(cap) {
  CAP = cap;
  count = 0;
  tick = 0;
  qpos = new Int16Array(CAP * 3);
  cols = new Uint8Array(CAP * 3);
  let c = 1;
  while (c < CAP * 2) c *= 2;
  keys = new Float64Array(c);
  mask = c - 1;
  pkeys = new Float64Array(PENDING_SLOTS);
  pinfo = new Uint32Array(PENDING_SLOTS);
  pcol = new Uint32Array(PENDING_SLOTS);
}

const voxelKey = (qx, qy, qz) => (qx + 32768) * 4294967296 + (qy + 32768) * 65536 + (qz + 32768) + 1;
const voxelHash = (qx, qy, qz) => (qx * 73856093) ^ (qy * 19349663) ^ (qz * 83492791);

/** store a voxel known to be absent from the committed table */
function commit(qx, qy, qz, key, r, g, b, x, y, z) {
  let h = voxelHash(qx, qy, qz) & mask;
  while (keys[h] !== 0) h = (h + 1) & mask;
  keys[h] = key;

  const i = count * 3;
  qpos[i] = qx; qpos[i + 1] = qy; qpos[i + 2] = qz;
  cols[i] = r; cols[i + 1] = g; cols[i + 2] = b;
  count++;

  if (x < min[0]) min[0] = x; if (x > max[0]) max[0] = x;
  if (y < min[1]) min[1] = y; if (y > max[1]) max[1] = y;
  if (z < min[2]) min[2] = z; if (z > max[2]) max[2] = z;
  if (y < 1.0) groundCells.add(((qx >> 5) + 2048) * 4096 + ((qz >> 5) + 2048));
}

function committed(qx, qy, qz, key) {
  let h = voxelHash(qx, qy, qz) & mask;
  while (keys[h] !== 0) {
    if (keys[h] === key) return true;
    h = (h + 1) & mask;
  }
  return false;
}

/** direct path (demo worlds): dedupe + store, no confirmation needed */
function addPoint(x, y, z, r, g, b) {
  if (count >= CAP) return false;
  const qx = Math.round(x / VOXEL), qy = Math.round(y / VOXEL), qz = Math.round(z / VOXEL);
  if (qx < -32700 || qx > 32700 || qy < -32700 || qy > 32700 || qz < -32700 || qz > 32700) return false;
  const key = voxelKey(qx, qy, qz);
  if (committed(qx, qy, qz, key)) return false;
  commit(qx, qy, qz, key, r, g, b, x, y, z);
  return true;
}

/**
 * AR path: a depth sample only becomes a stored point after the same voxel
 * has been observed in CONFIRM_HITS different capture ticks. One-frame depth
 * noise never re-observes the same voxel, so it dies in the pending cache.
 * Returns true only on the observation that confirms (and stores) the voxel.
 */
function observe(x, y, z, r, g, b) {
  if (count >= CAP) return false;
  const qx = Math.round(x / VOXEL), qy = Math.round(y / VOXEL), qz = Math.round(z / VOXEL);
  if (qx < -32700 || qx > 32700 || qy < -32700 || qy > 32700 || qz < -32700 || qz > 32700) return false;
  const key = voxelKey(qx, qy, qz);
  if (committed(qx, qy, qz, key)) return false;

  const h0 = voxelHash(qx, qy, qz) & PENDING_MASK;
  let evict = -1, evictAge = -1;
  for (let i = 0; i < PENDING_PROBE; i++) {
    const s = (h0 + i) & PENDING_MASK;
    const k = pkeys[s];
    if (k === 0) {                                   // new sighting
      pkeys[s] = key;
      pinfo[s] = (tick << 8) | 1;
      pcol[s] = (r << 16) | (g << 8) | b;
      return false;
    }
    if (k === key) {
      const info = pinfo[s];
      if ((info >>> 8) === tick) return false;       // same frame — not a confirmation
      const hits = (info & 0xff) + 1;
      if (hits >= CONFIRM_HITS) {
        const c0 = pcol[s];
        pkeys[s] = 0;                                // free the slot
        commit(qx, qy, qz, key,
          (((c0 >>> 16) & 0xff) + r) >> 1,
          (((c0 >>> 8) & 0xff) + g) >> 1,
          ((c0 & 0xff) + b) >> 1,
          x, y, z);
        return true;
      }
      pinfo[s] = (tick << 8) | hits;
      return false;
    }
    const age = tick - (pinfo[s] >>> 8);
    if (age > evictAge) { evictAge = age; evict = s; }
  }
  // chain full — replace the stalest pending entry (it was probably noise)
  pkeys[evict] = key;
  pinfo[evict] = (tick << 8) | 1;
  pcol[evict] = (r << 16) | (g << 8) | b;
  return false;
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
  tick++;

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
      // flying-pixel rejection: at depth discontinuities the sensor interpolates
      // between foreground and background, spraying points into empty space
      const dr = px + 1 < w ? raw[row + px + 1] * scale : d;
      const dd = py + 1 < h ? raw[row + w + px] * scale : d;
      if (Math.abs(dr - d) > d * EDGE_REL || Math.abs(dd - d) > d * EDGE_REL) continue;
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

      if (observe(wx, wy, wz, r, g, b)) {
        const j = added * 3, ci = (count - 1) * 3;
        outPos[j] = wx; outPos[j + 1] = wy; outPos[j + 2] = wz;
        outCol[j] = cols[ci]; outCol[j + 1] = cols[ci + 1]; outCol[j + 2] = cols[ci + 2];
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

const MIN_NEIGHBORS = 2;  // save-time: a real surface voxel touches its neighbors

/**
 * pack the whole store into the shared 10-byte-per-point world format,
 * dropping isolated specks (voxels with < MIN_NEIGHBORS of the 26 adjacent
 * cells occupied) and recomputing the bounds from what's kept.
 */
function encode() {
  const keep = new Uint8Array(count);
  let kept = 0;
  const emin = [Infinity, Infinity, Infinity];
  const emax = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    const p = i * 3;
    const qx = qpos[p], qy = qpos[p + 1], qz = qpos[p + 2];
    let n = 0;
    scan:
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          if (dx === 0 && dy === 0 && dz === 0) continue;
          const nx = qx + dx, ny = qy + dy, nz = qz + dz;
          if (committed(nx, ny, nz, voxelKey(nx, ny, nz)) && ++n >= MIN_NEIGHBORS) break scan;
        }
    if (n >= MIN_NEIGHBORS) {
      keep[i] = 1;
      kept++;
      const x = qx * VOXEL, y = qy * VOXEL, z = qz * VOXEL;
      if (x < emin[0]) emin[0] = x; if (x > emax[0]) emax[0] = x;
      if (y < emin[1]) emin[1] = y; if (y > emax[1]) emax[1] = y;
      if (z < emin[2]) emin[2] = z; if (z > emax[2]) emax[2] = z;
    }
  }

  const out = new Uint16Array(kept * 5);
  let o = 0;
  for (let i = 0; i < count; i++) {
    if (!keep[i]) continue;
    const p = i * 3;
    out[o]     = qpos[p]     + 32768;
    out[o + 1] = qpos[p + 1] + 32768;
    out[o + 2] = qpos[p + 2] + 32768;
    out[o + 3] = (cols[p] << 8) | cols[p + 1];
    out[o + 4] = cols[p + 2] << 8;
    o += 5;
  }
  postMessage(
    { type: 'encoded', buf: out.buffer, total: kept, min: emin, max: emax },
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
