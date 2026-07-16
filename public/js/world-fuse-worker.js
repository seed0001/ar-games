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

/* ---------------- volumetric surface (TSDF -> mesh) ----------------
 * A second, parallel representation of the scan used purely for the live
 * mesh. Space is diced into 8³-voxel blocks (32 cm) stored sparsely; each
 * voxel accumulates a weighted truncated signed distance plus averaged
 * color. Revisiting a spot raises its weight, tightening the surface and
 * refining color — that is what makes the framework "fill in".
 */
const B = 8;                      // voxels per block edge
const B3 = B * B * B;
const TRUNC = 3 * VOXEL;          // 0.12 m signed-distance truncation band
const TSTEP = VOXEL;              // ray-march step when carving the band
const KT = 3;                     // samples each side of the surface (±TRUNC)
const WMIN = 2;                   // a voxel is "known solid" only after this many hits
const WMAX = 24;                  // weight saturation (revisits keep influence, bounded)
const MESH_BUDGET = 6;            // dirty blocks re-meshed per fuse tick (phone budget)

const CORNER = [[0,0,0],[1,0,0],[0,1,0],[1,1,0],[0,0,1],[1,0,1],[0,1,1],[1,1,1]];
const EDGE = [[0,1],[0,2],[0,4],[1,3],[1,5],[2,3],[2,6],[4,5],[4,6],[3,7],[5,7],[6,7]];

let blocks = new Map();           // blockKey -> block record
let dirty = new Set();            // block keys awaiting a re-mesh
const _cellVert = new Int32Array(B3);   // scratch: cell -> emitted vertex id

const blockKey = (bx, by, bz) => ((bx + 1024) * 2048 + (by + 1024)) * 2048 + (bz + 1024);

function getBlock(bx, by, bz) {
  const k = blockKey(bx, by, bz);
  let bl = blocks.get(k);
  if (!bl) {
    bl = {
      key: k, bx, by, bz,
      tsdf: new Float32Array(B3), w: new Float32Array(B3),
      cr: new Float32Array(B3), cg: new Float32Array(B3),
      cb: new Float32Array(B3), cw: new Float32Array(B3),
    };
    blocks.set(k, bl);
  }
  return bl;
}

/** fold one signed-distance observation into the voxel grid */
function voxelUpdate(vx, vy, vz, sdf, wr, r, g, b, colorSample) {
  const bx = vx >> 3, by = vy >> 3, bz = vz >> 3;
  const bl = getBlock(bx, by, bz);
  const i = (((vx - (bx << 3)) * B) + (vy - (by << 3))) * B + (vz - (bz << 3));
  const w0 = bl.w[i];
  bl.tsdf[i] = (bl.tsdf[i] * w0 + sdf * wr) / (w0 + wr);
  bl.w[i] = Math.min(WMAX, w0 + wr);
  if (colorSample) { bl.cr[i] += r; bl.cg[i] += g; bl.cb[i] += b; bl.cw[i] += 1; }
  dirty.add(bl.key);
}

/** signed-distance corner sample; unseen / under-confirmed cells read as "outside" */
const cornerVal = (bl, lx, ly, lz) => {
  const i = (lx * B + ly) * B + lz;
  return bl.w[i] < WMIN ? 1.0 : bl.tsdf[i];
};

/**
 * Naive surface nets over a single block: one vertex per surface cell placed
 * at the average of its edge zero-crossings, quads across sign-changing edges.
 * Blocks mesh independently (a ~4 cm seam between blocks is tolerated for now),
 * so any dirty block re-meshes without touching its neighbors.
 */
function meshBlock(bl) {
  _cellVert.fill(-1);
  const vX = [], vY = [], vZ = [], vR = [], vG = [], vB = [], vC = [];
  const quads = [];
  const ox = bl.bx * B, oy = bl.by * B, oz = bl.bz * B;

  for (let x = 0; x < B - 1; x++)
    for (let y = 0; y < B - 1; y++)
      for (let z = 0; z < B - 1; z++) {
        const g = [
          cornerVal(bl, x, y, z),     cornerVal(bl, x + 1, y, z),
          cornerVal(bl, x, y + 1, z), cornerVal(bl, x + 1, y + 1, z),
          cornerVal(bl, x, y, z + 1), cornerVal(bl, x + 1, y, z + 1),
          cornerVal(bl, x, y + 1, z + 1), cornerVal(bl, x + 1, y + 1, z + 1),
        ];
        let neg = 0;
        for (let c = 0; c < 8; c++) if (g[c] < 0) neg++;

        if (neg !== 0 && neg !== 8) {
          let ax = 0, ay = 0, az = 0, cnt = 0;
          for (let e = 0; e < 12; e++) {
            const a = EDGE[e][0], bb = EDGE[e][1], ga = g[a], gb = g[bb];
            if ((ga < 0) !== (gb < 0)) {
              const t = ga / (ga - gb), oa = CORNER[a], ob = CORNER[bb];
              ax += oa[0] + t * (ob[0] - oa[0]);
              ay += oa[1] + t * (ob[1] - oa[1]);
              az += oa[2] + t * (ob[2] - oa[2]);
              cnt++;
            }
          }
          ax /= cnt; ay /= cnt; az /= cnt;

          let cr = 0, cg = 0, cb = 0, cc = 0, maxw = 0;
          for (let c = 0; c < 8; c++) {
            const i = ((x + CORNER[c][0]) * B + (y + CORNER[c][1])) * B + (z + CORNER[c][2]);
            if (bl.w[i] >= WMIN) {
              if (bl.cw[i] > 0) { cr += bl.cr[i] / bl.cw[i]; cg += bl.cg[i] / bl.cw[i]; cb += bl.cb[i] / bl.cw[i]; cc++; }
              if (bl.w[i] > maxw) maxw = bl.w[i];
            }
          }
          const id = vX.length;
          _cellVert[(x * B + y) * B + z] = id;
          vX.push((ox + x + ax) * VOXEL); vY.push((oy + y + ay) * VOXEL); vZ.push((oz + z + az) * VOXEL);
          if (cc > 0) { vR.push(cr / cc); vG.push(cg / cc); vB.push(cb / cc); }
          else { vR.push(200); vG.push(200); vB.push(200); }
          vC.push(maxw / WMAX);
        }

        // faces: emit a quad for each sign-changing minimal edge whose four
        // surrounding cells (all "earlier" in the scan order) have vertices
        const s0 = g[0] < 0;
        for (let i = 0; i < 3; i++) {
          const gi = i === 0 ? g[1] : i === 1 ? g[2] : g[4];
          if (s0 === (gi < 0)) continue;
          const iu = (i + 1) % 3, iv = (i + 2) % 3;
          const coord = [x, y, z];
          if (coord[iu] < 1 || coord[iv] < 1) continue;
          const du = [iu === 0 ? 1 : 0, iu === 1 ? 1 : 0, iu === 2 ? 1 : 0];
          const dv = [iv === 0 ? 1 : 0, iv === 1 ? 1 : 0, iv === 2 ? 1 : 0];
          const ci = (px, py, pz) => _cellVert[(px * B + py) * B + pz];
          const a = ci(x, y, z);
          const b = ci(x - du[0], y - du[1], z - du[2]);
          const c = ci(x - du[0] - dv[0], y - du[1] - dv[1], z - du[2] - dv[2]);
          const d = ci(x - dv[0], y - dv[1], z - dv[2]);
          if (a < 0 || b < 0 || c < 0 || d < 0) continue;
          quads.push(a, b, c, d);
        }
      }

  const nQ = quads.length / 4;
  if (nQ === 0) return { msg: { type: 'mesh', key: bl.key, bx: bl.bx, by: bl.by, bz: bl.bz, empty: true } };

  const nOut = nQ * 6;
  const pos = new Float32Array(nOut * 3);
  const col = new Uint8Array(nOut * 3);
  const conf = new Uint8Array(nOut);
  let o = 0;
  const emit = (id) => {
    pos[o * 3] = vX[id]; pos[o * 3 + 1] = vY[id]; pos[o * 3 + 2] = vZ[id];
    col[o * 3] = vR[id]; col[o * 3 + 1] = vG[id]; col[o * 3 + 2] = vB[id];
    conf[o] = Math.max(0, Math.min(255, vC[id] * 255));
    o++;
  };
  for (let q = 0; q < nQ; q++) {
    const a = quads[q * 4], b = quads[q * 4 + 1], c = quads[q * 4 + 2], d = quads[q * 4 + 3];
    emit(a); emit(b); emit(c); emit(a); emit(c); emit(d);
  }
  return {
    msg: { type: 'mesh', key: bl.key, bx: bl.bx, by: bl.by, bz: bl.bz, pos: pos.buffer, col: col.buffer, conf: conf.buffer },
    transfer: [pos.buffer, col.buffer, conf.buffer],
  };
}

/** re-mesh up to `budget` dirty blocks and post each result */
function meshDirty(budget) {
  let n = 0;
  for (const key of dirty) {
    if (n >= budget) break;
    dirty.delete(key); n++;
    const bl = blocks.get(key);
    if (!bl) continue;
    const r = meshBlock(bl);
    if (r.transfer) postMessage(r.msg, r.transfer);
    else postMessage(r.msg);
  }
}

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
  blocks = new Map();
  dirty = new Set();
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
  const cx = view[12], cy = view[13], cz = view[14];   // camera world position
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

      // volumetric fusion for the live mesh: carve the signed-distance band
      // along this pixel's camera ray (free space in front, solid behind)
      let rx = wx - cx, ry = wy - cy, rz = wz - cz;
      const dist = Math.sqrt(rx * rx + ry * ry + rz * rz);
      if (dist > 1e-3) {
        const inv = 1 / dist; rx *= inv; ry *= inv; rz *= inv;
        for (let k = -KT; k <= KT; k++) {
          const t = k * TSTEP;
          const vx = Math.round((wx + rx * t) / VOXEL);
          const vy = Math.round((wy + ry * t) / VOXEL);
          const vz = Math.round((wz + rz * t) / VOXEL);
          if (vx < -32700 || vx > 32700 || vy < -32700 || vy > 32700 || vz < -32700 || vz > 32700) continue;
          let sdf = -t / TRUNC;
          if (sdf > 1) sdf = 1; else if (sdf < -1) sdf = -1;
          voxelUpdate(vx, vy, vz, sdf, 1, r, g, b, k === 0);
        }
      }

      if (count >= CAP) break outer;
    }
  }
  meshDirty(MESH_BUDGET);
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
    const x = pts[o], y = pts[o + 1], z = pts[o + 2];
    const r = pts[o + 3], g = pts[o + 4], b = pts[o + 5];
    if (addPoint(x, y, z, r, g, b)) {
      const j = added * 3;
      outPos[j] = x; outPos[j + 1] = y; outPos[j + 2] = z;
      outCol[j] = r; outCol[j + 1] = g; outCol[j + 2] = b;
      added++;
    }
    // seed the surface volume too: no camera ray here, so mark this voxel
    // solid and let its unseen neighbours read as "outside" (a thin shell)
    const vx = Math.round(x / VOXEL), vy = Math.round(y / VOXEL), vz = Math.round(z / VOXEL);
    if (vx >= -32700 && vx <= 32700 && vy >= -32700 && vy <= 32700 && vz >= -32700 && vz <= 32700)
      voxelUpdate(vx, vy, vz, -0.6, WMAX, r, g, b, true);
  }
  meshDirty(1e9);   // demo is generated once — flush every dirty block now
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
