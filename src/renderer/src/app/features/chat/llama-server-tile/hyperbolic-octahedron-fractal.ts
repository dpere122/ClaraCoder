import type { BufferGeometry, Group, MeshStandardMaterial } from 'three';

type ThreeModule = typeof import('three');

/** Fractal used in the Model Status viewport. */
export const HYPERBOLIC_OCTAHEDRON_FRACTAL_NAME =
  'Hyperbolic Octahedron Fractal | Additive Sierpinski Style' as const;

/** Single hyperbolic octahedron before the llama model is loaded. */
export const FRACTAL_LEVEL_IDLE = 1;

/** Full additive recursion once the llama model is loaded. */
export const FRACTAL_LEVEL_LOADED = 3;

/** Default recursion depth when no level is specified. */
export const FRACTAL_LEVEL = FRACTAL_LEVEL_LOADED;

const UNIT_RADIUS = 1;

/** Triangles per octahedron face edge. */
const FACE_SEGMENTS = 30;

/** Octahedron axis tips (6 vertices along principal axes). */
const OCTA_VERTICES: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/** Eight triangular faces (vertex indices). */
const OCTA_FACES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 2, 4],
  [0, 4, 3],
  [0, 3, 5],
  [0, 5, 2],
  [1, 4, 2],
  [1, 2, 5],
  [1, 5, 3],
  [1, 3, 4],
];

const VERTEX_DIRS = OCTA_VERTICES;

/** Placement factor — 1.0 = copies touch at center, <1.0 = overlap, >1.0 = gap. */
const ADDITIVE_PLACEMENT = 1.0;

function cultsLevelToDepth(level: number): number {
  return Math.max(0, Math.min(4, Math.floor(level) - 1));
}

/**
 * Additive hyperbolic profile: sharp needle tips, deeply concave faces, smooth curved edges.
 * Matches the characteristic "pinched" hyperbolic octahedron silhouette.
 */
function hyperbolicRadiusScale(ax: number, ay: number, az: number): number {
  const sum = ax + ay + az + 1e-8;
  const maxAxis = Math.max(ax, ay, az);
  const minAxis = Math.min(ax, ay, az);
  const corner = maxAxis / sum;
  const face = 1 - corner;
  const edge = 1 - minAxis / (maxAxis + 1e-8);

  const spike = 1.25;
  const bowl = 0.72;
  const edgeCurve = 0.28;
  const edgeMask = (1 - corner) ** 2;

  return Math.max(
    0.62,
    1 + spike * corner ** 3.5 - bowl * face ** 1.6 + edgeCurve * edge ** 2.5 * edgeMask,
  );
}

function samplePointOnFace(
  va: readonly [number, number, number],
  vb: readonly [number, number, number],
  vc: readonly [number, number, number],
  u: number,
  v: number,
  radius: number,
): [number, number, number] {
  const w = 1 - u - v;
  let x = va[0] * u + vb[0] * v + vc[0] * w;
  let y = va[1] * u + vb[1] * v + vc[1] * w;
  let z = va[2] * u + vb[2] * v + vc[2] * w;
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const az = Math.abs(z);
  const len = Math.hypot(x, y, z) || 1;
  const scale = radius * hyperbolicRadiusScale(ax, ay, az);
  x = (x / len) * scale;
  y = (y / len) * scale;
  z = (z / len) * scale;
  const equatorScale = 0.78;
  const axisScale = 0.94;
  x *= equatorScale;
  y *= equatorScale;
  z *= axisScale;
  return [x, y, z];
}

/** One additive hyperbolic octahedron unit (faceted). */
function buildHyperbolicOctahedronUnitGeometry(T: ThreeModule, radius: number, faceSegments: number) {
  const positions: number[] = [];
  const indices: number[] = [];
  const seg = Math.max(2, faceSegments);

  for (const [ia, ib, ic] of OCTA_FACES) {
    const va = OCTA_VERTICES[ia]!;
    const vb = OCTA_VERTICES[ib]!;
    const vc = OCTA_VERTICES[ic]!;
    const faceBase = positions.length / 3;

    for (let i = 0; i <= seg; i++) {
      for (let j = 0; j <= seg - i; j++) {
        const u = i / seg;
        const v = j / seg;
        const [x, y, z] = samplePointOnFace(va, vb, vc, u, v, radius);
        positions.push(x, y, z);
      }
    }

    const rowStart = (row: number) => row * (seg + 1) - (row * (row - 1)) / 2;
    for (let i = 0; i < seg; i++) {
      for (let j = 0; j < seg - i; j++) {
        const a = faceBase + rowStart(i) + j;
        const b = faceBase + rowStart(i + 1) + j;
        const c = faceBase + rowStart(i) + j + 1;
        indices.push(a, b, c);
        if (j < seg - i - 1) {
          const d = faceBase + rowStart(i + 1) + j + 1;
          indices.push(b, d, c);
        }
      }
    }
  }

  const geom = new T.BufferGeometry();
  geom.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  return geom;
}

interface FractalPlacement {
  x: number;
  y: number;
  z: number;
  radius: number;
}

export interface FractalAnimUnit {
  group: Group;
  targetX: number;
  targetY: number;
  targetZ: number;
  targetRadius: number;
  order: number;
}

export interface HyperbolicOctahedronFractalAssembly {
  root: Group;
  idleUnit: Group;
  units: FractalAnimUnit[];
  pulseMaterials: MeshStandardMaterial[];
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function easeOutCubic(t: number): number {
  const x = clamp01(t);
  return 1 - (1 - x) ** 3;
}

function easeInOutCubic(t: number): number {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

/** Staggered reveal: idle unit fades as leaf copies bloom from the center. */
export function applyFractalMultiplyAnimation(
  idleUnit: Group,
  units: ReadonlyArray<FractalAnimUnit>,
  progress: number,
): void {
  const p = clamp01(progress);
  const idleScale = 1 - easeInOutCubic(p);
  idleUnit.visible = idleScale > 0.02;
  idleUnit.scale.setScalar(idleScale);

  const staggerSpan = 0.68;
  const growWindow = 1 - staggerSpan;
  for (const unit of units) {
    const local = clamp01((p - (unit.order / Math.max(units.length, 1)) * staggerSpan) / growWindow);
    const t = easeOutCubic(local);
    unit.group.position.set(unit.targetX * t, unit.targetY * t, unit.targetZ * t);
    unit.group.scale.setScalar(unit.targetRadius * t);
    unit.group.visible = t > 0.02;
  }
}
/**
 * Additive Sierpinski: builds fractal by placing smaller copies at each vertex direction.
 * At depth 0, a single hyperbolic octahedron is placed.
 * At deeper levels, 6 half-scale copies are arranged at each vertex position,
 * meeting at the center to form the recognizable recursive pattern.
 */
function collectAdditiveSierpinskiPlacements(
  out: FractalPlacement[],
  depth: number,
  x: number,
  y: number,
  z: number,
  radius: number,
): void {
  if (depth <= 0) {
    out.push({ x, y, z, radius });
    return;
  }
  const childRadius = radius * 0.5;
  const offset = radius * ADDITIVE_PLACEMENT;
  for (const [dx, dy, dz] of VERTEX_DIRS) {
    collectAdditiveSierpinskiPlacements(
      out,
      depth - 1,
      x + dx * offset,
      y + dy * offset,
      z + dz * offset,
      childRadius,
    );
  }
}

function createFractalBodyMaterial(T: ThreeModule): MeshStandardMaterial {
  const bodyMat = new T.MeshStandardMaterial({
    color: new T.Color(0.92, 0.91, 0.89),
    metalness: 0.12,
    roughness: 0.48,
    emissive: new T.Color(0.08, 0.08, 0.08),
    emissiveIntensity: 0.05,
    flatShading: true,
  });
  bodyMat.userData['emissiveScale'] = 1;
  return bodyMat;
}

/**
 * Animatable assembly: one idle unit plus leaf copies that bloom outward when multiplied.
 */
export function createHyperbolicOctahedronFractalAssembly(
  T: ThreeModule,
  level: number = FRACTAL_LEVEL_LOADED,
): HyperbolicOctahedronFractalAssembly {
  const depth = cultsLevelToDepth(level);
  const placements: FractalPlacement[] = [];
  collectAdditiveSierpinskiPlacements(placements, depth, 0, 0, 0, UNIT_RADIUS);

  const bodyMat = createFractalBodyMaterial(T);
  const unitGeom = buildHyperbolicOctahedronUnitGeometry(T, 1, FACE_SEGMENTS);

  const root = new T.Group();
  root.scale.set(0.82, 1.12, 0.82);
  root.rotation.x = 0.42;
  root.rotation.y = Math.PI / 4;

  const idleUnit = new T.Group();
  idleUnit.add(new T.Mesh(unitGeom, bodyMat));
  root.add(idleUnit);

  const sorted = placements
    .map((p, index) => ({ ...p, index }))
    .sort((a, b) => Math.hypot(a.x, a.y, a.z) - Math.hypot(b.x, b.y, b.z) || a.index - b.index);

  const units: FractalAnimUnit[] = sorted.map((p, order) => {
    const group = new T.Group();
    group.add(new T.Mesh(unitGeom.clone(), bodyMat));
    root.add(group);
    return {
      group,
      targetX: p.x,
      targetY: p.y,
      targetZ: p.z,
      targetRadius: p.radius,
      order,
    };
  });

  applyFractalMultiplyAnimation(idleUnit, units, 0);

  return { root, idleUnit, units, pulseMaterials: [bodyMat] };
}

/**
 * **Hyperbolic Octahedron Fractal | Additive Sierpinski Style**
 *
 * Builds the classic Sierpinski octahedron pattern additively using hyperbolic octahedrons.
 * Each recursion level places 6 half-scale copies at vertex positions, meeting at the center.
 * The hyperbolic profile gives each unit sharp needle tips and deeply concave faces,
 * creating the characteristic "pinched" silhouette with smooth curved edges.
 */
export function createHyperbolicOctahedronFractalModel(
  T: ThreeModule,
  level: number = FRACTAL_LEVEL,
): {
  root: Group;
  pulseMaterials: MeshStandardMaterial[];
} {
  const depth = cultsLevelToDepth(level);
  const placements: FractalPlacement[] = [];
  collectAdditiveSierpinskiPlacements(placements, depth, 0, 0, 0, UNIT_RADIUS);

  const bodyMat = createFractalBodyMaterial(T);

  const unitGeom = buildHyperbolicOctahedronUnitGeometry(T, 1, FACE_SEGMENTS);
  const mergedParts: BufferGeometry[] = [];
  const matrix = new T.Matrix4();
  const position = new T.Vector3();
  const quaternion = new T.Quaternion();
  const scale = new T.Vector3();

  for (const p of placements) {
    position.set(p.x, p.y, p.z);
    scale.set(p.radius, p.radius, p.radius);
    matrix.compose(position, quaternion, scale);
    const part = unitGeom.clone();
    part.applyMatrix4(matrix);
    mergedParts.push(part);
  }

  unitGeom.dispose();

  const geom =
    mergedParts.length === 1
      ? mergedParts[0]!
      : mergeGeometriesSync(T, mergedParts);
  if (mergedParts.length > 1) {
    for (const g of mergedParts) {
      g.dispose();
    }
  }

  const mesh = new T.Mesh(geom, bodyMat);
  const root = new T.Group();
  root.add(mesh);
  root.scale.set(0.82, 1.12, 0.82);
  root.rotation.x = 0.42;
  root.rotation.y = Math.PI / 4;

  return { root, pulseMaterials: [bodyMat] };
}

function mergeGeometriesSync(T: ThreeModule, parts: BufferGeometry[]) {
  const positions: number[] = [];
  const indices: number[] = [];
  let vertexOffset = 0;

  for (const geom of parts) {
    const posAttr = geom.attributes['position'];
    const idxAttr = geom.index;
    if (!posAttr) {
      continue;
    }
    for (let i = 0; i < posAttr.count; i++) {
      positions.push(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
    }
    if (idxAttr) {
      for (let i = 0; i < idxAttr.count; i++) {
        indices.push(idxAttr.getX(i) + vertexOffset);
      }
    } else {
      for (let i = 0; i < posAttr.count; i++) {
        indices.push(vertexOffset + i);
      }
    }
    vertexOffset += posAttr.count;
  }

  const merged = new T.BufferGeometry();
  merged.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
  merged.setIndex(indices);
  merged.computeVertexNormals();
  return merged;
}
