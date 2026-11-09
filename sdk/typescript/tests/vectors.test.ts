import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalizeText, CanonicalError } from '../src/core/canonical.js';
import {
  cellIndex,
  chunkHash,
  chunkKeyString,
  decompressChunk,
  emptyChunk,
  encodeChunk,
  isEmptyChunk,
  locateCell,
  nonZeroCount,
  type Layer,
} from '../src/core/chunk.js';
import { sha256Hex } from '../src/core/hash.js';
import {
  parseOp,
  parseOps,
  OpError,
  WorkingState,
  type PaletteBlock,
  type ScopeKind,
} from '../src/core/ops.js';
import {
  anchorRecordHash,
  entityRecordHash,
  recordHash,
  type AnchorBody,
  type EntityBody,
} from '../src/core/record.js';
import { AllowedArea, type PathScope, type Plot, type Region } from '../src/core/scope.js';
import { shapeBounds, validateShape, type Shape } from '../src/core/shape.js';
import type { Footprint } from '../src/core/scope.js';

/**
 * 跨语言测试向量：api/crates/metaverse-core/tests/vectors/（由 Rust 生成）。
 * 目录不存在时（例如只检出了 sdk/）跳过；也可以用 METAVERSE_VECTORS_DIR 指定。
 */
const VECTORS = resolve(
  process.env.METAVERSE_VECTORS_DIR ??
    join(import.meta.dirname, '../../../api/crates/metaverse-core/tests/vectors'),
);
const OPS = join(VECTORS, 'ops');

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function load(dir: string, prefix: string): [string, Json][] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.startsWith(`${prefix}_`) && name.endsWith('.json'))
    .sort()
    .map((name) => [name, JSON.parse(readFileSync(join(dir, name), 'utf8')) as Json]);
}

const present = existsSync(VECTORS);

describe.skipIf(!present)('区块向量', () => {
  for (const [name, vector] of load(VECTORS, 'chunk')) {
    it(name, () => {
      const cells = emptyChunk();
      for (const fill of vector.fills) {
        for (let y = fill.min[1]; y < fill.max[1]; y += 1)
          for (let z = fill.min[2]; z < fill.max[2]; z += 1)
            for (let x = fill.min[0]; x < fill.max[0]; x += 1)
              cells[cellIndex(x, y, z)!] = fill.block;
      }
      for (const cell of vector.cells) {
        expect(cellIndex(cell.x, cell.y, cell.z)).toBe(cell.index);
        cells[cell.index] = cell.block;
      }
      const bytes = encodeChunk(cells);
      expect(bytes.length).toBe(vector.byteLength);
      for (const check of vector.byteChecks) expect(bytes[check.offset]).toBe(check.value);
      expect(nonZeroCount(cells)).toBe(vector.nonZeroCount);
      expect(isEmptyChunk(cells)).toBe(vector.isEmpty);
      expect(sha256Hex(bytes)).toBe(vector.canonicalBytesSha256);
      expect(chunkHash(cells)).toBe(vector.hash);
      const restored = decompressChunk(Buffer.from(vector.compressedBase64, 'base64'), vector.hash);
      expect(chunkHash(restored)).toBe(vector.hash);
    });
  }
});

describe.skipIf(!present)('规范化向量', () => {
  for (const [name, vector] of load(VECTORS, 'canonical')) {
    it(name, () => {
      if (vector.error) {
        expect(() => canonicalizeText(vector.input)).toThrow(CanonicalError);
        return;
      }
      const canonical = canonicalizeText(vector.input);
      expect(canonical).toBe(vector.canonical);
      expect(sha256Hex(canonical)).toBe(vector.sha256);
      if (vector.record) {
        expect(
          recordHash(vector.record.kind, vector.record.spaceId, JSON.parse(vector.input)),
        ).toBe(vector.record.hash);
      }
    });
  }
});

describe.skipIf(!present)('形状向量', () => {
  for (const [name, vector] of load(VECTORS, 'shape')) {
    it(name, () => {
      const templates = new Map<string, Shape>(Object.entries(vector.templates));
      let bounds: { min: readonly number[]; max: readonly number[] } | null = null;
      try {
        validateShape(vector.shape);
        bounds = shapeBounds(vector.shape, templates);
      } catch {
        bounds = null;
      }
      if (!vector.valid) {
        expect(bounds).toBeNull();
        return;
      }
      expect(bounds).not.toBeNull();
      for (const key of ['min', 'max'] as const) {
        for (let axis = 0; axis < 3; axis += 1) {
          expect(Math.abs(bounds![key][axis]! - vector.bounds[key][axis])).toBeLessThanOrEqual(
            vector.tolerance,
          );
        }
      }
    });
  }
});

/** 按向量的 base 构造工作状态（与 tests/ops_vectors.rs 的 build_base 相同）。 */
function buildBase(base: Json): { state: WorkingState; regions: Region[]; plots: Plot[] } {
  const state = new WorkingState({
    palette: base.palette as PaletteBlock[],
    kind: (base.scopeKind ?? 'ext') as ScopeKind,
    anchorHistory: (base.anchorHistory ?? []) as string[],
  });
  for (const fill of base.fills) {
    const [x0, y0, z0, x1, y1, z1] = fill.box as number[];
    for (let y = y0!; y < y1!; y += 1)
      for (let z = z0!; z < z1!; z += 1)
        for (let x = x0!; x < x1!; x += 1) {
          const [chunk, [lx, ly, lz]] = locateCell([x, y, z]);
          const key = chunkKeyString({
            layer: fill.layer as Layer,
            cx: chunk[0],
            cy: chunk[1],
            cz: chunk[2],
          });
          state.mutableChunk(key)[cellIndex(lx, ly, lz)!] = fill.block;
        }
  }
  for (const entity of base.entities) state.entities.set(entity.entityId, entity as EntityBody);
  for (const anchor of base.anchors) state.anchors.set(anchor.anchorId, anchor as AnchorBody);
  return { state, regions: base.regions, plots: base.plots };
}

function chunkList(state: WorkingState, withCount: boolean): Json[] {
  return [...state.chunkHashes()]
    .map(([key, hash]) => {
      const [layer, cx, cy, cz] = key.split(':');
      const out: Json = { layer, cx: Number(cx), cy: Number(cy), cz: Number(cz), hash };
      if (withCount) out.nonZeroCount = nonZeroCount(state.chunks.get(key)!);
      return out;
    })
    .sort(
      (a, b) =>
        (a.layer === b.layer ? 0 : a.layer === 'rebuilt' ? -1 : 1) ||
        a.cx - b.cx ||
        a.cy - b.cy ||
        a.cz - b.cz,
    );
}

describe.skipIf(!existsSync(OPS))('操作向量', () => {
  for (const [name, vector] of load(OPS, 'ops')) {
    if (vector.kind === 'ops-parse') {
      it(name, () => {
        for (const testCase of vector.cases) {
          let valid = true;
          try {
            parseOp(testCase.input);
          } catch (error) {
            expect(error).toBeInstanceOf(OpError);
            valid = false;
          }
          expect(valid, JSON.stringify(testCase.input)).toBe(testCase.valid);
        }
      });
      continue;
    }
    it(name, () => {
      const base = buildBase(vector.base);
      const expected = vector.expect;
      expect(chunkList(base.state, false)).toEqual(expected.baseChunks);
      const baseHashes = base.state.chunkHashes();
      const ops = parseOps(vector.ops);
      const area =
        vector.scope === null
          ? null
          : AllowedArea.forScope(vector.scope as PathScope, base.regions, base.plots);
      const footprints: Footprint[] = [];
      const state = base.state.clone();
      const before = chunkList(state, true);
      let touched;
      try {
        touched = state.applySequence(ops, area, (_index, footprint) => footprints.push(footprint));
      } catch (error) {
        expect(error).toBeInstanceOf(OpError);
        const opError = error as OpError;
        expect(expected.ok).toBe(false);
        expect({ kind: opError.kind, index: opError.index }).toEqual({
          kind: expected.error.kind,
          index: expected.error.index,
        });
        expect(opError.message).toBe(expected.error.message);
        expect(footprints).toEqual(expected.footprints);
        // 失败时状态不变。
        expect(chunkList(state, true)).toEqual(before);
        return;
      }
      expect(expected.ok).toBe(true);
      expect(footprints).toEqual(expected.footprints);
      const chunks = [...touched.chunks].map((key) => {
        const [layer, cx, cy, cz] = key.split(':');
        return { layer, cx: Number(cx), cy: Number(cy), cz: Number(cz) };
      });
      expect(
        chunks.sort(
          (a, b) =>
            (a.layer === b.layer ? 0 : a.layer === 'rebuilt' ? -1 : 1) ||
            a.cx - b.cx ||
            a.cy - b.cy ||
            a.cz - b.cz,
        ),
      ).toEqual(expected.touched.chunks);
      expect([...touched.entities].sort()).toEqual(expected.touched.entities);
      expect([...touched.anchors].sort()).toEqual(expected.touched.anchors);
      expect(touched.palette).toBe(expected.touched.palette);
      expect(touched.scan).toBe(expected.touched.scan);
      expect(touched.rebuiltLayer).toBe(expected.touched.rebuiltLayer);
      expect(
        [...touched.skippedAnchors.entries()]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([id, reason]) => ({ id, reason })),
      ).toEqual(expected.touched.skippedAnchors);
      expect(
        state.scan === null
          ? null
          : { scan: state.scan.scan, observedAt: state.scan.observedAt ?? null },
      ).toEqual(expected.scan);
      expect(state.brokenTemplateRefs()).toEqual(expected.brokenTemplateRefs);
      expect(state.chunkChanges(baseHashes, touched.chunks)).toEqual(expected.chunkChanges);
      expect(chunkList(state, true)).toEqual(expected.chunks);
      const spaceId = vector.spaceId as string;
      expect(
        [...state.entities.entries()]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([id, body]) => ({ id, hash: entityRecordHash(spaceId, body) })),
      ).toEqual(expected.entities);
      expect(
        [...state.anchors.entries()]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([id, body]) => ({ id, hash: anchorRecordHash(spaceId, body) })),
      ).toEqual(expected.anchors);
      expect(
        [...state.provisionalBlocks.entries()]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([blockName, block]) => ({ name: blockName, id: block.id })),
      ).toEqual(expected.provisionalBlocks);
      expect(
        (vector.probeCells as [number, number, number][]).map((cell) => ({
          cell,
          ext: state.blockAt('ext', cell),
          rebuilt: state.blockAt('rebuilt', cell),
          effective: state.effectiveBlock(cell),
        })),
      ).toEqual(expected.probes);
    });
  }
});
