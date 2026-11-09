import { boxMesh } from './box';
import { extrudeMesh } from './extrude';
import { coneMesh, cylinderMesh, latheMesh } from './lathe';
import { loftMesh } from './loft';
import {
  meshBounds,
  mergeMeshes,
  triangleCount,
  unionBounds,
  type Bounds,
  type MeshData,
} from './meshData';
import { sweepMesh } from './sweep';
import { applyMatrix, transformMatrix } from './transform';
import {
  isTextureMaterial,
  type Material,
  type Rgb,
  type Shape,
  type TemplateTable,
} from './types';
import { projectUvs } from './uv';

/** 没有任何材质时的颜色（浅灰）。 */
export const DEFAULT_COLOR: Rgb = [200, 200, 200];
/** 模板嵌套的最大深度。 */
export const MAX_TEMPLATE_DEPTH = 8;
/** 单个形状（含模板展开）最多生成的三角形数，防止异常数据拖垮浏览器。 */
export const MAX_TRIANGLES = 2_000_000;

/** 一块网格和它的材质；`material === null` 表示还没确定，由上层形状的材质填上。 */
export interface MeshPart {
  readonly mesh: MeshData;
  readonly material: Material | null;
}

export interface BuildOptions {
  readonly templates?: TemplateTable;
  readonly maxTriangles?: number;
}

export interface BuildResult {
  /** 按材质合并后的网格块，坐标是形状的父坐标系（已应用形状自己的 transform）。 */
  readonly parts: { readonly mesh: MeshData; readonly material: Material }[];
  readonly warnings: string[];
}

interface Context {
  readonly templates: TemplateTable;
  readonly stack: string[];
  readonly warnings: string[];
  triangles: number;
  readonly maxTriangles: number;
}

/** 生成单个基本形体的网格（局部坐标，不含 transform）。 */
export function primitiveMesh(shape: Shape): MeshData | null {
  switch (shape.type) {
    case 'box':
      return boxMesh(shape);
    case 'cylinder':
      return cylinderMesh(shape);
    case 'cone':
      return coneMesh(shape);
    case 'extrude':
      return extrudeMesh(shape);
    case 'lathe':
      return latheMesh(shape);
    case 'sweep':
      return sweepMesh(shape);
    case 'loft':
      return loftMesh(shape);
    default:
      return null;
  }
}

function partsBounds(parts: readonly MeshPart[]): Bounds | null {
  return parts.reduce<Bounds | null>((acc, part) => unionBounds(acc, meshBounds(part.mesh)), null);
}

/**
 * 给还没有材质的块填上 `material`。贴图材质的 uv 不是 `mesh` 时，
 * 按这些块合起来的包围盒（当前形状的局部坐标）重新投影 UV。
 */
function assignMaterial(parts: MeshPart[], material: Material): MeshPart[] {
  const open = parts.filter((part) => part.material === null);
  if (open.length === 0) return parts;
  const mode = isTextureMaterial(material) ? (material.uv ?? 'box') : 'mesh';
  const bounds = mode === 'mesh' ? null : partsBounds(open);
  return parts.map((part) =>
    part.material !== null
      ? part
      : { mesh: mode === 'mesh' ? part.mesh : projectUvs(part.mesh, mode, bounds), material },
  );
}

/**
 * 实例的材质覆盖模板里的颜色（同款椅子不同颜色）：
 * 颜色材质整个替换；模板里的贴图保留，用实例颜色做色调；实例给的是贴图时整体换成实例的贴图。
 */
function overrideMaterial(parts: MeshPart[], material: Material): MeshPart[] {
  if (isTextureMaterial(material)) {
    return assignMaterial(
      parts.map((part) => ({ mesh: part.mesh, material: null })),
      material,
    );
  }
  return parts.map((part) => {
    if (part.material !== null && isTextureMaterial(part.material)) {
      return { mesh: part.mesh, material: { ...part.material, tint: material.color } };
    }
    return { mesh: part.mesh, material };
  });
}

function buildNode(shape: Shape, ctx: Context): MeshPart[] {
  if (shape === null || typeof shape !== 'object') return [];
  let parts: MeshPart[] = [];
  if (shape.type === 'group') {
    for (const child of shape.children ?? []) parts.push(...buildNode(child, ctx));
  } else if (shape.type === 'instance') {
    const id = shape.template;
    const template = ctx.templates[id];
    if (template === undefined) {
      ctx.warnings.push(`找不到模板 ${id}`);
    } else if (ctx.stack.includes(id)) {
      ctx.warnings.push(`模板循环引用：${[...ctx.stack, id].join(' → ')}`);
    } else if (ctx.stack.length >= MAX_TEMPLATE_DEPTH) {
      ctx.warnings.push(`模板嵌套超过 ${MAX_TEMPLATE_DEPTH} 层：${id}`);
    } else {
      ctx.stack.push(id);
      parts = buildNode(template, ctx);
      ctx.stack.pop();
    }
    if (shape.material !== undefined) parts = overrideMaterial(parts, shape.material);
  } else {
    if (ctx.triangles >= ctx.maxTriangles) return [];
    const mesh = primitiveMesh(shape);
    if (mesh === null) {
      ctx.warnings.push(`未知的形状类型 ${(shape as { type?: unknown }).type as string}`);
      return [];
    }
    ctx.triangles += triangleCount(mesh);
    if (ctx.triangles > ctx.maxTriangles) {
      ctx.warnings.push(`三角形超过上限 ${ctx.maxTriangles}，其余形状不再生成`);
      return [];
    }
    parts = [{ mesh, material: null }];
  }
  if (shape.type !== 'instance' && shape.material !== undefined) {
    parts = assignMaterial(parts, shape.material);
  }
  if (shape.transform !== undefined) {
    const matrix = transformMatrix(shape.transform);
    parts = parts.map((part) => ({
      mesh: applyMatrix(part.mesh, matrix),
      material: part.material,
    }));
  }
  return parts;
}

/** 材质的分组键：相同材质的块合并成一个网格。 */
export function materialKey(material: Material): string {
  if (isTextureMaterial(material)) {
    return `t:${material.texture}:${material.tint?.join(',') ?? ''}`;
  }
  return `c:${material.color.join(',')}`;
}

/** 生成形状（含组合和模板实例）的网格，按材质合并。 */
export function buildShape(shape: Shape, options: BuildOptions = {}): BuildResult {
  const ctx: Context = {
    templates: options.templates ?? {},
    stack: [],
    warnings: [],
    triangles: 0,
    maxTriangles: options.maxTriangles ?? MAX_TRIANGLES,
  };
  const parts = assignMaterial(buildNode(shape, ctx), { color: DEFAULT_COLOR });
  const groups = new Map<string, { material: Material; meshes: MeshData[] }>();
  for (const part of parts) {
    const material = part.material ?? { color: DEFAULT_COLOR };
    const key = materialKey(material);
    const group = groups.get(key) ?? { material, meshes: [] };
    group.meshes.push(part.mesh);
    groups.set(key, group);
  }
  return {
    parts: [...groups.values()].map(({ material, meshes }) => ({
      mesh: meshes.length === 1 ? meshes[0]! : mergeMeshes(meshes),
      material,
    })),
    warnings: ctx.warnings,
  };
}

/** 形状的包围盒（父坐标系）；没有几何时返回 null。 */
export function shapeBounds(shape: Shape, options: BuildOptions = {}): Bounds | null {
  return buildShape(shape, options).parts.reduce<Bounds | null>(
    (acc, part) => unionBounds(acc, meshBounds(part.mesh)),
    null,
  );
}

/** 合并成一块网格（忽略材质），用于测试和包围盒计算。 */
export function shapeMesh(shape: Shape, options: BuildOptions = {}): MeshData {
  return mergeMeshes(buildShape(shape, options).parts.map((part) => part.mesh));
}
