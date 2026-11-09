import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bytesSource, checkAsset, CheckError } from '../src/core/check/index.js';
import { DEFAULT_UPLOAD_LIMITS, type BundleFilePurpose } from '../src/core/limits.js';

/**
 * 资源核对的二进制样本 `api/crates/metaverse-core/tests/vectors/check/`（docs/design/server-slim.md 6.5；
 * 由接口服务的测试生成器写出，Rust 和命令行都跑）。`expected.json` 的每一项：
 *
 * ```json
 * { "file": "glb_bounds_mismatch.glb", "purpose": "model", "ok": false, "code": "glb_bounds_mismatch" }
 * { "file": "box.glb", "purpose": "model", "ok": true, "check": { "v": 1, "format": "glb", … } }
 * ```
 *
 * 顶层是这样的数组，或者 `{ "samples": [...] }`。上限一律用默认值。目录还不存在时（接口服务那一步还没
 * 合并，或只检出了 sdk/）跳过；同样的样本在 check.test.ts 里由生成器在内存里造出来跑。
 */
const CHECK = resolve(
  process.env.METAVERSE_VECTORS_DIR !== undefined
    ? join(process.env.METAVERSE_VECTORS_DIR, 'check')
    : join(import.meta.dirname, '../../../api/crates/metaverse-core/tests/vectors/check'),
);
const EXPECTED = join(CHECK, 'expected.json');

interface Sample {
  readonly file: string;
  readonly purpose: BundleFilePurpose;
  readonly ok: boolean;
  readonly code?: string;
  readonly check?: unknown;
}

function samples(): Sample[] {
  if (!existsSync(EXPECTED)) return [];
  const value = JSON.parse(readFileSync(EXPECTED, 'utf8')) as Sample[] | { samples: Sample[] };
  return Array.isArray(value) ? value : value.samples;
}

describe.skipIf(!existsSync(EXPECTED))('资源核对的二进制样本（与 Rust 相同）', () => {
  for (const sample of samples()) {
    it(`${sample.file}（${sample.purpose}）`, async () => {
      const bytes = new Uint8Array(readFileSync(join(CHECK, sample.file)));
      try {
        const check = await checkAsset(sample.purpose, bytesSource(bytes), DEFAULT_UPLOAD_LIMITS);
        expect({ ok: true, check }).toEqual({ ok: sample.ok, check: sample.check });
      } catch (error) {
        if (!(error instanceof CheckError)) throw error;
        expect({ ok: false, code: error.code }, error.message).toEqual({
          ok: sample.ok,
          code: sample.code,
        });
      }
    });
  }
});
