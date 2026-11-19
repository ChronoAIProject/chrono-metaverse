// 场景数据只能依赖通用平台，生产核心不能依赖具体场景。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (
      entry.isDirectory() &&
      ["node_modules", ".venv", "__pycache__", "out", "target"].includes(
        entry.name,
      )
    )
      return [];
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
  const coreErrors = roots
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
        /^(web\/src\/(viewer\/|core\/(externalSource|environment)\.ts$)|api\/crates\/metaverse-api\/src\/(external\/|routes\/external\.rs$))/.test(
          relative(root, file),
        )
      ) {
        for (const host of providerHosts)
          if (source.includes(host))
            errors.push(`通用资源层包含场景提供方地址：${host}`);
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
  // 空间来源由 API 保存。既检查生产源码，也检查可能把节目重新灌入空间的种子和生成器。
  const program =
    /(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:watch\?(?:[^"'\s]*?&)?v=|(?:embed|live|shorts)\/))[A-Za-z0-9_-]{11}(?![A-Za-z0-9_-])/i;
  const inputs = [...roots, "scenes", "infra/chrono-cd", "web/public"];
  const mediaErrors = inputs
    .filter((dir) => existsSync(join(root, dir)))
    .flatMap((dir) => files(join(root, dir)))
    .filter(
      (file) =>
        /\.(?:[cm]?js|[cm]?ts|tsx|py|rs|json|sh|html)$/.test(file) &&
        !/\/(?:fixtures|node_modules|out|target)\/|\.test\./.test(file),
    )
    .filter((file) => program.test(readFileSync(file, "utf8")))
    .map((file) => `${relative(root, file)}：实际节目地址应由空间 API 提供`);
  return [...coreErrors, ...mediaErrors];
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
