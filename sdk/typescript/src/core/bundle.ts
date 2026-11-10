import { canonicalJson, CanonicalError } from './canonical.js';
import { isSha256Hex } from './hash.js';
import { isObjectId, isSpaceId, SPACE_ANCHOR_ID } from './ids.js';
import {
  DEFAULT_UPLOAD_LIMITS,
  MAX_RECORD_BYTES,
  maxBytesOf,
  type BundleFilePurpose,
  type UploadLimits,
} from './limits.js';
import { OpError, validateScanSpec, type ScanSpec } from './ops.js';
import {
  isRebuiltId,
  parseAnchorBody,
  parseEntityBody,
  RecordError,
  REBUILT_ID_PREFIX,
  validateAnchorBody,
  validateEntityBody,
  type AnchorBody,
  type EntityBody,
} from './record.js';
import { textureRefs, type Shape, type TemplateTable } from './shape.js';
import { isRfc3339 } from './timestamp.js';

/**
 * 重建包清单的结构校验（docs/SHAPES.md 第 7 节；Rust `bundle.rs` 的 `Bundle::parse` 的移植）。
 *
 * 命令行 `metaverse bundle check` 用它查清单本身：外层的字段和类型、工具、说明、时间、基础版本、
 * 文件表、扫描、每条记录（按 SHAPES 校验）、锚点、建模记录、报告，以及记录里引用的每个文件都在
 * `files` 里、用途对得上。校验的先后和出错的字段（`field`）与 Rust 相同，向量 `tests/vectors/bundle/`
 * 核对。**不展开成操作**：展开只在服务端（接口服务交包、部署种子）。
 */

export const BUNDLE_FORMAT = 'chrono-metaverse-rebuild-bundle';
export const BUNDLE_VERSION = 1;
export const MAX_BUNDLE_ENTITIES = 2000;
export const MAX_BUNDLE_TEMPLATES = 200;
export const MAX_BUNDLE_ANCHORS = 2000;
export const MAX_BUNDLE_REMOVE = 2000;
export const MAX_BUNDLE_FILES = 4096;
export const MAX_FILE_PATH_CHARS = 200;
export const MAX_NOTE_CHARS = 2000;
export const MAX_TOOL_TEXT_CHARS = 64;
export const MAX_REPORT_BYTES = 64 * 1024;
const MAX_REPORT_RAW_BYTES = 1024 * 1024;

export class BundleError extends Error {
  constructor(
    /** 出错的字段（JSON 路径），`$` 表示整个清单的结构。 */
    readonly field: string,
    readonly detail: string,
  ) {
    super(`${field}：${detail}`);
    this.name = 'BundleError';
  }
}

export type RebuiltMode = 'replace' | 'merge';

export interface BundleFile {
  readonly path: string;
  readonly purpose: BundleFilePurpose;
  readonly sha256: string;
  readonly size: number;
}

export interface BundleScan extends ScanSpec {
  readonly observedAt?: string;
}

/** 校验过的清单。 */
export interface CheckedBundle {
  readonly tool: { readonly name: string; readonly version: string; readonly source?: string };
  readonly note: string;
  readonly createdAt: string;
  readonly base: { readonly spaceId: string; readonly seq: number } | null;
  readonly scan: BundleScan | null;
  readonly rebuilt: {
    readonly mode: RebuiltMode;
    readonly templates: readonly EntityBody[];
    readonly entities: readonly EntityBody[];
    readonly remove: readonly string[];
  } | null;
  readonly anchors: readonly AnchorBody[];
  readonly notes: string | null;
  readonly report: Readonly<Record<string, unknown>> | null;
  readonly files: readonly BundleFile[];
  /** 记录里引用到的全部资源（哈希 → 用途）。 */
  readonly references: ReadonlyMap<string, BundleFilePurpose>;
}

export interface BundleCheckOptions {
  /** 各用途的上限（`limits.json`）；不给时用默认值。 */
  readonly limits?: UploadLimits;
  /** 目标空间重建层已有的模板，只在 `merge` 模式下可以引用。 */
  readonly spaceTemplates?: TemplateTable | null;
}

type Json = Record<string, unknown>;

const FILE_PURPOSES: readonly BundleFilePurpose[] = [
  'scan',
  'webmodel',
  'model',
  'texture',
  'script',
];

function fail(field: string, detail: string): never {
  throw new BundleError(field, detail);
}

function isPlainObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function given(object: Json, key: string): boolean {
  return object[key] !== undefined && object[key] !== null;
}

function hasControl(text: string, allowNewline = false): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (allowNewline && code === 0x0a) continue;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function charCount(text: string): number {
  return [...text].length;
}

function isU64(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

// ---------------------------------------------------------------------------
// 外层结构（相当于服务端的反序列化，任何一处不对都报在 `$` 上）
// ---------------------------------------------------------------------------

function structure(ok: boolean, detail: string): void {
  if (!ok) fail('$', `格式不对：${detail}`);
}

function onlyKeys(object: Json, allowed: readonly string[], what: string): void {
  for (const key of Object.keys(object)) {
    structure(allowed.includes(key), `${what}里不认识的字段 ${key}`);
  }
}

function checkStructure(value: Json): void {
  onlyKeys(
    value,
    [
      'format',
      'version',
      'tool',
      'note',
      'createdAt',
      'base',
      'scan',
      'rebuilt',
      'anchors',
      'notes',
      'report',
      'files',
    ],
    '清单',
  );
  const tool = value.tool;
  structure(isPlainObject(tool), 'tool 必须是对象');
  const toolObject = tool as Json;
  onlyKeys(toolObject, ['name', 'version', 'source'], 'tool ');
  structure(typeof toolObject.name === 'string', 'tool.name 必须是字符串');
  structure(typeof toolObject.version === 'string', 'tool.version 必须是字符串');
  structure(
    !given(toolObject, 'source') || typeof toolObject.source === 'string',
    'tool.source 必须是字符串',
  );
  structure(typeof value.note === 'string', 'note 必须是字符串');
  structure(typeof value.createdAt === 'string', 'createdAt 必须是字符串');
  if (given(value, 'base')) {
    const base = value.base;
    structure(isPlainObject(base), 'base 必须是对象');
    onlyKeys(base as Json, ['spaceId', 'seq'], 'base ');
    structure(typeof (base as Json).spaceId === 'string', 'base.spaceId 必须是字符串');
    structure(isU64((base as Json).seq), 'base.seq 必须是非负整数');
  }
  if (given(value, 'scan')) {
    const scan = value.scan;
    structure(isPlainObject(scan), 'scan 必须是对象');
    const s = scan as Json;
    onlyKeys(s, ['assetHash', 'webModelHashes', 'transform', 'observedAt', 'alignment'], 'scan ');
    structure(typeof s.assetHash === 'string', 'scan.assetHash 必须是字符串');
    structure(
      Array.isArray(s.webModelHashes) && s.webModelHashes.every((h) => typeof h === 'string'),
      'scan.webModelHashes 必须是字符串数组',
    );
    structure(
      Array.isArray(s.transform) &&
        s.transform.length === 16 &&
        s.transform.every((v) => typeof v === 'number'),
      'scan.transform 必须是 16 个数',
    );
    structure(
      !given(s, 'observedAt') || isRfc3339(s.observedAt),
      'scan.observedAt 必须是 RFC 3339 时间',
    );
    structure(!given(s, 'alignment') || isPlainObject(s.alignment), 'scan.alignment 必须是对象');
  }
  if (given(value, 'rebuilt')) {
    const rebuilt = value.rebuilt;
    structure(isPlainObject(rebuilt), 'rebuilt 必须是对象');
    const r = rebuilt as Json;
    onlyKeys(r, ['mode', 'templates', 'entities', 'remove'], 'rebuilt ');
    structure(r.mode === 'replace' || r.mode === 'merge', 'rebuilt.mode 只能是 replace 或 merge');
    for (const key of ['templates', 'entities'] as const) {
      structure(r[key] === undefined || Array.isArray(r[key]), `rebuilt.${key} 必须是数组`);
    }
    structure(
      r.remove === undefined ||
        (Array.isArray(r.remove) && r.remove.every((id) => typeof id === 'string')),
      'rebuilt.remove 必须是字符串数组',
    );
  }
  structure(value.anchors === undefined || Array.isArray(value.anchors), 'anchors 必须是数组');
  structure(!given(value, 'notes') || typeof value.notes === 'string', 'notes 必须是字符串');
  structure(Array.isArray(value.files), 'files 必须是数组');
  for (const file of value.files as unknown[]) {
    structure(isPlainObject(file), 'files 的每一项必须是对象');
    const f = file as Json;
    onlyKeys(f, ['path', 'purpose', 'sha256', 'size'], 'files ');
    structure(typeof f.path === 'string', 'files[].path 必须是字符串');
    structure(
      FILE_PURPOSES.includes(f.purpose as BundleFilePurpose),
      'files[].purpose 只能是 scan、webmodel、model、texture、script',
    );
    structure(typeof f.sha256 === 'string', 'files[].sha256 必须是字符串');
    structure(isU64(f.size), 'files[].size 必须是非负整数');
  }
}

// ---------------------------------------------------------------------------
// 规则
// ---------------------------------------------------------------------------

/** `files[].path`：相对路径，字母、数字、`. _ -`，用 `/` 分段，没有 `.`、`..` 段，不超过 200 个字符。 */
export function isBundlePath(path: string): boolean {
  return (
    path.length <= MAX_FILE_PATH_CHARS &&
    path
      .split('/')
      .every((segment) => segment !== '.' && segment !== '..' && /^[A-Za-z0-9._-]+$/.test(segment))
  );
}

/** `report` 里的字符串（键和值）不能像本地路径。 */
export function looksLikeLocalPath(text: string): boolean {
  return (
    text.startsWith('/') ||
    text.startsWith('~') ||
    text.startsWith('file:') ||
    /^[A-Za-z]:[\\/]/.test(text)
  );
}

function checkReportStrings(value: unknown, path: string): void {
  if (typeof value === 'string') {
    if (looksLikeLocalPath(value)) fail(path, '不能写本地路径（以 /、~、file: 开头或盘符路径）');
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => checkReportStrings(item, `${path}[${index}]`));
  } else if (isPlainObject(value)) {
    // 与 Rust 的 BTreeMap 顺序相同：按键的 UTF-8 字节排序。
    const keys = Object.keys(value).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    for (const key of keys) {
      if (looksLikeLocalPath(key)) fail(path, '键不能写本地路径');
      checkReportStrings(value[key], `${path}.${key}`);
    }
  }
}

function checkPlainText(field: string, value: string, max: number): void {
  const count = charCount(value);
  if (count === 0 || count > max || hasControl(value)) {
    fail(field, `必须是 1 到 ${max} 个字符，不含控制字符`);
  }
}

function recordSize(record: unknown): number {
  return Buffer.byteLength(JSON.stringify(record) ?? '', 'utf8');
}

function parseRecord<T>(raw: unknown, field: string, parse: (value: unknown) => T): T {
  if (recordSize(raw) > MAX_RECORD_BYTES) fail(field, '单条记录的原始 JSON 超过 64 KiB');
  try {
    return parse(raw);
  } catch (error) {
    if (error instanceof RecordError) fail(field, `格式不对：${error.message}`);
    throw error;
  }
}

function checkRebuiltEntity(field: string, body: EntityBody, ids: Set<string>): void {
  if (body.layer !== 'rebuilt') fail(`${field}.layer`, '必须是 rebuilt');
  if (!isRebuiltId(body.entityId)) {
    fail(`${field}.entityId`, `必须以 ${REBUILT_ID_PREFIX} 开头`);
  }
  if (ids.has(body.entityId)) fail(`${field}.entityId`, '编号重复');
  ids.add(body.entityId);
}

function validateRecord(field: string, check: () => void): void {
  try {
    check();
  } catch (error) {
    if (error instanceof RecordError) fail(field, error.message);
    throw error;
  }
}

/** 解析并校验清单文本（大小、JSON、全部规则）。 */
export function checkBundleText(text: string, options: BundleCheckOptions = {}): CheckedBundle {
  const limits = options.limits ?? DEFAULT_UPLOAD_LIMITS;
  if (Buffer.byteLength(text, 'utf8') > limits.bundle.maxBytes) {
    fail('$', `清单超过 ${limits.bundle.maxBytes} 字节`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    fail('$', `清单必须是 JSON 对象：${(error as Error).message}`);
  }
  return checkBundle(value, options);
}

/** 校验已经解析好的清单（规则同 {@link checkBundleText}，不查清单本身的字节数）。 */
export function checkBundle(value: unknown, options: BundleCheckOptions = {}): CheckedBundle {
  const limits = options.limits ?? DEFAULT_UPLOAD_LIMITS;
  if (!isPlainObject(value)) fail('$', '清单必须是 JSON 对象');
  if (value.format !== BUNDLE_FORMAT) fail('format', `必须是 ${BUNDLE_FORMAT}`);
  if (value.version !== BUNDLE_VERSION) fail('version', '只认版本 1');
  checkStructure(value);
  const tool = value.tool as CheckedBundle['tool'];
  const note = value.note as string;
  const createdAt = value.createdAt as string;

  // 工具、说明、时间、基础版本。
  checkPlainText('tool.name', tool.name, MAX_TOOL_TEXT_CHARS);
  checkPlainText('tool.version', tool.version, MAX_TOOL_TEXT_CHARS);
  if (
    tool.source !== undefined &&
    tool.source !== null &&
    !/^git:[0-9a-f]{40}$/.test(tool.source)
  ) {
    fail('tool.source', '只能是 git: 加 40 位小写十六进制');
  }
  if (note.trim() === '' || charCount(note) > MAX_NOTE_CHARS || hasControl(note, true)) {
    fail('note', '必须是 1 到 2000 字，不含换行以外的控制字符');
  }
  if (!isRfc3339(createdAt)) fail('createdAt', '必须是 RFC 3339 时间');
  const base = given(value, 'base') ? (value.base as { spaceId: string; seq: number }) : null;
  if (base !== null) {
    if (!isSpaceId(base.spaceId)) fail('base.spaceId', '空间编号格式不对');
    if (base.seq < 1) fail('base.seq', '必须 ≥ 1');
  }

  // 文件表。
  const files = value.files as BundleFile[];
  if (files.length > MAX_BUNDLE_FILES) fail('files', `最多 ${MAX_BUNDLE_FILES} 项`);
  const purposes = new Map<string, BundleFilePurpose>();
  const paths = new Set<string>();
  files.forEach((file, index) => {
    const field = `files[${index}]`;
    if (!isBundlePath(file.path)) {
      fail(
        `${field}.path`,
        '必须是相对路径（字母、数字、. _ -，用 / 分段，没有 . 和 .. 段，不超过 200 个字符）',
      );
    }
    if (paths.has(file.path)) fail(`${field}.path`, '路径重复');
    paths.add(file.path);
    if (!isSha256Hex(file.sha256)) fail(`${field}.sha256`, '必须是 64 位小写十六进制');
    if (purposes.has(file.sha256)) fail(`${field}.sha256`, '同一哈希只能出现一次');
    purposes.set(file.sha256, file.purpose);
    const max = maxBytesOf(limits, file.purpose);
    if (file.size < 1 || file.size > max) {
      fail(`${field}.size`, `必须在 1 到 ${max} 字节之间（${file.purpose} 用途的上限）`);
    }
  });
  const references = new Map<string, BundleFilePurpose>();
  const reference = (field: string, hash: string, purpose: BundleFilePurpose): void => {
    const listed = purposes.get(hash);
    if (listed === undefined) {
      fail(field, `引用的 ${hash} 不在 files 里（包要完整：引用的每个文件都要列出）`);
    }
    if (listed !== purpose) {
      fail(field, `引用的 ${hash} 在 files 里的用途是 ${listed}，这里要 ${purpose}`);
    }
    references.set(hash, purpose);
  };
  const entityReferences = (field: string, entity: EntityBody): void => {
    if (entity.assetHash !== undefined) reference(`${field}.assetHash`, entity.assetHash, 'model');
    if (entity.shape !== undefined) {
      const hashes = [...textureRefs(entity.shape)].sort();
      for (const hash of hashes) reference(`${field}.shape`, hash, 'texture');
    }
    (entity.textures ?? []).forEach((hash, index) =>
      reference(`${field}.textures[${index}]`, hash, 'texture'),
    );
  };

  // 扫描。
  let scan: BundleScan | null = null;
  if (given(value, 'scan')) {
    const raw = value.scan as Json;
    scan = {
      assetHash: raw.assetHash as string,
      webModelHashes: raw.webModelHashes as string[],
      transform: raw.transform as number[],
      ...(given(raw, 'alignment') ? { alignment: raw.alignment as Json } : {}),
      ...(given(raw, 'observedAt') ? { observedAt: raw.observedAt as string } : {}),
    };
    try {
      validateScanSpec(scan);
    } catch (error) {
      if (error instanceof OpError) fail('scan', error.detail);
      throw error;
    }
    reference('scan.assetHash', scan.assetHash, 'scan');
    scan.webModelHashes.forEach((hash, index) =>
      reference(`scan.webModelHashes[${index}]`, hash, 'webmodel'),
    );
  }

  // 重建层。
  let rebuilt: CheckedBundle['rebuilt'] = null;
  const ids = new Set<string>();
  if (given(value, 'rebuilt')) {
    const raw = value.rebuilt as Json;
    const mode = raw.mode as RebuiltMode;
    const rawTemplates = (raw.templates ?? []) as unknown[];
    const rawEntities = (raw.entities ?? []) as unknown[];
    const remove = (raw.remove ?? []) as string[];
    if (rawTemplates.length > MAX_BUNDLE_TEMPLATES) {
      fail('rebuilt.templates', `最多 ${MAX_BUNDLE_TEMPLATES} 个模板`);
    }
    if (rawEntities.length > MAX_BUNDLE_ENTITIES) {
      fail('rebuilt.entities', `最多 ${MAX_BUNDLE_ENTITIES} 个物件`);
    }
    if (mode === 'replace' && remove.length > 0) fail('rebuilt.remove', '只在 merge 模式下能给');
    if (remove.length > MAX_BUNDLE_REMOVE) {
      fail('rebuilt.remove', `最多 ${MAX_BUNDLE_REMOVE} 个编号`);
    }
    // 模板先解析：物件按模板算包围盒。先放目标空间的模板（只在 merge 模式下），本包的覆盖它们。
    const lookup = new Map<string, Shape>();
    if (mode === 'merge' && options.spaceTemplates) {
      const space = options.spaceTemplates;
      const entries = space instanceof Map ? [...space.entries()] : Object.entries(space);
      for (const [id, shape] of entries) lookup.set(id, shape);
    }
    const templates = rawTemplates.map((rawTemplate, index) => {
      const field = `rebuilt.templates[${index}]`;
      const body = parseRecord(rawTemplate, field, parseEntityBody);
      checkRebuiltEntity(field, body, ids);
      if (body.kind !== 'template') fail(`${field}.kind`, '模板的 kind 必须是 template');
      if (body.shape !== undefined) lookup.set(body.entityId, body.shape);
      return body;
    });
    templates.forEach((body, index) => {
      const field = `rebuilt.templates[${index}]`;
      validateRecord(field, () => validateEntityBody(body, lookup));
      entityReferences(field, body);
    });
    const entities = rawEntities.map((rawEntity, index) => {
      const field = `rebuilt.entities[${index}]`;
      const body = parseRecord(rawEntity, field, parseEntityBody);
      checkRebuiltEntity(field, body, ids);
      if (body.kind === 'template') fail(`${field}.kind`, '模板写在 rebuilt.templates 里');
      validateRecord(field, () => validateEntityBody(body, lookup));
      entityReferences(field, body);
      return body;
    });
    const removed = new Set<string>();
    remove.forEach((id, index) => {
      const field = `rebuilt.remove[${index}]`;
      if (!isObjectId(id) || id.startsWith('_')) fail(field, '编号格式不对');
      if (ids.has(id)) fail(field, '不能与 templates、entities 的编号重复');
      if (removed.has(id)) fail(field, '编号重复');
      removed.add(id);
    });
    rebuilt = { mode, templates, entities, remove };
  }

  // 锚点。
  const rawAnchors = (value.anchors ?? []) as unknown[];
  if (rawAnchors.length > MAX_BUNDLE_ANCHORS) fail('anchors', `最多 ${MAX_BUNDLE_ANCHORS} 个锚点`);
  const anchorIds = new Set<string>();
  const anchors = rawAnchors.map((rawAnchor, index) => {
    const field = `anchors[${index}]`;
    const body = parseRecord(rawAnchor, field, parseAnchorBody);
    if (body.anchorId === SPACE_ANCHOR_ID) fail(`${field}.anchorId`, '不能是 _space');
    validateRecord(field, () => validateAnchorBody(body));
    if (anchorIds.has(body.anchorId)) fail(`${field}.anchorId`, '编号重复');
    anchorIds.add(body.anchorId);
    return body;
  });

  // 建模记录、报告。
  const notes = given(value, 'notes') ? (value.notes as string) : null;
  if (notes !== null) {
    if (!isSha256Hex(notes)) fail('notes', '必须是 64 位小写十六进制');
    reference('notes', notes, 'script');
  }
  let report: Json | null = null;
  if (given(value, 'report')) {
    if (recordSize(value.report) > MAX_REPORT_RAW_BYTES) fail('report', '太大');
    if (!isPlainObject(value.report)) fail('report', '必须是 JSON 对象');
    report = value.report;
    let canonical: string;
    try {
      canonical = canonicalJson(report);
    } catch (error) {
      if (error instanceof CanonicalError) fail('report', `无法规范化：${error.message}`);
      throw error;
    }
    if (Buffer.byteLength(canonical, 'utf8') > MAX_REPORT_BYTES) {
      fail('report', '规范化后超过 64 KiB');
    }
    checkReportStrings(report, 'report');
  }

  if (scan === null && rebuilt === null && rawAnchors.length === 0) {
    fail('$', 'scan、rebuilt、anchors 至少给一个');
  }
  return {
    tool,
    note,
    createdAt,
    base,
    scan,
    rebuilt,
    anchors,
    notes,
    report,
    files,
    references,
  };
}
