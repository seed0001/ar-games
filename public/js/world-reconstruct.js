/**
 * Surface reconstruction worker — turns a raw scanned point cloud into a
 * clean, smooth, navigable surface.
 *
 * A scan is a noisy shell of 4 cm voxel points: scattered light/flying-pixel
 * specks floating in space, blocky stair-stepped surfaces, fuzzy trunks. This
 * worker cleans that up in three stages, entirely off the main thread:
 *
 *   1. Statistical outlier removal — a voxel with too few occupied neighbours
 *      is a speck, not a surface, and is dropped.
 *   2. Density-field reconstruction — every surviving point is splatted as a
 *      small Gaussian into a scalar field; the isosurface of that field is a
 *      single coherent skin threaded through the mass (a tube around a trunk,
 *      a sheet over the ground). Sparse scatter never accumulates enough
 *      density to reach the threshold, so it simply vanishes.
 *   3. Taubin smoothing — volume-preserving low-pass over the mesh that melts
 *      the remaining block stair-steps into smooth surfaces without shrinking
 *      the shape (the trunk keeps its girth, the ground keeps its gentle roll).
 *
 * Classic worker, zero imports. VOXEL must match public/js/world-format.js.
 */
'use strict';

const VOXEL = 0.04;

// grid hash shared with the rest of the pipeline (qx,qy,qz -> unique number)
const K = (x, y, z) => (x + 32768) * 4294967296 + (y + 32768) * 65536 + (z + 32768);

const CORNER = [[0,0,0],[1,0,0],[0,1,0],[1,1,0],[0,0,1],[1,0,1],[0,1,1],[1,1,1]];
const EDGE = [[0,1],[0,2],[0,4],[1,3],[1,5],[2,3],[2,6],[4,5],[4,6],[3,7],[5,7],[6,7]];

function reconstruct(positions, colors, count, opts) {
  const minSupport = opts.minSupport ?? 3;   // 3x3x3 occupied neighbours to survive
  const kernelR    = opts.kernelR ?? 2;       // Gaussian splat radius (voxels)
  const sigma      = opts.sigma ?? 1.3;       // Gaussian width (voxels)
  const iso        = opts.iso ?? 0.55;        // isosurface density threshold
  const smoothIters = opts.smoothIters ?? 4;  // Taubin passes

  /* ---- 1. voxelize (dedupe + average color) ---- */
  const idxOf = new Map();
  const vx = [], vy = [], vz = [], cr = [], cg = [], cb = [], cn = [];
  for (let i = 0; i < count; i++) {
    const p = i * 3;
    const qx = Math.round(positions[p] / VOXEL);
    const qy = Math.round(positions[p + 1] / VOXEL);
    const qz = Math.round(positions[p + 2] / VOXEL);
    const key = K(qx, qy, qz);
    let idx = idxOf.get(key);
    if (idx === undefined) {
      idx = vx.length;
      idxOf.set(key, idx);
      vx.push(qx); vy.push(qy); vz.push(qz);
      cr.push(colors[p]); cg.push(colors[p + 1]); cb.push(colors[p + 2]); cn.push(1);
    } else {
      cr[idx] += colors[p]; cg[idx] += colors[p + 1]; cb[idx] += colors[p + 2]; cn[idx]++;
    }
  }
  const nVox = vx.length;

  /* ---- 2. statistical outlier removal ---- */
  const alive = new Uint8Array(nVox);
  let survivors = 0;
  for (let i = 0; i < nVox; i++) {
    const x = vx[i], y = vy[i], z = vz[i];
    let n = 0;
    for (let dx = -1; dx <= 1 && n < minSupport; dx++)
      for (let dy = -1; dy <= 1 && n < minSupport; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          if (dx === 0 && dy === 0 && dz === 0) continue;
          if (idxOf.has(K(x + dx, y + dy, z + dz))) { if (++n >= minSupport) break; }
        }
    if (n >= minSupport) { alive[i] = 1; survivors++; }
  }

  /* ---- 3. splat survivors into a Gaussian density + color field ---- */
  const offs = [];
  for (let dx = -kernelR; dx <= kernelR; dx++)
    for (let dy = -kernelR; dy <= kernelR; dy++)
      for (let dz = -kernelR; dz <= kernelR; dz++)
        offs.push([dx, dy, dz, Math.exp(-(dx * dx + dy * dy + dz * dz) / (2 * sigma * sigma))]);

  const gIdx = new Map();               // gridKey -> field index
  let gx = [], gy = [], gz = [], gd = [], gr = [], gg = [], gb = [];
  for (let i = 0; i < nVox; i++) {
    if (!alive[i]) continue;
    const x = vx[i], y = vy[i], z = vz[i];
    const inv = 1 / cn[i];
    const r = cr[i] * inv, g = cg[i] * inv, b = cb[i] * inv;
    for (const [dx, dy, dz, w] of offs) {
      const gk = K(x + dx, y + dy, z + dz);
      let gi = gIdx.get(gk);
      if (gi === undefined) {
        gi = gd.length;
        gIdx.set(gk, gi);
        gx.push(x + dx); gy.push(y + dy); gz.push(z + dz);
        gd.push(0); gr.push(0); gg.push(0); gb.push(0);
      }
      gd[gi] += w; gr[gi] += w * r; gg[gi] += w * g; gb[gi] += w * b;
    }
  }
  const field = (x, y, z) => { const gi = gIdx.get(K(x, y, z)); return gi === undefined ? 0 : gd[gi]; };

  /* ---- 4. surface nets over the density field (indexed / welded) ---- */
  const cellVert = new Map();           // cellKey -> vertex id
  const px = [], py = [], pz = [], vr = [], vg = [], vb = [];
  const nGrid = gd.length;

  for (let c = 0; c < nGrid; c++) {
    const x = gx[c], y = gy[c], z = gz[c];
    const g = [
      field(x, y, z) - iso,         field(x + 1, y, z) - iso,
      field(x, y + 1, z) - iso,     field(x + 1, y + 1, z) - iso,
      field(x, y, z + 1) - iso,     field(x + 1, y, z + 1) - iso,
      field(x, y + 1, z + 1) - iso, field(x + 1, y + 1, z + 1) - iso,
    ];
    let pos = 0;
    for (let k = 0; k < 8; k++) if (g[k] > 0) pos++;
    if (pos === 0 || pos === 8) continue;   // no isosurface crossing in this cell

    let ax = 0, ay = 0, az = 0, cnt = 0;
    for (let e = 0; e < 12; e++) {
      const a = EDGE[e][0], bb = EDGE[e][1], ga = g[a], gbv = g[bb];
      if ((ga > 0) !== (gbv > 0)) {
        const t = ga / (ga - gbv), oa = CORNER[a], ob = CORNER[bb];
        ax += oa[0] + t * (ob[0] - oa[0]);
        ay += oa[1] + t * (ob[1] - oa[1]);
        az += oa[2] + t * (ob[2] - oa[2]);
        cnt++;
      }
    }
    ax /= cnt; ay /= cnt; az /= cnt;

    // color = density-weighted average over the 8 corner field points
    let sr = 0, sg = 0, sb = 0, sw = 0;
    for (let k = 0; k < 8; k++) {
      const gi = gIdx.get(K(x + CORNER[k][0], y + CORNER[k][1], z + CORNER[k][2]));
      if (gi !== undefined && gd[gi] > 0) { sr += gr[gi]; sg += gg[gi]; sb += gb[gi]; sw += gd[gi]; }
    }
    const id = px.length;
    cellVert.set(K(x, y, z), id);
    px.push((x + ax) * VOXEL); py.push((y + ay) * VOXEL); pz.push((z + az) * VOXEL);
    if (sw > 0) { vr.push(sr / sw); vg.push(sg / sw); vb.push(sb / sw); }
    else { vr.push(180); vg.push(180); vb.push(180); }
  }

  /* faces: quad per sign-changing minimal edge whose 4 cells all have vertices */
  const tris = [];
  for (let c = 0; c < nGrid; c++) {
    const x = gx[c], y = gy[c], z = gz[c];
    if (!cellVert.has(K(x, y, z))) continue;
    const s0 = field(x, y, z) - iso > 0;
    for (let i = 0; i < 3; i++) {
      const nb = i === 0 ? field(x + 1, y, z) : i === 1 ? field(x, y + 1, z) : field(x, y, z + 1);
      if (s0 === (nb - iso > 0)) continue;
      const iu = (i + 1) % 3, iv = (i + 2) % 3;
      const du = [iu === 0 ? 1 : 0, iu === 1 ? 1 : 0, iu === 2 ? 1 : 0];
      const dv = [iv === 0 ? 1 : 0, iv === 1 ? 1 : 0, iv === 2 ? 1 : 0];
      const a = cellVert.get(K(x, y, z));
      const b = cellVert.get(K(x - du[0], y - du[1], z - du[2]));
      const cc = cellVert.get(K(x - du[0] - dv[0], y - du[1] - dv[1], z - du[2] - dv[2]));
      const d = cellVert.get(K(x - dv[0], y - dv[1], z - dv[2]));
      if (a === undefined || b === undefined || cc === undefined || d === undefined) continue;
      tris.push(a, b, cc, a, cc, d);
    }
  }

  const nv = px.length;

  /* ---- 5. Taubin smoothing (λ | μ low-pass, volume preserving) ---- */
  if (smoothIters > 0 && nv > 0) {
    const adj = Array.from({ length: nv }, () => new Set());
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t], b = tris[t + 1], c = tris[t + 2];
      adj[a].add(b); adj[a].add(c); adj[b].add(a); adj[b].add(c); adj[c].add(a); adj[c].add(b);
    }
    const nbr = adj.map((s) => Array.from(s));
    let X = Float64Array.from(px), Y = Float64Array.from(py), Z = Float64Array.from(pz);
    const tX = new Float64Array(nv), tY = new Float64Array(nv), tZ = new Float64Array(nv);
    const pass = (lambda) => {
      for (let v = 0; v < nv; v++) {
        const ns = nbr[v], m = ns.length;
        if (m === 0) { tX[v] = X[v]; tY[v] = Y[v]; tZ[v] = Z[v]; continue; }
        let sx = 0, sy = 0, sz = 0;
        for (let j = 0; j < m; j++) { const u = ns[j]; sx += X[u]; sy += Y[u]; sz += Z[u]; }
        tX[v] = X[v] + lambda * (sx / m - X[v]);
        tY[v] = Y[v] + lambda * (sy / m - Y[v]);
        tZ[v] = Z[v] + lambda * (sz / m - Z[v]);
      }
      X.set(tX); Y.set(tY); Z.set(tZ);
    };
    for (let it = 0; it < smoothIters; it++) { pass(0.5); pass(-0.53); }
    for (let v = 0; v < nv; v++) { px[v] = X[v]; py[v] = Y[v]; pz[v] = Z[v]; }
  }

  /* ---- 6. pack indexed geometry ---- */
  const outPos = new Float32Array(nv * 3);
  const outCol = new Uint8Array(nv * 3);
  for (let v = 0; v < nv; v++) {
    outPos[v * 3] = px[v]; outPos[v * 3 + 1] = py[v]; outPos[v * 3 + 2] = pz[v];
    outCol[v * 3] = Math.max(0, Math.min(255, vr[v]));
    outCol[v * 3 + 1] = Math.max(0, Math.min(255, vg[v]));
    outCol[v * 3 + 2] = Math.max(0, Math.min(255, vb[v]));
  }
  const outIdx = (nv > 65535 ? Uint32Array : Uint32Array).from(tris);

  return {
    pos: outPos, col: outCol, idx: outIdx,
    stats: { input: count, voxels: nVox, survivors, removed: nVox - survivors, verts: nv, tris: tris.length / 3 },
  };
}

onmessage = (e) => {
  const m = e.data;
  if (m.type !== 'reconstruct') return;
  try {
    const r = reconstruct(new Float32Array(m.positions), new Uint8Array(m.colors), m.count, m.opts || {});
    postMessage({ type: 'done', ...r }, [r.pos.buffer, r.col.buffer, r.idx.buffer]);
  } catch (err) {
    postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
