import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { violations } from "./check-scene-boundary.mjs";

test("场景专用值和源码依赖会失败，夹具和测试可以使用示例数据", () => {
  const root = mkdtempSync(join(tmpdir(), "scene-boundary-"));
  try {
    for (const directory of [
      "scenes/example",
      "web/src/fixtures",
      "sdk/typescript/src",
      "sdk/typescript/src/workspace",
      "recon/src",
      "api/crates/metaverse-core/src",
      "api/crates/metaverse-api/src",
    ])
      mkdirSync(join(root, directory), { recursive: true });
    writeFileSync(
      join(root, "scenes/example/context.json"),
      JSON.stringify({
        oneMap: { hostSourceId: "source-building-123" },
        host: { label: "示例中的特定建筑名称" },
      }),
    );
    writeFileSync(
      join(root, "scenes/example/metaverse.json"),
      JSON.stringify({ spaceId: "example-private-space" }),
    );
    writeFileSync(
      join(root, "web/src/viewer.ts"),
      'const space = "example-private-space";',
    );
    writeFileSync(
      join(root, "sdk/typescript/src/import.ts"),
      'readFileSync("scenes/example/context.json");',
    );
    writeFileSync(
      join(root, "recon/src/model.py"),
      'label = "示例中的特定建筑名称"',
    );
    writeFileSync(
      join(root, "web/src/fixtures/data.ts"),
      'const space = "example-private-space";',
    );
    writeFileSync(
      join(root, "web/src/viewer.test.ts"),
      'const source = "source-building-123";',
    );
    writeFileSync(
      join(root, "sdk/typescript/src/workspace/edit.ts"),
      'import { adapter } from "./context.js";',
    );
    const errors = violations(root);
    assert.equal(errors.length, 4);
    assert(errors.some((error) => error.includes("通用编辑层不能依赖")));
    assert(errors.some((error) => error.includes("web/src/viewer.ts")));
    assert(errors.some((error) => error.includes("生产核心依赖 scenes/")));
    assert(errors.some((error) => error.includes("recon/src/model.py")));
    for (const file of [
      "web/src/viewer.ts",
      "sdk/typescript/src/import.ts",
      "sdk/typescript/src/workspace/edit.ts",
      "recon/src/model.py",
    ])
      writeFileSync(join(root, file), "");
    assert.deepEqual(violations(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
