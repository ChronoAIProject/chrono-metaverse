// 场景数据只能依赖通用平台，生产核心不能依赖具体场景。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

export function violations(root) {
  const sceneFiles = readdirSync(join(root, "scenes"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) =>
      ["context.json", "metaverse.json", "build/environment.json"].map((name) =>
        join(root, "scenes", entry.name, name),
      ),
    )
    .filter(existsSync);
  const values = new Set();
  const providerHosts = new Set();
  function collectProviders(value) {
    if (!value || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value)) {
      if (
        ["url", "urlTemplate", "tilesBaseUrl"].includes(key) &&
        typeof entry === "string"
      ) {
        try {
          providerHosts.add(new URL(entry).hostname);
        } catch {
          /* 无效配置由来源校验处理。 */
        }
      } else collectProviders(entry);
    }
  }
  for (const file of sceneFiles) {
    const config = JSON.parse(readFileSync(file, "utf8"));
    collectProviders(config);
    for (const value of [
      config.spaceId,
      config.oneMap?.hostSourceId,
      config.host?.label,
    ]) {
      if (typeof value === "string" && value.length >= 8) values.add(value);
    }
  }
  const roots = [
    "web/src",
    "sdk/typescript/src",
    "recon/src",
    "api/crates/metaverse-core/src",
    "api/crates/metaverse-api/src",
  ];
  return roots
    .flatMap((directory) => files(join(root, directory)))
    .filter(
      (file) =>
        /\.(tsx?|py|rs)$/.test(file) &&
        !/\/fixtures\/|\/demo_seed\/|\.test\./.test(file),
    )
    .flatMap((file) => {
      const source = readFileSync(file, "utf8").split(/^#\[cfg\(test\)\]/m)[0];
      const errors = [];
      if (
        /^web\/src\/(viewer\/|core\/(externalSource|environment)\.ts$)/.test(
          relative(root, file),
        )
      ) {
        for (const host of providerHosts)
          if (source.includes(host))
            errors.push(`通用显示层包含场景提供方地址：${host}`);
      }
      if (
        [
          "sdk/typescript/src/commands/edit.ts",
          "sdk/typescript/src/workspace/edit.ts",
          "recon/src/metaverse_recon/content.py",
        ].includes(relative(root, file)) &&
        /\b(?:from|import)\b[^\n]*\bcontext\b/.test(source)
      )
        errors.push("通用编辑层不能依赖地图或背景提供方");
      if (
        /(?:from|import|require|readFile|include_str|open)[^\n]*scenes\//.test(
          source,
        )
      )
        errors.push("生产核心依赖 scenes/");
      for (const value of values)
        if (source.includes(value))
          errors.push(`生产核心包含场景专用值：${value}`);
      return errors.map((error) => `${relative(root, file)}：${error}`);
    });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const errors = violations(resolve(import.meta.dirname, "../.."));
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else
    console.log("场景隔离检查通过：核心无具体场景依赖与当前示例的专用标识。");
}
