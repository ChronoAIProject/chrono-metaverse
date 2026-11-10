import { ZIP_MAX_CENTRAL_DIRECTORY_BYTES, ZIP_MAX_MEMBERS } from '../limits.js';
import { CHECK_VERSION, readExact, reject, view, type ByteSource, type ZipCheck } from './types.js';

/**
 * 扫描 zip 的检查（docs/design/server-slim.md 4.4，docs/SHAPES.md 第 8 节）。不解压成员，规则和拒绝码与
 * 接口服务的上传核对（Rust `runner/verify/zip.rs`）相同：
 *
 * 1. 文件末尾的中央目录（≤ 1 MiB）：不收 zip64、不收分卷，≤ 64 个成员，名称不重复；
 * 2. 成员名不能是绝对路径、盘符、不能含 `..` 段或控制字符，必须是 UTF-8；`__MACOSX/` 下的成员、`.DS_Store`
 *    和目录项（名称以 `/` 结尾）忽略（仍查路径安全）；其余必须正好一个网格成员（glb、drc、obj），别的只能
 *    是 jpg、png、mtl；压缩方式只能是存储或 deflate，没有加密；
 * 3. 各成员的本地头：签名、文件名、压缩方式与中央目录一致，大小和校验值一致（带数据描述符时本地头可以写
 *    0），各成员的数据区间都在文件内、互不重叠、都在中央目录之前。
 *
 * 拒绝码：`zip_structure`、`zip_zip64`、`zip_path`、`zip_encrypted`、`zip_method`、`zip_members`、
 * `zip_local_header`。
 */

const EOCD = 0x06054b50;
const EOCD64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
/** 结束记录的固定长度、后面注释的最大长度。 */
const EOCD_BYTES = 22;
const MAX_COMMENT = 0xffff;

interface Member {
  readonly name: string;
  readonly nameBytes: Uint8Array;
  readonly flags: number;
  readonly method: number;
  readonly crc: number;
  readonly compressed: number;
  readonly uncompressed: number;
  readonly offset: number;
}

/** 成员名的路径安全：不是绝对路径、没有盘符、没有 `..` 段、不含控制字符。不安全时返回说明。 */
export function unsafeMemberName(name: string): string | null {
  const bad =
    name === '' ||
    name.startsWith('/') ||
    name.startsWith('\\') ||
    /\p{Cc}/u.test(name) ||
    // 第二个字节是冒号：盘符（C:）。
    new TextEncoder().encode(name)[1] === 0x3a ||
    name.split(/[\\/]/).includes('..');
  return bad ? `zip 成员名不安全（绝对路径、盘符或 ..）：${name}` : null;
}

type Role = 'mesh' | 'other' | 'ignored';

function roleOf(name: string): Role {
  const unsafe = unsafeMemberName(name);
  if (unsafe !== null) reject('zip_path', unsafe);
  const base = name.split(/[\\/]/).pop() ?? name;
  if (name.startsWith('__MACOSX/') || base === '.DS_Store' || name.endsWith('/')) return 'ignored';
  const lower = base.toLowerCase();
  const dot = lower.lastIndexOf('.');
  const extension = dot === -1 ? '' : lower.slice(dot + 1);
  if (['glb', 'drc', 'obj'].includes(extension)) return 'mesh';
  if (['jpg', 'jpeg', 'png', 'mtl'].includes(extension)) return 'other';
  return reject(
    'zip_members',
    `扫描 zip 里只能有一个网格（glb、drc、obj）和贴图、材质（jpg、png、mtl）：${name}`,
  );
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** 检查扫描 zip，返回核对记录。 */
export async function checkZip(source: ByteSource): Promise<ZipCheck> {
  // 文件末尾：中央目录 + 结束记录 + 注释。
  const tailLength = Math.min(
    source.size,
    ZIP_MAX_CENTRAL_DIRECTORY_BYTES + EOCD_BYTES + MAX_COMMENT,
  );
  const tailStart = source.size - tailLength;
  const tail = await readExact(source, tailStart, tailLength, 'zip_structure', 'zip 的末尾');
  const data = view(tail);
  let eocd = -1;
  for (let at = tail.length - EOCD_BYTES; at >= 0; at -= 1) {
    if (tail.length - at > EOCD_BYTES + MAX_COMMENT) break;
    if (
      data.getUint32(at, true) === EOCD &&
      at + EOCD_BYTES + data.getUint16(at + 20, true) === tail.length
    ) {
      eocd = at;
      break;
    }
  }
  if (eocd === -1) reject('zip_structure', '找不到 zip 的结束记录');
  if (eocd >= 20 && data.getUint32(eocd - 20, true) === EOCD64_LOCATOR) {
    reject('zip_zip64', '不接受 zip64');
  }
  const disk = data.getUint16(eocd + 4, true);
  const cdDisk = data.getUint16(eocd + 6, true);
  const entriesHere = data.getUint16(eocd + 8, true);
  const entries = data.getUint16(eocd + 10, true);
  const cdSize = data.getUint32(eocd + 12, true);
  const cdOffset = data.getUint32(eocd + 16, true);
  if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    reject('zip_zip64', '不接受 zip64');
  }
  if (disk !== 0 || cdDisk !== 0 || entriesHere !== entries) {
    reject('zip_structure', '不接受分卷 zip');
  }
  if (entries > ZIP_MAX_MEMBERS) reject('zip_members', `zip 最多 ${ZIP_MAX_MEMBERS} 个成员`);
  if (cdSize > ZIP_MAX_CENTRAL_DIRECTORY_BYTES) {
    reject('zip_structure', 'zip 的中央目录超过 1 MiB');
  }
  if (cdOffset + cdSize !== tailStart + eocd || cdOffset < tailStart) {
    reject('zip_structure', 'zip 的中央目录位置不对');
  }

  // 中央目录。
  let directory = tail.subarray(cdOffset - tailStart, eocd);
  const members: Member[] = [];
  const names = new Set<string>();
  let mesh: string | null = null;
  for (let n = 0; n < entries; n += 1) {
    const record = view(directory);
    if (directory.length < 46 || record.getUint32(0, true) !== CENTRAL) {
      reject('zip_structure', 'zip 的中央目录记录不对');
    }
    const flags = record.getUint16(8, true);
    const method = record.getUint16(10, true);
    const crc = record.getUint32(16, true);
    const compressed = record.getUint32(20, true);
    const uncompressed = record.getUint32(24, true);
    const nameLength = record.getUint16(28, true);
    const extraLength = record.getUint16(30, true);
    const commentLength = record.getUint16(32, true);
    const diskStart = record.getUint16(34, true);
    const offset = record.getUint32(42, true);
    const size = 46 + nameLength + extraLength + commentLength;
    if (directory.length < size) reject('zip_structure', 'zip 的中央目录记录被截断');
    if (compressed === 0xffffffff || uncompressed === 0xffffffff || offset === 0xffffffff) {
      reject('zip_zip64', '不接受 zip64');
    }
    const extra = directory.subarray(46 + nameLength, 46 + nameLength + extraLength);
    for (let i = 0; i + 4 <= extra.length;) {
      if ((extra[i]! | (extra[i + 1]! << 8)) === 0x0001) reject('zip_zip64', '不接受 zip64');
      i += 4 + (extra[i + 2]! | (extra[i + 3]! << 8));
    }
    if (diskStart !== 0) reject('zip_structure', '不接受分卷 zip');
    const nameBytes = directory.subarray(46, 46 + nameLength);
    let name: string;
    try {
      name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes);
    } catch {
      return reject('zip_path', 'zip 成员名不是 UTF-8');
    }
    if ((flags & 0x0041) !== 0) reject('zip_encrypted', `zip 成员加密了：${name}`);
    if (method !== 0 && method !== 8) {
      reject('zip_method', `zip 成员的压缩方式只能是存储或 deflate：${name}`);
    }
    const role = roleOf(name);
    if (role === 'mesh') {
      if (mesh !== null) {
        reject('zip_members', '扫描 zip 里只能有一个网格成员（glb、drc、obj）');
      }
      mesh = name;
    }
    if (names.has(name)) reject('zip_structure', `zip 成员重名：${name}`);
    names.add(name);
    members.push({ name, nameBytes, flags, method, crc, compressed, uncompressed, offset });
    directory = directory.subarray(size);
  }
  if (directory.length > 0) reject('zip_structure', 'zip 的中央目录长度与记录数不符');
  if (mesh === null) reject('zip_members', '扫描 zip 里没有网格成员（glb、drc、obj）');

  // 各成员的本地头（按偏移排序）。
  members.sort((a, b) => a.offset - b.offset);
  let previousEnd = 0;
  for (let i = 0; i < members.length; i += 1) {
    const member = members[i]!;
    const name = member.name;
    const mismatch = (what: string): never =>
      reject('zip_local_header', `zip 成员 ${name} 的本地头${what}`);
    if (member.offset < previousEnd) {
      reject('zip_structure', `zip 成员 ${name} 与前一个成员的数据重叠`);
    }
    const header = await readExact(
      source,
      member.offset,
      30 + member.nameBytes.length,
      'zip_structure',
      `zip 成员 ${name} 的本地头`,
    );
    const local = view(header);
    if (local.getUint32(0, true) !== LOCAL) mismatch('签名不对');
    const flags = local.getUint16(6, true);
    const method = local.getUint16(8, true);
    const crc = local.getUint32(14, true);
    const compressed = local.getUint32(18, true);
    const uncompressed = local.getUint32(22, true);
    const nameLength = local.getUint16(26, true);
    const extraLength = local.getUint16(28, true);
    if ((flags & 0x0041) !== 0) reject('zip_encrypted', `zip 成员加密了：${name}`);
    if (method !== member.method) mismatch('与中央目录的压缩方式不一致');
    if (
      nameLength !== member.nameBytes.length ||
      !sameBytes(header.subarray(30), member.nameBytes)
    ) {
      mismatch('与中央目录的文件名不一致');
    }
    const descriptor = (flags & 0x0008) !== 0;
    const same = (value: number, central: number) =>
      value === central || (descriptor && value === 0);
    if (
      !same(compressed, member.compressed) ||
      !same(uncompressed, member.uncompressed) ||
      !same(crc, member.crc) ||
      descriptor !== ((member.flags & 0x0008) !== 0)
    ) {
      mismatch('与中央目录的大小或校验值不一致');
    }
    // 带数据描述符时，数据后面至少还有 12 个字节。
    const dataEnd =
      member.offset + 30 + nameLength + extraLength + member.compressed + (descriptor ? 12 : 0);
    const limit = members[i + 1]?.offset ?? cdOffset;
    if (dataEnd > limit || dataEnd > source.size) {
      reject('zip_structure', `zip 成员 ${name} 的数据超出了文件或与下一个成员重叠`);
    }
    previousEnd = dataEnd;
  }
  return { v: CHECK_VERSION, format: 'zip', mesh, members: members.length };
}
