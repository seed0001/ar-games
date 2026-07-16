/**
 * Shared binary format for scanned worlds.
 *
 * A world is a flat list of voxel-deduped points. One record = 10 bytes,
 * five little-endian uint16s:
 *   [0] qx + 32768     quantized x  (world metres / VOXEL)
 *   [1] qy + 32768     quantized y
 *   [2] qz + 32768     quantized z
 *   [3] r << 8 | g     color
 *   [4] b << 8         color (low byte reserved)
 */

export const VOXEL = 0.04;        // metres per voxel cell
export const RECORD_BYTES = 10;

export function encodePoints(qpos /* Int16Array */, cols /* Uint8Array */, count) {
  const out = new Uint16Array(count * 5);
  for (let i = 0; i < count; i++) {
    const p = i * 3, o = i * 5;
    out[o]     = qpos[p]     + 32768;
    out[o + 1] = qpos[p + 1] + 32768;
    out[o + 2] = qpos[p + 2] + 32768;
    out[o + 3] = (cols[p] << 8) | cols[p + 1];
    out[o + 4] = cols[p + 2] << 8;
  }
  return new Uint8Array(out.buffer);
}

export function decodePoints(arrayBuffer) {
  const u16 = new Uint16Array(arrayBuffer);
  const count = Math.floor(u16.length / 5);
  const positions = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 3);
  for (let i = 0; i < count; i++) {
    const p = i * 3, o = i * 5;
    positions[p]     = (u16[o]     - 32768) * VOXEL;
    positions[p + 1] = (u16[o + 1] - 32768) * VOXEL;
    positions[p + 2] = (u16[o + 2] - 32768) * VOXEL;
    colors[p]     = u16[o + 3] >> 8;
    colors[p + 1] = u16[o + 3] & 0xff;
    colors[p + 2] = u16[o + 4] >> 8;
  }
  return { count, positions, colors };
}
