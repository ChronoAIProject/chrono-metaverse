import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bytesSource,
  checkAsset,
  CheckError,
  describeCheck,
  fileSource,
  fits,
  imageSize,
  modelFitsBounds,
  uploadFormatFromPath,
  type AssetCheck,
  type GlbCheck,
} from '../src/core/check/index.js';
import { DEFAULT_UPLOAD_LIMITS, parseUploadLimits, type UploadLimits } from '../src/core/limits.js';
import type { BundleFilePurpose } from '../src/core/limits.js';
import {
  boxPositions,
  glbBytes,
  jpegBytes,
  meshGlb,
  pngBytes,
  webpBytes,
  zipBytes,
} from './helpers/samples.js';

/**
 * 资源核对（docs/design/server-slim.md 4.4–4.6）的命令行实现：按 6.5 列出的样本逐个核对通过或被拒、
 * 拒绝码和通过时的 `check`。样本由 helpers/samples.ts 在内存里生成。
 */

const limits = DEFAULT_UPLOAD_LIMITS;

function check(purpose: BundleFilePurpose, bytes: Uint8Array, l: UploadLimits = limits) {
  return checkAsset(purpose, bytesSource(bytes), l);
}

async function code(purpose: BundleFilePurpose, bytes: Uint8Array, l: UploadLimits = limits) {
  try {
    await check(purpose, bytes, l);
  } catch (error) {
    if (error instanceof CheckError) return error.code;
    throw error;
  }
  return 'ok';
}

describe('glb 完整检查', () => {
  it('合格的盒子：三角形、实测包围盒、记录的字段', async () => {
    const result = (await check('model', meshGlb())) as GlbCheck;
    expect(result).toEqual({
      v: 1,
      format: 'glb',
      triangles: 12,
      nodes: 1,
      meshes: 1,
      materials: 1,
      images: [],
      maxTextureSide: 0,
      texturePixels: 0,
      extensions: [],
      bounds: { min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] },
    });
    expect(describeCheck(result)).toContain('12 个三角形');
    expect(fits('model', result, limits)).toBeNull();
    expect(fits('webModel', result, limits)).toBeNull();
    expect(fits('texture', result, limits)).toContain('不能当贴图');
  });

  it('同一个网格被两个节点引用算两次；节点的平移、缩放进世界包围盒', async () => {
    const result = (await check(
      'model',
      meshGlb({
        nodes: [
          { children: [1, 2], scale: [2, 2, 2] },
          { mesh: 0, translation: [1, 0, 0] },
          { mesh: 0, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -1, 0, 0, 1] },
        ],
      }),
    )) as GlbCheck;
    expect(result.triangles).toBe(24);
    expect(result.bounds).toEqual({ min: [-3, 0, -1], max: [3, 2, 1] });
  });

  it('旋转节点的包围盒按 8 个角点经世界变换取外包（偏大）', async () => {
    const s = Math.SQRT1_2;
    const result = (await check(
      'model',
      meshGlb({ nodes: [{ mesh: 0, rotation: [0, s, 0, s] }] }),
    )) as GlbCheck;
    // 绕 y 转 90 度：x、z 互换，正方形的盒子范围不变。
    expect(result.bounds!.min.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([-0.5, 0, -0.5]);
    const tilted = (await check(
      'model',
      meshGlb({
        nodes: [{ mesh: 0, rotation: [0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)] }],
      }),
    )) as GlbCheck;
    expect(tilted.bounds!.max[0]).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('量化坐标：声明了 KHR_mesh_quantization 才收；归一化的按规范还原', async () => {
    const positions = [0, 0, 0, 100, 0, 0, 0, 100, 0];
    expect(await code('model', meshGlb({ positions, indices: null, componentType: 5122 }))).toBe(
      'glb_position',
    );
    const raw = (await check(
      'model',
      meshGlb({
        positions,
        indices: null,
        componentType: 5122,
        extensionsUsed: ['KHR_mesh_quantization'],
        nodes: [{ mesh: 0, scale: [0.01, 0.01, 0.01] }],
      }),
    )) as GlbCheck;
    expect(raw.bounds!.max).toEqual([1, 1, 0]);
    const normalized = (await check(
      'model',
      meshGlb({
        positions: [0, 0, 0, 255, 0, 0, 0, 255, 0],
        indices: null,
        componentType: 5121,
        normalized: true,
        extensionsUsed: ['KHR_mesh_quantization'],
      }),
    )) as GlbCheck;
    expect(normalized.bounds!.max).toEqual([1, 1, 0]);
    expect(normalized.triangles).toBe(1);
  });

  it('贴图：读 PNG、JPEG 头；长 EXIF 段也能走过去', async () => {
    const result = (await check(
      'model',
      meshGlb({
        images: [
          { bytes: pngBytes(512, 256), mime: 'image/png' },
          { bytes: jpegBytes(1024, 768, { appSegments: 2 }), mime: 'image/jpeg' },
        ],
      }),
    )) as GlbCheck;
    expect(result.images).toEqual([
      { w: 512, h: 256, mime: 'image/png' },
      { w: 1024, h: 768, mime: 'image/jpeg' },
    ]);
    expect(result.maxTextureSide).toBe(1024);
    expect(result.texturePixels).toBe(512 * 256 + 1024 * 768);
    expect(describeCheck(result)).toContain('最大边长 1024');
  });

  it.each([
    [
      '外部 uri 的缓冲区',
      () =>
        meshGlb({ mutate: (j) => ((j.buffers as object[])[0] = { byteLength: 1, uri: 'x.bin' }) }),
      'glb_external_uri',
    ],
    [
      'data: 图片',
      () => meshGlb({ mutate: (j) => (j.images = [{ uri: 'data:image/png;base64,AAAA' }]) }),
      'glb_external_uri',
    ],
    [
      'Draco 扩展',
      () => meshGlb({ extensionsUsed: ['KHR_draco_mesh_compression'] }),
      'glb_extension',
    ],
    [
      '灯光扩展',
      () =>
        meshGlb({
          mutate: (j) => (j.extensions = { KHR_lights_punctual: { lights: [] } }),
        }),
      'glb_extension',
    ],
    [
      '不在白名单的对象级扩展',
      () =>
        meshGlb({
          mutate: (j) =>
            ((j.materials as Record<string, unknown>[])[0]!.extensions = {
              KHR_materials_transmission: {},
            }),
        }),
      'glb_extension',
    ],
    [
      'extensionsRequired 只能是前两个',
      () =>
        meshGlb({
          extensionsUsed: ['KHR_materials_unlit'],
          mutate: (j) => (j.extensionsRequired = ['KHR_materials_unlit']),
        }),
      'glb_extension',
    ],
    [
      '相机',
      () => meshGlb({ mutate: (j) => (j.cameras = [{ type: 'perspective' }]) }),
      'glb_unsupported',
    ],
    [
      '节点成环',
      () =>
        meshGlb({
          nodes: [{ mesh: 0 }, { children: [2] }, { children: [1] }],
        }),
      'glb_node_graph',
    ],
    [
      '两个父节点',
      () => meshGlb({ nodes: [{ children: [2] }, { children: [2] }, { mesh: 0 }], roots: [0, 1] }),
      'glb_node_graph',
    ],
    ['场景里出现两次', () => meshGlb({ roots: [0, 0] }), 'glb_node_graph'],
    ['骨骼', () => meshGlb({ mutate: (j) => (j.skins = [{ joints: [0] }]) }), 'glb_unsupported'],
    ['动画', () => meshGlb({ mutate: (j) => (j.animations = [{}]) }), 'glb_unsupported'],
    [
      '变形目标',
      () =>
        meshGlb({
          mutate: (j) =>
            ((j.meshes as { primitives: Record<string, unknown>[] }[])[0]!.primitives[0]!.targets =
              [{ POSITION: 0 }]),
        }),
      'glb_unsupported',
    ],
    [
      '非三角形图元',
      () =>
        meshGlb({
          mutate: (j) =>
            ((j.meshes as { primitives: Record<string, unknown>[] }[])[0]!.primitives[0]!.mode = 1),
        }),
      'glb_unsupported',
    ],
    ['三角形数不是整数', () => meshGlb({ indices: [0, 1, 2, 3] }), 'glb_triangles'],
    ['声明的 min/max 与数据不符', () => meshGlb({ max: [0.5, 0.8, 0.5] }), 'glb_bounds_mismatch'],
    [
      '没有 min/max',
      () =>
        meshGlb({
          mutate: (j) => delete (j.accessors as object[] as Record<string, unknown>[])[0]!.min,
        }),
      'glb_position',
    ],
    ['坐标越界', () => meshGlb({ positions: boxPositions([3000, 1, 1]) }), 'glb_coord_range'],
    ['没有场景', () => meshGlb({ mutate: (j) => delete j.scenes }), 'glb_scene'],
    [
      '稀疏访问器',
      () =>
        meshGlb({ mutate: (j) => ((j.accessors as Record<string, unknown>[])[0]!.sparse = {}) }),
      'glb_buffer',
    ],
    [
      '访问器超出缓冲区视图',
      () => meshGlb({ mutate: (j) => ((j.accessors as Record<string, unknown>[])[0]!.count = 9) }),
      'glb_buffer',
    ],
    [
      'PNG 魔数与 mimeType 不符',
      () => meshGlb({ images: [{ bytes: pngBytes(4, 4), mime: 'image/jpeg' }] }),
      'glb_image',
    ],
    [
      'JPEG 魔数与 mimeType 不符',
      () => meshGlb({ images: [{ bytes: jpegBytes(4, 4), mime: 'image/png' }] }),
      'glb_image',
    ],
    [
      'JPEG 没有 SOF',
      () => meshGlb({ images: [{ bytes: jpegBytes(4, 4, { sof: false }), mime: 'image/jpeg' }] }),
      'glb_image',
    ],
    [
      'webp 不能内嵌',
      () => meshGlb({ images: [{ bytes: webpBytes(4, 4), mime: 'image/webp' }] }),
      'glb_image',
    ],
    [
      '贴图边长超过物件模型的上限',
      () => meshGlb({ images: [{ bytes: pngBytes(4096, 4), mime: 'image/png' }] }),
      'glb_texture_too_large',
    ],
    [
      'asset.version 不对',
      () => meshGlb({ mutate: (j) => (j.asset = { version: '1.0' }) }),
      'glb_json',
    ],
    [
      '数组太长',
      () => meshGlb({ mutate: (j) => (j.scenes = new Array(17).fill({ nodes: [] })) }),
      'glb_json',
    ],
  ])('%s → %s', async (_name, make, expected) => {
    expect(await code('model', make())).toBe(expected);
  });

  it('头和块的排列', async () => {
    const good = meshGlb();
    const badMagic = good.slice();
    badMagic[0] = 0x00;
    expect(await code('model', badMagic)).toBe('glb_header');
    const badLength = good.slice();
    new DataView(badLength.buffer).setUint32(8, good.length + 4, true);
    expect(await code('model', badLength)).toBe('glb_header');
    const extra = new Uint8Array(good.length + 12);
    extra.set(good);
    new DataView(extra.buffer).setUint32(8, extra.length, true);
    expect(await code('model', extra)).toBe('glb_header');
    expect(await code('model', glbBytes({ asset: { version: '2.0' } }, null))).toBe('glb_scene');
    const notJson = glbBytes({ asset: { version: '2.0' } });
    notJson[20] = 0x5b; // "[" 开头：JSON 不是对象
    expect(await code('model', notJson)).toBe('glb_json');
  });

  it('三角形数、JSON 块按用途的上限', async () => {
    const tight: UploadLimits = { ...limits, model: { ...limits.model, maxTriangles: 11 } };
    expect(await code('model', meshGlb(), tight)).toBe('glb_too_many_triangles');
    const big = meshGlb({ mutate: (j) => (j.extras = { pad: 'x'.repeat(2 * 1024 * 1024) }) });
    expect(await code('model', big)).toBe('glb_json_too_large');
    expect(await code('webmodel', big)).toBe('ok');
  });
});

describe('扫描、贴图、建模记录', () => {
  it('扫描用途的 glb 只做轻量检查，不能当模型', async () => {
    const result = (await check(
      'scan',
      meshGlb({ extensionsUsed: ['KHR_draco_mesh_compression'] }),
    )) as GlbCheck;
    expect(result.triangles).toBeNull();
    expect(result.bounds).toBeNull();
    expect(result.extensions).toEqual(['KHR_draco_mesh_compression']);
    expect(describeCheck(result)).toContain('轻量');
    expect(fits('scan', result, limits)).toBeNull();
    expect(fits('model', result, limits)).toContain('轻量检查');
    expect(
      await code(
        'scan',
        meshGlb({ mutate: (j) => ((j.buffers as object[])[0] = { byteLength: 1, uri: 'a' }) }),
      ),
    ).toBe('glb_external_uri');
  });

  it('drc、obj', async () => {
    const drc = Uint8Array.from([...new TextEncoder().encode('DRACO'), 2, 2, 1, 0, 0, 0, 0]);
    expect(await check('scan', drc)).toEqual({ v: 1, format: 'drc' });
    const cloud = drc.slice();
    cloud[7] = 0;
    expect(await code('scan', cloud)).toBe('drc_header');
    const obj = new TextEncoder().encode('# 扫描\nmtllib a.mtl\nv 0 0 0\n');
    expect(await check('scan', obj)).toEqual({ v: 1, format: 'obj' });
    expect(await code('scan', new TextEncoder().encode('hello world\n'))).toBe('obj_header');
    expect(await code('scan', new TextEncoder().encode('# 只有注释\n'))).toBe('obj_header');
    expect(await code('scan', Uint8Array.from([0x50, 0x4b, 0x05, 0x06]))).toBe('format');
  });

  it('贴图：png、jpeg、webp 的宽高和上限', async () => {
    expect(await check('texture', pngBytes(64, 32))).toEqual({
      v: 1,
      format: 'png',
      width: 64,
      height: 32,
    });
    const jpeg = await check('texture', jpegBytes(300, 200, { appSegments: 3 }));
    expect(jpeg).toEqual({ v: 1, format: 'jpeg', width: 300, height: 200 });
    expect(describeCheck(jpeg)).toBe('jpeg 300×200');
    expect(await check('texture', webpBytes(4000, 3))).toEqual({
      v: 1,
      format: 'webp',
      width: 4000,
      height: 3,
    });
    expect(await code('texture', webpBytes(5000, 3))).toBe('image_too_large');
    expect(await code('texture', pngBytes(4097, 4))).toBe('image_too_large');
    expect(await code('texture', jpegBytes(4, 4, { sof: false }))).toBe('image_header');
    expect(await code('texture', new TextEncoder().encode('GIF89a......'))).toBe('image_format');
    expect(await code('texture', pngBytes(0, 4))).toBe('image_header');
  });

  it('WebP 的 VP8、VP8L 头；PNG 没有 IHDR；JPEG 段标记错位', () => {
    const vp8 = new Uint8Array(30);
    vp8.set(new TextEncoder().encode('RIFF'), 0);
    vp8.set(new TextEncoder().encode('WEBPVP8 '), 8);
    vp8.set([0x9d, 0x01, 0x2a], 23);
    new DataView(vp8.buffer).setUint16(26, 640, true);
    new DataView(vp8.buffer).setUint16(28, 480, true);
    expect(imageSize(vp8)).toEqual({ format: 'webp', width: 640, height: 480 });
    vp8[23] = 0;
    expect(() => imageSize(vp8)).toThrow('起始码');
    const vp8l = new Uint8Array(30);
    vp8l.set(new TextEncoder().encode('RIFF'), 0);
    vp8l.set(new TextEncoder().encode('WEBPVP8L'), 8);
    vp8l[20] = 0x2f;
    new DataView(vp8l.buffer).setUint32(21, 99 | (49 << 14), true);
    expect(imageSize(vp8l)).toEqual({ format: 'webp', width: 100, height: 50 });
    vp8l[20] = 0;
    expect(() => imageSize(vp8l)).toThrow('签名');
    const other = vp8l.slice();
    other.set(new TextEncoder().encode('ALPH'), 12);
    expect(() => imageSize(other)).toThrow('不认识');
    expect(() => imageSize(vp8l.subarray(0, 20))).toThrow('太短');
    expect(() => imageSize(pngBytes(4, 4).subarray(0, 16))).toThrow('IHDR');
    const broken = jpegBytes(4, 4);
    broken[20] = 0x00;
    expect(() => imageSize(broken)).toThrow('段标记');
    const zeroLength = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
    expect(() => imageSize(zeroLength)).toThrow('段长度');
    const padded = Uint8Array.from([0xff, 0xd8, 0xff, 0xff, 0xd0, ...jpegBytes(7, 9).subarray(2)]);
    expect(imageSize(padded)).toEqual({ format: 'jpeg', width: 7, height: 9 });
    expect(() => imageSize(pngBytes(4, 4), ['jpeg'])).toThrow('jpeg');
  });

  it('webp 的上限照 fits 再查一遍', async () => {
    const wide = (await check('texture', webpBytes(4096, 4096))) as AssetCheck;
    expect(fits('texture', wide, limits)).toBeNull();
    const smaller: UploadLimits = { ...limits, texture: { ...limits.texture, maxSide: 2048 } };
    expect(fits('texture', wide, smaller)).toContain('边长上限');
    const fewer: UploadLimits = { ...limits, texture: { ...limits.texture, maxPixels: 100 } };
    expect(fits('texture', wide, fewer)).toContain('像素上限');
  });

  it('建模记录是 UTF-8 文本、不含 NUL；大小上限', async () => {
    expect(await check('script', new TextEncoder().encode('# 记录\n'))).toEqual({
      v: 1,
      format: 'text',
    });
    expect(await code('script', Uint8Array.from([0x61, 0, 0x62]))).toBe('text_encoding');
    expect(await code('script', Uint8Array.from([0xff, 0xfe]))).toBe('text_encoding');
    expect(await code('script', new Uint8Array())).toBe('too_large');
    const small: UploadLimits = { ...limits, script: { maxBytes: 3 } };
    expect(await code('script', new TextEncoder().encode('abcd'), small)).toBe('too_large');
  });
});

describe('扫描 zip', () => {
  const mesh = { name: 'scan/mesh.drc' };
  it('合格的 Scaniverse 风格 zip，忽略 __MACOSX/、.DS_Store 和目录项', async () => {
    const result = await check(
      'scan',
      zipBytes([
        { name: 'scan/', data: new Uint8Array() },
        mesh,
        { name: 'scan/texture.jpg' },
        { name: 'scan/mesh.mtl' },
        { name: '__MACOSX/scan/._mesh.drc' },
        { name: 'scan/.DS_Store' },
      ]),
    );
    expect(result).toEqual({ v: 1, format: 'zip', mesh: 'scan/mesh.drc', members: 6 });
    expect(describeCheck(result)).toContain('网格成员 scan/mesh.drc');
    expect(fits('scan', result, limits)).toBeNull();
  });

  it.each([
    ['.. 段', [mesh, { name: 'scan/../evil.png' }], {}, 'zip_path'],
    ['绝对路径', [mesh, { name: '/etc/passwd.png' }], {}, 'zip_path'],
    ['盘符路径', [mesh, { name: 'C:/x.png' }], {}, 'zip_path'],
    ['__MACOSX 里的 .. 照样拒绝', [mesh, { name: '__MACOSX/../x' }], {}, 'zip_path'],
    ['加密', [{ ...mesh, flags: 1 }], {}, 'zip_encrypted'],
    ['zip64 定位记录', [mesh], { zip64Locator: true }, 'zip64'],
    ['zip64 扩展信息', [{ ...mesh, centralExtra: Uint8Array.from([1, 0, 0, 0]) }], {}, 'zip64'],
    ['两个网格成员', [mesh, { name: 'other.obj' }], {}, 'zip_members'],
    ['没有网格成员', [{ name: 'a.png' }], {}, 'zip_members'],
    ['不认识的成员', [mesh, { name: 'run.sh' }], {}, 'zip_members'],
    ['本地头与中央目录不符', [{ ...mesh, localName: 'scan/mesh.drX' }], {}, 'zip_local_header'],
    ['压缩方式', [{ ...mesh, method: 12 }], {}, 'zip_method'],
  ] as const)('%s → %s', async (_name, members, options, expected) => {
    expect(await code('scan', zipBytes(members, options))).toBe(expected);
  });

  it('结构：找不到中央目录结尾、分卷、成员太多、数据区间重叠', async () => {
    const good = zipBytes([mesh]);
    expect(await code('scan', good.slice(0, good.length - 4))).toBe('zip_format');
    const multi = good.slice();
    new DataView(multi.buffer).setUint16(multi.length - 18, 1, true);
    expect(await code('scan', multi)).toBe('zip_format');
    const many = zipBytes([mesh, ...Array.from({ length: 64 }, (_, i) => ({ name: `t${i}.png` }))]);
    expect(await code('scan', many)).toBe('zip_too_large');
    // 第二个成员的本地头偏移指向第一个成员：中央目录里的偏移改成 0。
    const two = zipBytes([mesh, { name: 'a.png' }]);
    const view = new DataView(two.buffer);
    const cdOffset = view.getUint32(two.length - 6, true);
    const secondCentral = cdOffset + 46 + 'scan/mesh.drc'.length;
    view.setUint32(secondCentral + 42, 0, true);
    expect(await code('scan', two)).toBe('zip_local_header');
  });
});

describe('按角色判断、模型与记录一致、上限文件', () => {
  it('fits 的每一行', () => {
    const zip: AssetCheck = { v: 1, format: 'zip', mesh: '', members: 1 };
    expect(fits('scan', zip, limits)).toContain('原始扫描');
    expect(fits('scan', { v: 1, format: 'png', width: 1, height: 1 }, limits)).toContain(
      '原始扫描',
    );
    expect(fits('webModel', { v: 1, format: 'drc' }, limits)).toContain('要 glb');
    expect(fits('script', { v: 1, format: 'text' }, limits)).toBeNull();
    expect(fits('script', { v: 1, format: 'json' }, limits)).toContain('文本');
    expect(fits('bundle', { v: 1, format: 'json' }, limits)).toBeNull();
    expect(fits('bundle', { v: 1, format: 'text' }, limits)).toContain('清单');
    expect(fits('ops', { v: 1, format: 'gzip' }, limits)).toBeNull();
    expect(fits('ops', { v: 1, format: 'text' }, limits)).toContain('操作文件');
    const glb: GlbCheck = {
      v: 1,
      format: 'glb',
      triangles: 200_000,
      nodes: 1,
      meshes: 1,
      materials: 1,
      images: [],
      maxTextureSide: 4096,
      texturePixels: 3 * 4096 * 4096,
      extensions: ['KHR_lights_punctual'],
      bounds: { min: [-2000, 0, 0], max: [1, 1, 1] },
    };
    expect(fits('webModel', glb, limits)).toContain('像素合计');
    expect(fits('model', glb, limits)).toContain('三角形');
    expect(fits('model', { ...glb, triangles: 10 }, limits)).toContain('贴图边长');
    const small = { ...glb, triangles: 10, maxTextureSide: 10, texturePixels: 100 };
    expect(fits('model', small, limits)).toContain('坐标');
    expect(
      fits('model', { ...small, bounds: { min: [0, 0, 0], max: [1, 1, 1] } }, limits),
    ).toContain('KHR_lights_punctual');
  });

  it('modelFitsBounds：尺寸差、原点在底面中心', () => {
    const model = { min: [-0.5, 0, -0.4], max: [0.5, 0.9, 0.4] } as const;
    expect(modelFitsBounds(model, { min: [2, 0, 3], max: [3.01, 0.9, 3.8] })).toBeNull();
    expect(modelFitsBounds(model, { min: [2, 0, 3], max: [3.1, 0.9, 3.8] })).toContain('x 轴');
    // 大物件按 1% 放宽：10 米的边差 5 厘米可以。
    expect(
      modelFitsBounds(
        { min: [-5, 0, -0.4], max: [5, 0.9, 0.4] },
        { min: [0, 0, 0], max: [10.05, 0.9, 0.8] },
      ),
    ).toBeNull();
    expect(
      modelFitsBounds(
        { min: [-0.5, 0.1, -0.4], max: [0.5, 1, 0.4] },
        { min: [0, 0, 0], max: [1, 0.9, 0.8] },
      ),
    ).toContain('底面中心');
  });

  it('本地文件按需读取；按扩展名猜上传格式', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'check-'));
    try {
      const file = join(dir, 'scan.zip');
      writeFileSync(file, zipBytes([{ name: 'mesh.glb' }]));
      const source = await fileSource(file);
      try {
        expect(await checkAsset('scan', source, limits)).toMatchObject({ mesh: 'mesh.glb' });
        expect((await source.read(source.size - 2, 10)).length).toBe(2);
      } finally {
        await source.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(uploadFormatFromPath('scan', 'scan/scan.zip')).toBe('zip');
    expect(uploadFormatFromPath('scan', 'scan/a.ply')).toBeNull();
    expect(uploadFormatFromPath('webmodel', 'web/scan-0.glb')).toBe('glb');
    expect(uploadFormatFromPath('model', 'models/a.gltf')).toBeNull();
    expect(uploadFormatFromPath('texture', 'textures/a.JPG')).toBe('jpeg');
    expect(uploadFormatFromPath('texture', 'textures/a.webp')).toBe('webp');
    expect(uploadFormatFromPath('texture', 'textures/a.gif')).toBeNull();
    expect(uploadFormatFromPath('script', 'notes.md')).toBe('text');
  });

  it('limits.json 的形状与 Rust 相同', () => {
    expect(parseUploadLimits(JSON.parse(JSON.stringify(limits)))).toEqual(limits);
    expect(() => parseUploadLimits([])).toThrow('JSON 对象');
    expect(() => parseUploadLimits({ ...limits, extra: 1 })).toThrow('不认识的字段 extra');
    expect(() => parseUploadLimits({ ...limits, v: 2 })).toThrow('版本');
    const { scan: _scan, ...missing } = limits;
    void _scan;
    expect(() => parseUploadLimits(missing)).toThrow('缺少 scan');
    expect(() => parseUploadLimits({ ...limits, scan: { maxBytes: 1, maxTriangles: 2 } })).toThrow(
      'scan 里不认识的字段 maxTriangles',
    );
    expect(() => parseUploadLimits({ ...limits, ops: { maxBytes: 1.5 } })).toThrow('非负数');
    expect(
      parseUploadLimits({ ...limits, model: { ...limits.model, maxCoord: 12.5 } }).model.maxCoord,
    ).toBe(12.5);
  });
});
