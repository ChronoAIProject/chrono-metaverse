/** 上传外景模型和石材贴图，完成系统核对后可生成扩展草稿。 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  ApiClient,
  MetaverseApi,
  resolveNyxToken,
  upload,
  waitForJob,
} from '../../../sdk/typescript/dist/index.js';

const root = new URL('../', import.meta.url);
const config = JSON.parse(readFileSync(new URL('metaverse.json', root), 'utf8'));
const buildings = JSON.parse(readFileSync(new URL('build/onemap-entities.json', root), 'utf8'));
const ground = JSON.parse(readFileSync(new URL('build/ground.json', root), 'utf8'));
const streetscape = JSON.parse(readFileSync(new URL('build/streetscape.json', root), 'utf8'));
const streetTrees = JSON.parse(readFileSync(new URL('build/city-street-trees.json', root), 'utf8'));
const host = JSON.parse(readFileSync(new URL('build/placement.json', root), 'utf8')).hostEntities;
const probe = process.argv.includes('--probe');
const hostOnly = process.argv.includes('--host');
const entities = hostOnly
  ? host
  : probe
    ? [ground[0], buildings[0]]
    : [...ground, ...buildings, ...host, ...streetscape, ...streetTrees];
const assets = entities.map((entity) => ({ ...entity, purpose: 'model', format: 'glb' }));
if (!probe && !hostOnly) {
  const domes = JSON.parse(readFileSync(new URL('build/garden-conservatories.json', root), 'utf8'));
  assets.push({ ...domes, purpose: 'model', format: 'glb' });
  const lakeshore = JSON.parse(readFileSync(new URL('build/dragonfly-lake-understorey.json', root), 'utf8'));
  assets.push({ ...lakeshore, purpose: 'model', format: 'glb' });
  const environment = JSON.parse(readFileSync(new URL('build/environment.json', root), 'utf8'));
  assets.push({
    entityId: environment.entityId,
    label: '晴空全景',
    assetHash: environment.props.environment.sky.texture,
    purpose: 'texture',
    format: 'jpeg',
  });
  const turf = environment.props.environment.map?.turfColorSurvey;
  if (turf) assets.push({
    entityId: environment.entityId,
    label: '实测草地色差',
    assetHash: turf.texture,
    path: new URL('references/marina-south-turf/reflectance.png', root).pathname,
    purpose: 'texture',
    format: 'png',
  });
  const vegetation = environment.props.environment.map?.vegetationExposure;
  if (vegetation) assets.push({
    entityId: environment.entityId,
    label: '公园航片植被覆盖',
    assetHash: vegetation.texture,
    path: new URL('references/marina-south-turf/park-vegetation.png', root).pathname,
    purpose: 'texture',
    format: 'png',
  });
  const radiance = environment.props.environment.sky.radiance;
  if (radiance) assets.push({
    entityId: environment.entityId,
    label: '晴空反射辐亮度',
    assetHash: radiance.texture,
    purpose: 'texture',
    format: 'png',
  });
  const { facadeReflections } = JSON.parse(
    readFileSync(new URL('references/district-window-reflections.json', root), 'utf8'),
  );
  assets.push({
    entityId: 'bay.city-surroundings',
    label: '街区窗面反射',
    assetHash: facadeReflections.texture,
    purpose: 'texture',
    format: 'png',
  });
  const { quay } = JSON.parse(readFileSync(new URL('context.json', root), 'utf8'));
  for (const [role, hash] of Object.entries(quay?.granite ?? {})) {
    assets.push({
      entityId: quay.id,
      label: `岸石 · ${role}`,
      assetHash: hash,
      purpose: 'texture',
      format: 'webp',
    });
  }
}
const unique = [...new Map(assets.map((asset) => [asset.assetHash, asset])).values()];
const api = new MetaverseApi(
  new ApiClient({ mode: 'nyxid', token: () => resolveNyxToken().token }),
  config.spaceId,
);
mkdirSync(new URL('out/', root), { recursive: true });
const ledgerFile = new URL('out/model-uploads.json', root);
const ledger = existsSync(ledgerFile) ? JSON.parse(readFileSync(ledgerFile, 'utf8')) : {};
let cursor = 0;
let completed = 0;
let failed = false;
async function next() {
  while (!failed && cursor < unique.length) {
    const entity = unique[cursor++];
    try {
      // 每次都向服务端询问是否复用；本地清单不作为资源仍在线的依据。
      const result = await upload(api, {
        purpose: entity.purpose,
        format: entity.format,
        plot: config.plot,
        source: {
          path: entity.path ?? new URL(`assets/${entity.assetHash}.${entity.format}`, root).pathname,
        },
      });
      if (result.jobId)
        await waitForJob(api, result.jobId, {
          plot: config.plot,
          timeoutMs: 180000,
        });
      if (result.assetHash !== entity.assetHash) throw new Error('服务端资源哈希与摆放记录不一致');
      ledger[entity.assetHash] = {
        entityId: entity.entityId,
        bytes: result.size,
        reused: result.reused,
        jobId: result.jobId,
        verifiedAt: new Date().toISOString(),
      };
      writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2) + '\n');
      completed++;
      console.log(
        `系统模型核对通过 ${completed}/${unique.length}：${entity.label}（${Math.round(result.size / 1024)} KiB${result.reused ? '，已复用' : ''}）`,
      );
    } catch (error) {
      failed = true;
      throw new Error(`${entity.entityId}：${error.message}`, { cause: error });
    }
  }
}
const results = await Promise.allSettled(Array.from({ length: probe ? 1 : 3 }, next));
for (const result of results) if (result.status === 'rejected') console.error(result.reason);
if (failed) process.exitCode = 1;
else console.log(`已在 ${config.spaceId} 完成 ${completed} 份资源的上传与核对`);
