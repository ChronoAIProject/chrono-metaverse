/** 把转换后的 GLB 上传至现有空间，等待系统核对通过后再生成扩展草稿。 */
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
const host = JSON.parse(readFileSync(new URL('build/placement.json', root), 'utf8')).hostEntities;
const probe = process.argv.includes('--probe');
const entities = process.argv.includes('--host')
  ? host
  : probe
    ? [ground[0], buildings[0]]
    : [...ground, ...buildings, ...host];
const unique = [...new Map(entities.map((entity) => [entity.assetHash, entity])).values()];
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
        purpose: 'model',
        format: 'glb',
        plot: config.plot,
        source: {
          path: new URL(`assets/${entity.assetHash}.glb`, root).pathname,
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
else console.log(`已在 ${config.spaceId} 完成 ${completed} 个模型的上传与核对`);
