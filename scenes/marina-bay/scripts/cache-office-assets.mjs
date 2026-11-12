import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { ApiClient, MetaverseApi, resolveNyxToken } from '../../../sdk/typescript/dist/index.js';
const root = new URL('../', import.meta.url);
const entities = JSON.parse(readFileSync(new URL('entities.json', root)));
const client = new ApiClient({ mode: 'nyxid', token: () => resolveNyxToken().token });
const api = new MetaverseApi(client, 'chronoai-lobby');
const hashes = new Map();
function visit(shape) {
  if (shape?.material?.texture) hashes.set(shape.material.texture, 'bin');
  for (const child of shape?.children ?? []) visit(child);
}
for (const entity of entities) {
  if (entity.assetHash) hashes.set(entity.assetHash, 'glb');
  for (const hash of entity.textures ?? []) hashes.set(hash, 'bin');
  visit(entity.shape);
}
const missing = [...hashes].filter(([hash, ext]) => !existsSync(new URL(`assets/${hash}.${ext}`, root)));
let cursor = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (cursor < missing.length) {
    const [hash, ext] = missing[cursor++];
    const data = await api.getAsset(hash);
    writeFileSync(new URL(`assets/${hash}.${ext}`, root), data);
    console.log(`已缓存办公室资源 ${cursor}/${missing.length}`);
  }
}));
