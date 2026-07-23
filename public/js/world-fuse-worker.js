/**
 * Fusion worker for the World Scanner.
 *
 * The main thread stays nearly idle during an AR scan: per capture tick it
 * posts a copy of the raw depth buffer, the view matrices, and (occasionally)
 * downscaled camera pixels. This worker does everything expensive —
 * unprojection, voxel dedupe, running-average refinement, storage — and
 * replies with the newly confirmed points AND in-place refinements to points
 * it already sent.
 *
 * Fusion model: every 4 cm voxel keeps a *running average* of its true
 * (sub-voxel) world position and color plus an observation weight. The first
 * two sightings of a cell confirm it (one-frame noise never re-observes the
 * same cell, so it dies in the pending cache); every sighting after that
 * refines the average. Re-scanning a surface therefore pulls it toward the
 * truth and averages sensor noise out — the more you look, the crisper and
 * cleaner it gets. Low-weight, poorly-connected voxels are culled at save.
 *
 * Classic worker, zero imports. VOXEL and the 10-byte record layout must
 * match public/js/world-format.js.
 */
'use strict';

const VOXEL = 0.04;
const DEPTH_MIN = 0.25, DEPTH_MAX = 4.0;  // ARCore depth error grows ~d² — past 4 m it's mush
const EDGE_REL = 0.08;      // reject pixels whose neighbor depth differs > 8% (flying pixels)
const CONFIRM_HITS = 2;     // a voxel must be seen in this many different capture ticks
const WMAX = 60000;         // running-average weight ceiling (fits Uint16)
const EMIT_MOVE = 0.006;    // stream a live update once a point has drifted > 6 mm
const EMIT_COL = 12;        // ...or a color channel has shifted this much
const MAX_UPD = 2048;       // cap live refinements streamed per tick
const PENDING_SLOTS = 1 << 20;
const PENDING_MASK = PENDING_SLOTS - 1;
const PENDING_PROBE = 8;    // lossy cache: evict the stalest entry when a chain fills

let CAP = 0;
let count = 0;
let pos = null;      // Float32Array CAP*3  refined world position, metres
let qcell = null;    // Int16Array   CAP*3  immutable voxel-cell identity
let cols = null;     // Uint8Array   CAP*3  running-average color
let wt = null;       // Uint16Array  CAP    observation weight
let hidx = null;     // Int32Array   H      voxel-cell -> point index (-1 = empty)
let hmask = 0;
let phase = 0;
let tick = 0;        // capture-tick counter for temporal confirmation
let lastCam = null;  // { data, w, h }
// pending voxels awaiting confirmation (unconfirmed = probably noise)
let pkeys = null;    // Float64Array PENDING_SLOTS  voxel hash (0 = empty, key+1 otherwise)
let pinfo = null;    // Uint32Array  (lastTick << 8) | hitCount
let pcol = null;     // Uint32Array  first-seen color, r<<16|g<<8|b
// reusable per-tick live-update scratch
let uIdx = null, uPos = null, uCol = null;
const groundCells = new Set();
const min = [Infinity, Infinity, Infinity];
const max = [-Infinity, -Infinity, -Infinity];

// index touched by the most recent observe() (add or refine target)
let _oi = -1;

function init(cap) {
  CAP = cap;
  count = 0;
  tick = 0;
  pos = new Float32Array(CAP * 3);
  qcell = new Int16Array(CAP * 3);
  cols = new Uint8Array(CAP * 3);
  wt = new Uint16Array(CAP);
  let c = 1;
  while (c < CAP * 2) c *= 2;
  hidx = new Int32Array(c).fill(-1);
  hmask = c - 1;
  pkeys = new Float64Array(PENDING_SLOTS);
  pinfo = new Uint32Array(PENDING_SLOTS);
  pcol = new Uint32Array(PENDING_SLOTS);
  uIdx = new Int32Array(MAX_UPD);
  uPos = new Float32Array(MAX_UPD * 3);
  uCol = new Uint8Array(MAX_UPD * 3);
}

const voxelKey = (qx, qy, qz) => (qx + 32768) * 4294967296 + (qy + 32768) * 65536 + (qz + 32768) + 1;
const cellHash = (qx, qy, qz) =>
  (Math.imul(qx, 73856093) ^ Math.imul(qy, 19349663) ^ Math.imul(qz, 83492791)) >>> 0;

/** committed voxel-cell -> point index, or -1 */
function findIndex(qx, qy, qz) {
  let h = cellHash(qx, qy, qz) & hmask;
  for (;;) {
    const idx = hidx[h];
    if (idx === -1) return -1;
    const c = idx * 3;
    if (qcell[c] === qx && qcell[c + 1] === qy && qcell[c + 2] === qz) return idx;
    h = (h + 1) & hmask;
  }
}

function insertIndex(qx, qy, qz, idx) {
  let h = cellHash(qx, qy, qz) & hmask;
  while (hidx[h] !== -1) h = (h + 1) & hmask;
  hidx[h] = idx;
}

/** store a brand-new voxel (caller guarantees the cell is absent) */
function commit(qx, qy, qz, r, g, b, x, y, z, weight) {
  const i = count++;
  const p = i * 3;
  qcell[p] = qx; qcell[p + 1] = qy; qcell[p + 2] = qz;
  pos[p] = x; pos[p + 1] = y; pos[p + 2] = z;
  cols[p] = r; cols[p + 1] = g; cols[p + 2] = b;
  wt[i] = weight;
  insertIndex(qx, qy, qz, i);

  if (x < min[0]) min[0] = x; if (x > max[0]) max[0] = x;
  if (y < min[1]) min[1] = y; if (y > max[1]) max[1] = y;
  if (z < min[2]) min[2] = z; if (z > max[2]) max[2] = z;
  if (y < 1.0) groundCells.add(((qx >> 5) + 2048) * 4096 + ((qz >> 5) + 2048));
  return i;
}

/**
 * Blend a fresh sighting into an existing voxel's running average. Returns
 * true if the point moved / recolored enough to be worth re-drawing.
 */
function refine(i, x, y, z, r, g, b) {
  const p = i * 3;
  const w = wt[i];
  const inv = 1 / (w + 1);
  const ox = pos[p], oy = pos[p + 1], oz = pos[p + 2];
  const nx = ox + (x - ox) * inv, ny = oy + (y - oy) * inv, nz = oz + (z - oz) * inv;
  pos[p] = nx; pos[p + 1] = ny; pos[p + 2] = nz;
  const orr = cols[p], ogg = cols[p + 1], obb = cols[p + 2];
  const nr = Math.round(orr + (r - orr) * inv);
  const ng = Math.round(ogg + (g - ogg) * inv);
  const nb = Math.round(obb + (b - obb) * inv);
  cols[p] = nr; cols[p + 1] = ng; cols[p + 2] = nb;
  if (w < WMAX) wt[i] = w + 1;

  if (x < min[0]) min[0] = x; if (x > max[0]) max[0] = x;
  if (y < min[1]) min[1] = y; if (y > max[1]) max[1] = y;
  if (z < min[2]) min[2] = z; if (z > max[2]) max[2] = z;

  const moved = Math.abs(nx - ox) + Math.abs(ny - oy) + Math.abs(nz - oz);
  const cchg = Math.abs(nr - orr) + Math.abs(ng - ogg) + Math.abs(nb - obb);
  return moved > EMIT_MOVE || cchg > EMIT_COL;
}

/**
 * AR path. Returns:
 *   0  nothing to draw (pending, or a below-threshold refinement)
 *   1  a new confirmed point was committed  (index in _oi)
 *   2  an existing point was refined enough to redraw  (index in _oi)
 */
function observe(x, y, z, r, g, b) {
  if (count >= CAP) return 0;
  const qx = Math.round(x / VOXEL), qy = Math.round(y / VOXEL), qz = Math.round(z / VOXEL);
  if (qx < -32700 || qx > 32700 || qy < -32700 || qy > 32700 || qz < -32700 || qz > 32700) return 0;

  const i = findIndex(qx, qy, qz);
  if (i >= 0) {                       // already a real point — refine it
    _oi = i;
    return refine(i, x, y, z, r, g, b) ? 2 : 0;
  }

  // not committed yet — run it through the confirmation cache
  const key = voxelKey(qx, qy, qz);
  const h0 = cellHash(qx, qy, qz) & PENDING_MASK;
  let evict = -1, evictAge = -1;
  for (let s = 0; s < PENDING_PROBE; s++) {
    const slot = (h0 + s) & PENDING_MASK;
    const k = pkeys[slot];
    if (k === 0) {                                   // first sighting
      pkeys[slot] = key;
      pinfo[slot] = (tick << 8) | 1;
      pcol[slot] = (r << 16) | (g << 8) | b;
      return 0;
    }
    if (k === key) {
      const info = pinfo[slot];
      if ((info >>> 8) === tick) return 0;           // same frame — not a confirmation
      const hits = (info & 0xff) + 1;
      if (hits >= CONFIRM_HITS) {
        const c0 = pcol[slot];
        pkeys[slot] = 0;                             // free the slot
        commit(qx, qy, qz,
          (((c0 >>> 16) & 0xff) + r) >> 1,
          (((c0 >>> 8) & 0xff) + g) >> 1,
          ((c0 & 0xff) + b) >> 1,
          x, y, z, CONFIRM_HITS);
        _oi = count - 1;
        return 1;
      }
      pinfo[slot] = (tick << 8) | hits;
      return 0;
    }
    const age = tick - (pinfo[slot] >>> 8);
    if (age > evictAge) { evictAge = age; evict = slot; }
  }
  // chain full — replace the stalest pending entry (it was probably noise)
  pkeys[evict] = key;
  pinfo[evict] = (tick << 8) | 1;
  pcol[evict] = (r << 16) | (g << 8) | b;
  return 0;
}

/** demo-generator path: dedupe + store (or merge), no confirmation needed */
function addPoint(x, y, z, r, g, b) {
  if (count >= CAP) return false;
  const qx = Math.round(x / VOXEL), qy = Math.round(y / VOXEL), qz = Math.round(z / VOXEL);
  if (qx < -32700 || qx > 32700 || qy < -32700 || qy > 32700 || qz < -32700 || qz > 32700) return false;
  const i = findIndex(qx, qy, qz);
  if (i >= 0) { refine(i, x, y, z, r, g, b); return false; }
  commit(qx, qy, qz, r, g, b, x, y, z, CONFIRM_HITS);  // demo geometry is trusted
  return true;
}

function reply(outPos, outCol, added, updN) {
  const msg = {
    type: 'points', n: added, total: count, updN,
    ground: groundCells.size, min: min.slice(), max: max.slice(),
  };
  const transfer = [];
  if (added > 0) {
    const p = outPos.slice(0, added * 3);
    const c = outCol.slice(0, added * 3);
    msg.pos = p.buffer; msg.col = c.buffer;
    transfer.push(p.buffer, c.buffer);
  }
  if (updN > 0) {
    const ui = uIdx.slice(0, updN);
    const up = uPos.slice(0, updN * 3);
    const uc = uCol.slice(0, updN * 3);
    msg.updIdx = ui.buffer; msg.updPos = up.buffer; msg.updCol = uc.buffer;
    transfer.push(ui.buffer, up.buffer, uc.buffer);
  }
  postMessage(msg, transfer);
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
  let added = 0, updN = 0;

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

      const res = observe(wx, wy, wz, r, g, b);
      if (res === 1) {                       // newly committed point
        const j = added * 3, ci = _oi * 3;
        outPos[j] = pos[ci]; outPos[j + 1] = pos[ci + 1]; outPos[j + 2] = pos[ci + 2];
        outCol[j] = cols[ci]; outCol[j + 1] = cols[ci + 1]; outCol[j + 2] = cols[ci + 2];
        added++;
        if (count >= CAP) break outer;
      } else if (res === 2 && updN < MAX_UPD) {   // refined existing point
        const j = updN * 3, ci = _oi * 3;
        uIdx[updN] = _oi;
        uPos[j] = pos[ci]; uPos[j + 1] = pos[ci + 1]; uPos[j + 2] = pos[ci + 2];
        uCol[j] = cols[ci]; uCol[j + 1] = cols[ci + 1]; uCol[j + 2] = cols[ci + 2];
        updN++;
      }
    }
  }
  reply(outPos, outCol, added, updN);
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
      const j = added * 3, ci = (count - 1) * 3;
      outPos[j] = pos[ci]; outPos[j + 1] = pos[ci + 1]; outPos[j + 2] = pos[ci + 2];
      outCol[j] = cols[ci]; outCol[j + 1] = cols[ci + 1]; outCol[j + 2] = cols[ci + 2];
      added++;
    }
  }
  reply(outPos, outCol, added, 0);
}

const MIN_NEIGHBORS = 2;   // save-time: a real surface voxel touches its neighbors
const MIN_WEIGHT = 2;      // ...and was actually confirmed, not a one-off

/**
 * Pack the store into the shared 10-byte-per-point world format, dropping
 * isolated / weakly-seen specks (voxels with < MIN_NEIGHBORS of the 26
 * adjacent cells occupied, or weight below MIN_WEIGHT) and recomputing the
 * bounds from what's kept. Positions snap to the voxel grid (the format is a
 * voxel grid); the running average has already pulled color and live geometry
 * toward the truth and thinned the noise.
 */
function encode() {
  const keep = new Uint8Array(count);
  let kept = 0;
  const emin = [Infinity, Infinity, Infinity];
  const emax = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    if (wt[i] < MIN_WEIGHT) continue;
    const p = i * 3;
    const qx = qcell[p], qy = qcell[p + 1], qz = qcell[p + 2];
    let n = 0;
    scan:
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          if (dx === 0 && dy === 0 && dz === 0) continue;
          if (findIndex(qx + dx, qy + dy, qz + dz) >= 0 && ++n >= MIN_NEIGHBORS) break scan;
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
    out[o]     = qcell[p]     + 32768;
    out[o + 1] = qcell[p + 1] + 32768;
    out[o + 2] = qcell[p + 2] + 32768;
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
