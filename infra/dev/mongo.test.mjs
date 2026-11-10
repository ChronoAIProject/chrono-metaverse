// infra/dev/mongo.mjs 的测试：BSON 编码、解码往返，OP_MSG 的格式；本机 27018 上有副本集时
// 再真的查一次副本集名（没有就跳过）。
import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';

import { command, decode, encode, message } from './mongo.mjs';

test('文档编码后能原样解码', () => {
  const document = {
    hello: 1,
    $db: 'admin',
    ok: true,
    members: [{ _id: 0, host: '127.0.0.1:27017' }],
    nested: { name: '副本集' },
  };
  const [back, used] = decode(encode(document));
  assert.equal(used, encode(document).length);
  assert.deepEqual(back, document);
});

test('OP_MSG 的头：总长度、操作码、标志位和第 0 段', () => {
  const bytes = message(7, { hello: 1, $db: 'admin' });
  assert.equal(bytes.readInt32LE(0), bytes.length);
  assert.equal(bytes.readInt32LE(4), 7);
  assert.equal(bytes.readInt32LE(12), 2013);
  assert.equal(bytes.readUInt32LE(16), 0);
  assert.equal(bytes[20], 0);
  assert.deepEqual(decode(bytes, 21)[0], { hello: 1, $db: 'admin' });
});

test('能解码回复里常见的类型（浮点、长整数、时间戳、对象编号、二进制）', () => {
  const parts = [];
  const field = (type, key, value) => parts.push(Buffer.from([type]), Buffer.from(`${key}\0`), value);
  const double = Buffer.alloc(8);
  double.writeDoubleLE(1);
  field(0x01, 'ok', double);
  const long = Buffer.alloc(8);
  long.writeBigInt64LE(5n);
  field(0x12, 'counter', long);
  field(0x11, 'operationTime', long);
  field(0x07, 'processId', Buffer.alloc(12, 0xab));
  const binary = Buffer.concat([Buffer.from([3, 0, 0, 0, 0]), Buffer.from([1, 2, 3])]);
  field(0x05, 'hash', binary);
  const body = Buffer.concat(parts);
  const length = Buffer.alloc(4);
  length.writeInt32LE(body.length + 5);
  const [document] = decode(Buffer.concat([length, body, Buffer.from([0])]));
  assert.equal(document.ok, 1);
  assert.equal(document.counter, 5n);
  assert.equal(document.processId, 'ab'.repeat(12));
  assert.deepEqual([...document.hash], [1, 2, 3]);
});

test('本机 27018 上的副本集（没有就跳过）', async (t) => {
  const open = await new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: 27018 });
    socket.on('connect', () => {
      socket.end();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
  });
  if (!open) {
    t.skip('27018 上没有 MongoDB');
    return;
  }
  const hello = await command(27018, { hello: 1 });
  assert.equal(typeof hello.setName, 'string');
  assert.equal(hello.ok, 1);
});
