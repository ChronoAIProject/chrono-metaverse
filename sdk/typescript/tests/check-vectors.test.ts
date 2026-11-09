import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bytesSource,
  checkAsset,
  CheckError,
  type AssetFormat,
  type CheckPurpose,
} from '../src/core/check/index.js';
import { DEFAULT_UPLOAD_LIMITS } from '../src/core/limits.js';

/**
 * 资源核对的二进制样本 `api/crates/metaverse-core/tests/vectors/check/`（docs/design/server-slim.md 6.5，
 * 向量 README 第 9 节；由接口服务的测试 `metaverse-api/tests/check_vectors.rs` 生成，Rust 和命令行都跑）：
 *
 * ```json
 * { "version": 1, "limits": "default",
 *   "cases": [ { "file": "glb_model_triangle.glb", "purpose": "model", "format": "glb", "ok": true, "check": { … } },
 *              { "file": "glb_bounds_mismatch.glb", "purpose": "model", "format": "glb", "ok": false, "code": "glb_bounds_mismatch" } ] }
 * ```
 *
 * `format` 是上传时声明的格式，上限一律用默认值。每个用例都要与 Rust 相同：通过时核对记录逐字段相同，
 * 被拒时拒绝码相同。目录不存在时（只检出了 sdk/）跳过；样本里的情形在 check.test.ts 里另有内存生成的用例。
 */
const CHECK = resolve(
  process.env.METAVERSE_VECTORS_DIR !== undefined
    ? join(process.env.METAVERSE_VECTORS_DIR, 'check')
    : join(import.meta.dirname, '../../../api/crates/metaverse-core/tests/vectors/check'),
);
const EXPECTED = join(CHECK, 'expected.json');

interface Case {
  readonly file: string;
  readonly purpose: CheckPurpose;
  readonly format: AssetFormat;
  readonly ok: boolean;
  readonly code?: string;
  readonly check?: unknown;
}

interface Expected {
  readonly version: number;
  readonly limits: string;
  readonly cases: readonly Case[];
}

/** 目录不存在时是空的（`describe.skipIf` 仍会执行收集用例的函数体）。 */
const vectors: Expected = existsSync(EXPECTED)
  ? (JSON.parse(readFileSync(EXPECTED, 'utf8')) as Expected)
  : { version: 1, limits: 'default', cases: [] };

describe.skipIf(!existsSync(EXPECTED))('资源核对的二进制样本（与 Rust 相同）', () => {
  it('格式版本 1，上限用默认值', () => {
    expect(vectors.version).toBe(1);
    expect(vectors.limits).toBe('default');
    expect(vectors.cases.length).toBeGreaterThan(0);
  });

  for (const sample of vectors.cases) {
    it(`${sample.file}（${sample.purpose}，${sample.format}）`, async () => {
      const bytes = new Uint8Array(readFileSync(join(CHECK, sample.file)));
      try {
        const check = await checkAsset(
          sample.purpose,
          bytesSource(bytes),
          DEFAULT_UPLOAD_LIMITS,
          sample.format,
        );
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

  it('不声明格式时按内容认，结果相同', async () => {
    for (const sample of vectors.cases) {
      const bytes = new Uint8Array(readFileSync(join(CHECK, sample.file)));
      let outcome: unknown;
      try {
        outcome = await checkAsset(sample.purpose, bytesSource(bytes), DEFAULT_UPLOAD_LIMITS);
      } catch (error) {
        if (!(error instanceof CheckError)) throw error;
        outcome = error.code;
      }
      expect(outcome, sample.file).toEqual(sample.ok ? sample.check : sample.code);
    }
  });
});
