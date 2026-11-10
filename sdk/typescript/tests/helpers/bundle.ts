import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { boxPositions, meshGlb, pngBytes, zipBytes } from './samples.js';

/**
 * 测试用的重建包目录（docs/SHAPES.md 第 7 节）：原始扫描 zip、网页用模型、一个物件模型、一张贴图、
 * 建模记录，以及引用它们的清单。`omit` 里的路径列进清单但不写到本地（模拟"依赖空间里已有"）。
 */

type Json = Record<string, unknown>;

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface BundleFixture {
  readonly dir: string;
  readonly manifest: Json;
  /** 清单的字节和 sha256。 */
  readonly manifestBytes: Buffer;
  readonly manifestHash: string;
  /** 路径 → 内容（含本地没写的）。 */
  readonly files: ReadonlyMap<string, Uint8Array>;
}

export interface BundleOptions {
  readonly base?: { spaceId: string; seq: number } | null;
  readonly mode?: 'replace' | 'merge';
  /** 列进清单但不写到本地的文件路径。 */
  readonly omit?: readonly string[];
  /** 物件的 bounds（默认与模型一致）。 */
  readonly modelBounds?: { min: number[]; max: number[] };
  readonly internalAnchor?: boolean;
  /** 写清单前再改它。 */
  readonly mutate?: (manifest: Json, files: Map<string, Uint8Array>) => void;
}

const DRACO_MESH = Uint8Array.from([...new TextEncoder().encode('DRACO'), 2, 2, 1, 0, 0, 0]);

export function writeBundle(dir: string, options: BundleOptions = {}): BundleFixture {
  const files = new Map<string, Uint8Array>();
  const scan = zipBytes([
    { name: 'scan/mesh.drc', data: DRACO_MESH },
    { name: 'scan/texture.jpg' },
  ]);
  files.set('scan/scan.zip', scan);
  const web = meshGlb({ positions: boxPositions([10, 3, 8]) });
  files.set('web/scan-0.glb', web);
  const model = meshGlb({ positions: boxPositions([1, 0.9, 0.8]) });
  const modelHash = sha256(model);
  files.set(`models/${modelHash.slice(0, 12)}.glb`, model);
  const texture = pngBytes(256, 256);
  const textureHash = sha256(texture);
  files.set(`textures/${textureHash.slice(0, 12)}.png`, texture);
  const notes = new TextEncoder().encode('# 建模记录\n沙发用库里的模型。\n');
  files.set('notes.md', notes);
  const mode = options.mode ?? 'replace';
  const manifest: Json = {
    format: 'chrono-metaverse-rebuild-bundle',
    version: 1,
    tool: { name: 'metaverse-recon', version: '0.2.0' },
    note: '测试包：一张沙发、一面墙',
    createdAt: '2026-11-09T08:00:00.000Z',
    ...(options.base !== null ? { base: options.base ?? { spaceId: 'demo-space', seq: 5 } } : {}),
    scan: {
      assetHash: sha256(scan),
      webModelHashes: [sha256(web)],
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      observedAt: '2026-10-20T00:00:00.000Z',
    },
    rebuilt: {
      mode,
      templates: [],
      entities: [
        {
          entityId: 'rb.wall-01',
          layer: 'rebuilt',
          kind: 'structure',
          shape: {
            type: 'box',
            size: [4, 3, 0.1],
            transform: { position: [2, 0, 0.05] },
            material: { texture: textureHash, uv: 'box' },
          },
          bounds: { min: [0, 0, 0], max: [4, 3, 0.1] },
        },
        {
          entityId: 'rb.sofa-01',
          layer: 'rebuilt',
          kind: 'object',
          assetHash: modelHash,
          bounds: options.modelBounds ?? { min: [2, 0, 3], max: [3, 0.9, 3.8] },
          anchorId: 'sofa-01',
        },
      ],
      ...(mode === 'merge' ? { remove: ['old-sofa'] } : {}),
    },
    anchors: [
      {
        anchorId: 'sofa-01',
        kind: 'seat',
        box: [40, 0, 60, 60, 18, 76],
        visibility: options.internalAnchor ? 'internal' : 'public',
      },
    ],
    notes: sha256(notes),
    report: { fit: { meanCm: 2.1 } },
    files: [] as Json[],
  };
  options.mutate?.(manifest, files);
  const purposes: Record<string, string> = {
    scan: 'scan',
    web: 'webmodel',
    models: 'model',
    textures: 'texture',
  };
  manifest.files = [...files.entries()].map(([path, bytes]) => ({
    path,
    purpose: purposes[path.split('/')[0]!] ?? 'script',
    sha256: sha256(bytes),
    size: bytes.length,
  }));
  for (const [path, bytes] of files) {
    if (options.omit?.includes(path)) continue;
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), bytes);
  }
  mkdirSync(dir, { recursive: true });
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  writeFileSync(join(dir, 'manifest.json'), manifestBytes);
  return { dir, manifest, manifestBytes, manifestHash: sha256(manifestBytes), files };
}
