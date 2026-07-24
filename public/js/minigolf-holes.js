/**
 * MINI-GOLF — 18 hand-designed holes.
 *
 * Pure data, no rendering/physics here (see xr-minigolf.js). Everything is
 * in meters on the green's local XZ plane, origin at the green's center.
 * The green itself is an implicit closed rectangle [-w/2,w/2] x [-d/2,d/2] —
 * xr-minigolf.js builds the perimeter walls from `w`/`d` automatically.
 *
 * walls:     interior line-segment barriers {x1,z1,x2,z2,h?}
 * ramps:     sloped rectangular zones that push the ball {x,z,w,d,rotY?,dir:[dx,dz],accel}
 * obstacles: static solids the ball bounces off {type:'box'|'cylinder', x,z, w?,d?,radius?, rotY?, h?}
 * hazards:   rectangular zones {type:'water'|'sand', x,z,w,d} — water resets + 1 stroke, sand adds friction
 * decor:     purely visual, never collides {type:'spinner', x,z, radius, speed}
 */

export const BALL_RADIUS = 0.012;

export const HOLES = [
  { id: 1, par: 2, w: 0.65, d: 0.35,
    tee: [-0.24, 0], cup: [0.24, 0], cupRadius: 0.028,
    walls: [], ramps: [], obstacles: [], hazards: [] },

  { id: 2, par: 2, w: 0.7, d: 0.42,
    tee: [-0.28, -0.1], cup: [0.28, 0.1], cupRadius: 0.028,
    walls: [], ramps: [], obstacles: [{ type: 'cylinder', x: 0, z: 0.02, radius: 0.045 }], hazards: [] },

  { id: 3, par: 3, w: 0.9, d: 0.5,
    tee: [-0.36, 0.16], cup: [0.36, -0.16], cupRadius: 0.028,
    walls: [{ x1: 0, z1: -0.25, x2: 0, z2: 0.06, h: 0.045 }], ramps: [], obstacles: [], hazards: [] },

  { id: 4, par: 3, w: 1.0, d: 0.45,
    tee: [-0.42, -0.14], cup: [0.42, 0.14], cupRadius: 0.028,
    walls: [
      { x1: -0.12, z1: -0.225, x2: -0.12, z2: 0.05, h: 0.045 },
      { x1: 0.14,  z1: -0.05,  x2: 0.14,  z2: 0.225, h: 0.045 },
    ], ramps: [], obstacles: [], hazards: [] },

  { id: 5, par: 3, w: 0.8, d: 0.4,
    tee: [-0.3, 0], cup: [0.32, 0], cupRadius: 0.03,
    walls: [], obstacles: [],
    ramps: [{ x: 0, z: 0, w: 0.34, d: 0.4, dir: [1, 0], accel: 0.42 }], hazards: [] },

  { id: 6, par: 3, w: 0.85, d: 0.4,
    tee: [-0.32, 0], cup: [0.32, 0], cupRadius: 0.028,
    walls: [], ramps: [],
    obstacles: [
      { type: 'cylinder', x: 0, z: -0.09, radius: 0.032 },
      { type: 'cylinder', x: 0, z: 0.09,  radius: 0.032 },
    ],
    hazards: [],
    decor: [{ type: 'spinner', x: 0, z: 0, radius: 0.075, speed: 1.4 }] },

  { id: 7, par: 3, w: 0.9, d: 0.5,
    tee: [-0.36, -0.18], cup: [0.36, 0.18], cupRadius: 0.028,
    walls: [], ramps: [], obstacles: [],
    hazards: [{ type: 'water', x: 0, z: 0, w: 0.32, d: 0.3 }] },

  { id: 8, par: 3, w: 0.9, d: 0.4,
    tee: [-0.34, 0], cup: [0.34, 0], cupRadius: 0.028,
    walls: [], ramps: [], obstacles: [],
    hazards: [{ type: 'sand', x: 0, z: 0, w: 0.36, d: 0.32 }] },

  { id: 9, par: 4, w: 1.0, d: 0.5,
    tee: [-0.4, -0.16], cup: [0.4, 0.16], cupRadius: 0.028,
    walls: [], ramps: [],
    obstacles: [{ type: 'box', x: 0, z: 0, w: 0.26, d: 0.16, rotY: 0 }], hazards: [] },

  { id: 10, par: 4, w: 1.05, d: 0.55,
    tee: [-0.44, 0.2], cup: [0.44, -0.2], cupRadius: 0.028,
    walls: [
      { x1: -0.16, z1: 0.275,  x2: -0.16, z2: -0.02, h: 0.045 },
      { x1: 0.02,  z1: -0.02,  x2: 0.02,  z2: 0.16,  h: 0.045 },
      { x1: 0.2,   z1: 0.16,   x2: 0.2,   z2: -0.275, h: 0.045 },
    ], ramps: [], obstacles: [], hazards: [] },

  { id: 11, par: 4, w: 1.0, d: 0.5,
    tee: [-0.4, 0], cup: [0.4, 0], cupRadius: 0.028,
    walls: [],
    obstacles: [{ type: 'box', x: -0.05, z: -0.14, w: 0.2, d: 0.18, rotY: 0 }],
    ramps: [], hazards: [] },

  { id: 12, par: 4, w: 1.1, d: 0.55,
    tee: [-0.46, 0], cup: [0.46, 0], cupRadius: 0.026,
    walls: [
      { x1: -0.08, z1: -0.275, x2: -0.08, z2: -0.09, h: 0.045 },
      { x1: -0.08, z1: 0.09,   x2: -0.08, z2: 0.275,  h: 0.045 },
    ],
    ramps: [], obstacles: [],
    hazards: [{ type: 'water', x: -0.08, z: 0, w: 0.18, d: 0.18 }] },

  { id: 13, par: 4, w: 1.1, d: 0.5,
    tee: [-0.46, 0], cup: [0.46, 0], cupRadius: 0.026,
    walls: [], ramps: [],
    obstacles: [
      { type: 'cylinder', x: -0.14, z: -0.1, radius: 0.04 },
      { type: 'cylinder', x: 0,     z: 0.11, radius: 0.04 },
      { type: 'cylinder', x: 0.16,  z: -0.08, radius: 0.04 },
    ], hazards: [] },

  { id: 14, par: 5, w: 1.25, d: 0.5,
    tee: [-0.54, 0], cup: [0.54, 0], cupRadius: 0.026,
    walls: [], obstacles: [],
    ramps: [
      { x: -0.24, z: 0, w: 0.3, d: 0.5, dir: [-1, 0], accel: 0.3 },
      { x: 0.24,  z: 0, w: 0.3, d: 0.5, dir: [1, 0],  accel: 0.3 },
    ],
    hazards: [{ type: 'water', x: 0, z: 0, w: 0.24, d: 0.22 }] },

  { id: 15, par: 5, w: 1.15, d: 0.5,
    tee: [-0.48, -0.16], cup: [0.48, 0.16], cupRadius: 0.026,
    walls: [{ x1: 0.06, z1: -0.05, x2: 0.06, z2: 0.275, h: 0.045 }],
    obstacles: [
      { type: 'cylinder', x: -0.1, z: 0.05, radius: 0.032 },
      { type: 'cylinder', x: -0.1, z: -0.11, radius: 0.032 },
    ],
    ramps: [], hazards: [],
    decor: [{ type: 'spinner', x: -0.1, z: -0.03, radius: 0.07, speed: 1.1 }] },

  { id: 16, par: 5, w: 1.2, d: 0.55,
    tee: [-0.5, 0.2], cup: [0.5, -0.2], cupRadius: 0.026,
    walls: [
      { x1: -0.14, z1: 0.275, x2: -0.14, z2: 0.02, h: 0.045 },
      { x1: 0.14,  z1: -0.02, x2: 0.14,  z2: -0.275, h: 0.045 },
    ],
    ramps: [],
    obstacles: [],
    hazards: [
      { type: 'sand', x: -0.14, z: -0.1, w: 0.2, d: 0.16 },
      { type: 'water', x: 0.14, z: 0.1, w: 0.2, d: 0.16 },
    ] },

  { id: 17, par: 5, w: 1.2, d: 0.5,
    tee: [-0.5, 0], cup: [0.5, 0], cupRadius: 0.024,
    walls: [
      { x1: -0.28, z1: -0.25, x2: -0.28, z2: 0.06, h: 0.045 },
      { x1: -0.06, z1: -0.06, x2: -0.06, z2: 0.25,  h: 0.045 },
      { x1: 0.16,  z1: -0.25, x2: 0.16,  z2: 0.06,  h: 0.045 },
    ], ramps: [], obstacles: [], hazards: [] },

  { id: 18, par: 5, w: 1.3, d: 0.55,
    tee: [-0.56, -0.18], cup: [0.56, 0.18], cupRadius: 0.024,
    walls: [{ x1: 0.34, z1: -0.06, x2: 0.34, z2: 0.275, h: 0.045 }],
    obstacles: [
      { type: 'cylinder', x: 0.05, z: 0.16,  radius: 0.032 },
      { type: 'cylinder', x: 0.05, z: 0.02,  radius: 0.032 },
    ],
    ramps: [{ x: -0.28, z: 0, w: 0.34, d: 0.55, dir: [1, 0], accel: 0.34 }],
    hazards: [{ type: 'water', x: -0.02, z: -0.16, w: 0.22, d: 0.18 }],
    decor: [{ type: 'spinner', x: 0.05, z: 0.09, radius: 0.08, speed: 1.6 }] },
];
