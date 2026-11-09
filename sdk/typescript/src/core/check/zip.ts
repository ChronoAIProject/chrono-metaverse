import { ZIP_MAX_CENTRAL_DIRECTORY_BYTES, ZIP_MAX_MEMBERS } from '../limits.js';
import { CHECK_VERSION, readExact, reject, view, type ByteSource, type ZipCheck } from './types.js';

/**
 * 扫描 zip 的检查（docs/design/server-slim.md 4.4，docs/SHAPES.md 第 8 节）。不解压成员，只读文件末尾的
 * 中央目录和各成员的本地头：
 *
 * - 中央目录 ≤ 1 MiB、≤ 64 个成员，不收 zip64，只有一个分卷；
 * - 每个成员：压缩方式只能是存储或 deflate、没有加密；成员名不是绝对路径、不含 `..` 段；
 * - 本地头与中央目录一致（文件名、压缩方式；没有数据描述符时还有大小），各成员的数据区间都在中央目录之前、
 *   互不重叠；
 * - `__MACOSX/` 下的成员、`.DS_Store` 和目录项（名称以 `/` 结尾）忽略（仍查路径安全）；其余必须正好一个
 *   网格成员（glb、drc、obj），别的只能是 jpg、png、mtl。
 *
 * 拒绝码：`zip_format`（找不到中央目录结尾、分卷、结构不对）、`zip_too_large`（中央目录超过上限）、`zip64`、
 * `zip_encrypted`、`zip_method`、`zip_path`、`zip_members`、`zip_local_header`、`zip_overlap`。
 */

const EOCD = 0x06054b50;
const EOCD64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MESH_EXTENSIONS = ['.glb', '.drc', '.obj'];
const OTHER_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.mtl'];

interface Entry {
  readonly name: string;
  readonly nameBytes: Uint8Array;
  readonly flags: number;
  readonly method: number;
  readonly compressed: number;
  readonly size: number;
  readonly localOffset: number;
}

function extension(name: string): string {
  const base = name.slice(name.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

/** 成员名的路径安全：不是绝对路径（`/`、`\`、盘符），不含 `..` 段。 */
export function unsafeMemberName(name: string): string | null {
  if (name === '') return '成员名为空';
  if (name.startsWith('/') || name.startsWith('\\') || /^[A-Za-z]:/.test(name)) {
    return `成员 ${name} 是绝对路径`;
  }
  if (name.split(/[\\/]/).includes('..')) return `成员 ${name} 含 .. 段`;
  return null;
}

function ignored(name: string): boolean {
  const base = name.slice(name.lastIndexOf('/') + 1);
  return name.startsWith('__MACOSX/') || base === '.DS_Store' || name.endsWith('/');
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** 找中央目录结尾（EOCD）：从文件末尾往前找签名，注释长度要正好到文件末尾。 */
async function findEnd(source: ByteSource): Promise<{ offset: number; record: DataView }> {
  const tailLength = Math.min(source.size, 22 + 0xffff);
  const tailStart = source.size - tailLength;
  const tail = await readExact(source, tailStart, tailLength, 'zip_format', '文件末尾');
  const data = view(tail);
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (data.getUint32(i, true) === EOCD && i + 22 + data.getUint16(i + 20, true) === tail.length) {
      if (i >= 20 && data.getUint32(i - 20, true) === EOCD64_LOCATOR) {
        reject('zip64', '不收 zip64');
      }
      return { offset: tailStart + i, record: new DataView(tail.buffer, tail.byteOffset + i, 22) };
    }
  }
  return reject('zip_format', '找不到 zip 的中央目录结尾');
}

/** 检查扫描 zip，返回核对记录。 */
export async function checkZip(source: ByteSource): Promise<ZipCheck> {
  const { offset: endOffset, record } = await findEnd(source);
  const disk = record.getUint16(4, true);
  const cdDisk = record.getUint16(6, true);
  const onDisk = record.getUint16(8, true);
  const total = record.getUint16(10, true);
  const cdSize = record.getUint32(12, true);
  const cdOffset = record.getUint32(16, true);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    reject('zip64', '不收 zip64');
  }
  if (disk !== 0 || cdDisk !== 0 || onDisk !== total) reject('zip_format', '不收分卷 zip');
  if (cdSize > ZIP_MAX_CENTRAL_DIRECTORY_BYTES) {
    reject('zip_too_large', `中央目录 ${cdSize} 字节，超过上限 ${ZIP_MAX_CENTRAL_DIRECTORY_BYTES}`);
  }
  if (total > ZIP_MAX_MEMBERS)
    reject('zip_too_large', `${total} 个成员，超过上限 ${ZIP_MAX_MEMBERS}`);
  if (cdOffset + cdSize > endOffset) reject('zip_format', '中央目录超出文件');
  const cd = await readExact(source, cdOffset, cdSize, 'zip_format', '中央目录');
  const cdView = view(cd);
  const entries: Entry[] = [];
  let at = 0;
  for (let n = 0; n < total; n += 1) {
    if (at + 46 > cd.length || cdView.getUint32(at, true) !== CENTRAL) {
      reject('zip_format', `中央目录第 ${n} 项的结构不对`);
    }
    const nameLength = cdView.getUint16(at + 28, true);
    const extraLength = cdView.getUint16(at + 30, true);
    const commentLength = cdView.getUint16(at + 32, true);
    const end = at + 46 + nameLength + extraLength + commentLength;
    if (end > cd.length) reject('zip_format', `中央目录第 ${n} 项超出中央目录`);
    const nameBytes = cd.subarray(at + 46, at + 46 + nameLength);
    const name = new TextDecoder('utf-8').decode(nameBytes);
    const entry: Entry = {
      name,
      nameBytes,
      flags: cdView.getUint16(at + 8, true),
      method: cdView.getUint16(at + 10, true),
      compressed: cdView.getUint32(at + 20, true),
      size: cdView.getUint32(at + 24, true),
      localOffset: cdView.getUint32(at + 42, true),
    };
    const extra = cd.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength);
    for (let i = 0; i + 4 <= extra.length;) {
      const id = extra[i]! | (extra[i + 1]! << 8);
      if (id === 0x0001) reject('zip64', `成员 ${name} 带 zip64 扩展信息`);
      i += 4 + (extra[i + 2]! | (extra[i + 3]! << 8));
    }
    if (
      entry.compressed === 0xffffffff ||
      entry.size === 0xffffffff ||
      entry.localOffset === 0xffffffff ||
      cdView.getUint16(at + 34, true) === 0xffff
    ) {
      reject('zip64', `成员 ${name} 用了 zip64`);
    }
    if ((entry.flags & 0x0041) !== 0) reject('zip_encrypted', `成员 ${name} 加密了`);
    if (entry.method !== 0 && entry.method !== 8) {
      reject('zip_method', `成员 ${name} 的压缩方式 ${entry.method} 不是存储或 deflate`);
    }
    const unsafe = unsafeMemberName(name);
    if (unsafe !== null) reject('zip_path', unsafe);
    entries.push(entry);
    at = end;
  }

  // 成员种类。
  const meshes = entries.filter(
    (e) => !ignored(e.name) && MESH_EXTENSIONS.includes(extension(e.name)),
  );
  for (const entry of entries) {
    if (ignored(entry.name)) continue;
    const ext = extension(entry.name);
    if (!MESH_EXTENSIONS.includes(ext) && !OTHER_EXTENSIONS.includes(ext)) {
      reject('zip_members', `成员 ${entry.name} 不是网格（glb、drc、obj）或 jpg、png、mtl`);
    }
  }
  if (meshes.length !== 1) {
    reject('zip_members', `必须正好有一个网格成员（glb、drc、obj），这里有 ${meshes.length} 个`);
  }

  // 本地头。
  const ranges: [number, number, string][] = [];
  for (const entry of entries) {
    const head = view(
      await readExact(
        source,
        entry.localOffset,
        30,
        'zip_local_header',
        `成员 ${entry.name} 的本地头`,
      ),
    );
    if (head.getUint32(0, true) !== LOCAL) {
      reject('zip_local_header', `成员 ${entry.name} 的本地头签名不对`);
    }
    const flags = head.getUint16(6, true);
    const method = head.getUint16(8, true);
    const compressed = head.getUint32(18, true);
    const size = head.getUint32(22, true);
    const nameLength = head.getUint16(26, true);
    const extraLength = head.getUint16(28, true);
    const name = await readExact(
      source,
      entry.localOffset + 30,
      nameLength,
      'zip_local_header',
      `成员 ${entry.name} 的本地文件名`,
    );
    if (!sameBytes(name, entry.nameBytes)) {
      reject('zip_local_header', `成员 ${entry.name} 的本地头文件名与中央目录不一致`);
    }
    if ((flags & 0x0041) !== 0) reject('zip_encrypted', `成员 ${entry.name} 加密了`);
    if (method !== entry.method) {
      reject('zip_local_header', `成员 ${entry.name} 的本地头压缩方式与中央目录不一致`);
    }
    // 有数据描述符（第 3 位）时本地头里的大小可以是 0。
    const described = (flags & 0x0008) !== 0;
    const sizesMatch = compressed === entry.compressed && size === entry.size;
    if (!sizesMatch && !(described && compressed === 0 && size === 0)) {
      reject('zip_local_header', `成员 ${entry.name} 的本地头大小与中央目录不一致`);
    }
    const dataStart = entry.localOffset + 30 + nameLength + extraLength;
    const dataEnd = dataStart + entry.compressed;
    if (dataEnd > cdOffset)
      reject('zip_overlap', `成员 ${entry.name} 的数据超出文件（或压进中央目录）`);
    ranges.push([entry.localOffset, dataEnd, entry.name]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i += 1) {
    if (ranges[i]![0] < ranges[i - 1]![1]) {
      reject('zip_overlap', `成员 ${ranges[i - 1]![2]} 和 ${ranges[i]![2]} 的数据区间重叠`);
    }
  }
  return { v: CHECK_VERSION, format: 'zip', mesh: meshes[0]!.name, members: entries.length };
}
