// 构建后给命令行入口加上可执行权限（npm link 和直接运行 dist/cli.js 都需要）。
import { chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

chmodSync(fileURLToPath(new URL('../dist/cli.js', import.meta.url)), 0o755);
