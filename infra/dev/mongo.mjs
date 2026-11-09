#!/usr/bin/env node
// 本地开发用的 MongoDB 小工具（不依赖驱动）：查副本集名、等单节点副本集选出主节点。
// up.sh 以前借处理服务虚拟环境里的 pymongo 做这两件事；处理服务下线以后（docs/design/server-slim.md 10.3）
// 本地全套不再需要 Python，所以用 Node 直接按 MongoDB 的消息格式（OP_MSG + BSON）发两条命令。
//
// 用法：
//   node infra/dev/mongo.mjs set-name <端口>        打印副本集名；连不上或不是副本集时退出码非 0
//   node infra/dev/mongo.mjs init <端口> [秒数]      没初始化就初始化成单节点副本集 rs0，等它成为主节点
//   node infra/dev/mongo.mjs drop <端口> <库名>      删除一个库（九步验收收尾用）

import net from 'node:net';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// BSON（只实现这两条命令用得到的类型）
// ---------------------------------------------------------------------------

function cstring(text) {
  return Buffer.concat([Buffer.from(text, 'utf8'), Buffer.from([0])]);
}

/** 编码一个文档：值可以是字符串、整数（int32）、布尔、数组、普通对象。 */
export function encode(document) {
  const parts = [];
  for (const [key, value] of Object.entries(document)) {
    if (typeof value === 'string') {
      const text = Buffer.from(value, 'utf8');
      const length = Buffer.alloc(4);
      length.writeInt32LE(text.length + 1);
      parts.push(Buffer.from([0x02]), cstring(key), length, text, Buffer.from([0]));
    } else if (typeof value === 'number' && Number.isInteger(value)) {
      const number = Buffer.alloc(4);
      number.writeInt32LE(value);
      parts.push(Buffer.from([0x10]), cstring(key), number);
    } else if (typeof value === 'boolean') {
      parts.push(Buffer.from([0x08]), cstring(key), Buffer.from([value ? 1 : 0]));
    } else if (Array.isArray(value)) {
      const asObject = Object.fromEntries(value.map((item, index) => [String(index), item]));
      parts.push(Buffer.from([0x04]), cstring(key), encode(asObject));
    } else if (value && typeof value === 'object') {
      parts.push(Buffer.from([0x03]), cstring(key), encode(value));
    } else {
      throw new Error(`不支持的值：${key}`);
    }
  }
  const body = Buffer.concat(parts);
  const length = Buffer.alloc(4);
  length.writeInt32LE(body.length + 5);
  return Buffer.concat([length, body, Buffer.from([0])]);
}

/** 解码一个文档（不认识的类型抛错）。返回 [文档, 读过的字节数]。 */
export function decode(buffer, offset = 0, asArray = false) {
  const size = buffer.readInt32LE(offset);
  const end = offset + size - 1;
  let at = offset + 4;
  const out = asArray ? [] : {};
  while (at < end) {
    const type = buffer[at];
    at += 1;
    const keyEnd = buffer.indexOf(0, at);
    const key = buffer.toString('utf8', at, keyEnd);
    at = keyEnd + 1;
    let value;
    switch (type) {
      case 0x01:
        value = buffer.readDoubleLE(at);
        at += 8;
        break;
      case 0x02: {
        const length = buffer.readInt32LE(at);
        value = buffer.toString('utf8', at + 4, at + 4 + length - 1);
        at += 4 + length;
        break;
      }
      case 0x03:
      case 0x04: {
        const [inner, used] = decode(buffer, at, type === 0x04);
        value = inner;
        at += used;
        break;
      }
      case 0x05: {
        const length = buffer.readInt32LE(at);
        value = buffer.subarray(at + 5, at + 5 + length);
        at += 5 + length;
        break;
      }
      case 0x07:
        value = buffer.toString('hex', at, at + 12);
        at += 12;
        break;
      case 0x08:
        value = buffer[at] === 1;
        at += 1;
        break;
      case 0x09:
      case 0x11:
      case 0x12:
        value = buffer.readBigInt64LE(at);
        at += 8;
        break;
      case 0x0a:
        value = null;
        break;
      case 0x10:
        value = buffer.readInt32LE(at);
        at += 4;
        break;
      case 0x13:
        at += 16;
        value = null;
        break;
      default:
        throw new Error(`不认识的 BSON 类型 0x${type.toString(16)}（键 ${key}）`);
    }
    if (asArray) out.push(value);
    else out[key] = value;
  }
  return [out, size];
}

/** 一条 OP_MSG 命令。 */
export function message(requestId, command) {
  const body = encode(command);
  const header = Buffer.alloc(16 + 4 + 1);
  header.writeInt32LE(16 + 4 + 1 + body.length, 0);
  header.writeInt32LE(requestId, 4);
  header.writeInt32LE(0, 8);
  header.writeInt32LE(2013, 12);
  header.writeUInt32LE(0, 16);
  header[20] = 0;
  return Buffer.concat([header, body]);
}

/** 发一条命令（默认对 admin 库），返回回复的文档。 */
export function command(port, document, timeoutMs = 1500, database = 'admin') {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let received = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('超时'));
    }, timeoutMs);
    socket.on('connect', () => socket.write(message(1, { ...document, $db: database })));
    socket.on('data', (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (received.length >= 4 && received.length >= received.readInt32LE(0)) {
        clearTimeout(timer);
        socket.end();
        try {
          if (received.readInt32LE(12) !== 2013) throw new Error('回复不是 OP_MSG');
          resolve(decode(received, 21)[0]);
        } catch (error) {
          reject(error);
        }
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function setName(port) {
  const hello = await command(port, { hello: 1 });
  if (!hello.setName) {
    process.exitCode = 2;
    return;
  }
  console.log(hello.setName);
}

async function init(port, seconds) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    try {
      const hello = await command(port, { hello: 1 });
      if (hello.isWritablePrimary) return;
      if (!hello.setName) {
        await command(port, {
          replSetInitiate: { _id: 'rs0', members: [{ _id: 0, host: `127.0.0.1:${port}` }] },
        }).catch(() => {});
      }
    } catch {
      // 还没起来。
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  process.exitCode = 1;
}

async function drop(port, database) {
  const reply = await command(port, { dropDatabase: 1 }, 10_000, database);
  if (reply.ok !== 1) process.exitCode = 1;
}

async function main(args) {
  const [action, port, extra] = args;
  if (action === 'set-name' && port) return setName(Number(port));
  if (action === 'init' && port) return init(Number(port), Number(extra || 60));
  if (action === 'drop' && port && extra) return drop(Number(port), extra);
  console.error('用法：mongo.mjs set-name <端口> | init <端口> [秒数] | drop <端口> <库名>');
  process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(() => {
    process.exitCode = 1;
  });
}
