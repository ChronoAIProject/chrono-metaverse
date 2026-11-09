#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { defaultSdkRoot } from './commands/common.js';
import { main } from './commands/index.js';

// metaverse 命令行入口（npm link 后就是 `metaverse`，也可以 `node dist/cli.js`）。
const code = await main(
  {
    cwd: process.cwd(),
    env: process.env,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    sdkRoot: defaultSdkRoot(),
    cliPath: fileURLToPath(import.meta.url),
  },
  process.argv.slice(2),
);
process.exitCode = code;
