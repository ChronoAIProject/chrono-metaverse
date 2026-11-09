import type { EntityBody } from './api/types';
import type { SceneContent } from './scene';

/**
 * 外部模型的署名（docs/SHAPES.md 第 3 节）：物件的 `props.source` 是对象时，
 * 记录这个模型来自哪个模型库、作者、许可和来源页。网站的"模型来源"面板据此列出署名，
 * CC-BY 的模型必须这样署名。
 *
 * 规则与接口服务 `record.rs` 的 `ModelSource` 相同；接口服务写入时已经校验过，这里再按同样的
 * 规则检查一遍再显示（尤其是来源页只接受 https 地址），不合格的不显示。
 */

export const SOURCE_LIBRARIES = ['polyhaven', 'objaverse', 'sketchfab'] as const;
export const SOURCE_LICENSES = ['CC0-1.0', 'CC-BY-4.0', 'CC-BY-3.0'] as const;

export type SourceLibrary = (typeof SOURCE_LIBRARIES)[number];
export type SourceLicense = (typeof SOURCE_LICENSES)[number];

export interface ModelSource {
  readonly library: SourceLibrary;
  readonly id: string;
  /** 来源页（https 地址）。 */
  readonly page: string;
  readonly author: string;
  readonly license: SourceLicense;
  readonly title: string;
}

/** 许可的显示名和是否要求署名。 */
export const LICENSE_INFO: Readonly<
  Record<SourceLicense, { readonly label: string; readonly attribution: boolean }>
> = {
  'CC0-1.0': { label: 'CC0 1.0（公有领域）', attribution: false },
  'CC-BY-4.0': { label: 'CC BY 4.0（须署名）', attribution: true },
  'CC-BY-3.0': { label: 'CC BY 3.0（须署名）', attribution: true },
};

export const LIBRARY_LABELS: Readonly<Record<SourceLibrary, string>> = {
  polyhaven: 'Poly Haven',
  objaverse: 'Objaverse',
  sketchfab: 'Sketchfab',
};

const MAX_TEXT_CHARS = 200;
const MAX_URL_CHARS = 2000;
const FIELDS = ['library', 'id', 'page', 'author', 'license', 'title'];

/** 控制字符（与 Rust `char::is_control` 相同：U+0000–U+001F、U+007F–U+009F）。 */
function hasControl(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/** 空白（与 Rust `char::is_whitespace` 相同的 Unicode White_Space 字符）。 */
function hasWhitespace(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (
      (code >= 0x09 && code <= 0x0d) ||
      code === 0x20 ||
      code === 0x85 ||
      code === 0xa0 ||
      code === 0x1680 ||
      (code >= 0x2000 && code <= 0x200a) ||
      code === 0x2028 ||
      code === 0x2029 ||
      code === 0x202f ||
      code === 0x205f ||
      code === 0x3000
    ) {
      return true;
    }
  }
  return false;
}

/** 来源页地址：`https://` 开头、后面至少一个字符，不超过 2000 个字符，不含空白和控制字符。 */
export function isHttpsUrl(url: string): boolean {
  return (
    url.length > 'https://'.length &&
    url.startsWith('https://') &&
    [...url].length <= MAX_URL_CHARS &&
    !hasWhitespace(url) &&
    !hasControl(url)
  );
}

function okText(text: unknown): text is string {
  if (typeof text !== 'string') return false;
  const chars = [...text].length;
  return chars > 0 && chars <= MAX_TEXT_CHARS && !hasControl(text);
}

/** 物件的署名；`props.source` 不是对象（旧数据里的识别来源字符串）或不合规则时返回 null。 */
export function modelSourceOf(entity: EntityBody): ModelSource | null {
  const raw = entity.props?.source;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const source = raw as Record<string, unknown>;
  if (Object.keys(source).some((key) => !FIELDS.includes(key))) return null;
  if (!(SOURCE_LIBRARIES as readonly unknown[]).includes(source.library)) return null;
  if (!(SOURCE_LICENSES as readonly unknown[]).includes(source.license)) return null;
  if (!okText(source.id) || !okText(source.author) || !okText(source.title)) return null;
  if (typeof source.page !== 'string' || !isHttpsUrl(source.page)) return null;
  return source as unknown as ModelSource;
}

/** 面板里的一条署名：同一个模型（库 + 编号）用在几个物件上只列一次。 */
export interface SourceCredit {
  readonly source: ModelSource;
  /** 用到这个模型的物件的显示名（标签或编号），去重后按出现顺序。 */
  readonly usedBy: readonly string[];
}

/** 场景里所有物件（含组合里的各个成员）的署名，按标题排序。 */
export function sceneSources(content: SceneContent | null): SourceCredit[] {
  if (content === null) return [];
  const credits = new Map<string, { source: ModelSource; usedBy: string[] }>();
  for (const member of content.members) {
    for (const entity of member.view.entities) {
      const source = modelSourceOf(entity);
      if (source === null) continue;
      const key = `${source.library}\u0000${source.id}`;
      const credit = credits.get(key) ?? { source, usedBy: [] };
      const name = entity.label ?? entity.entityId;
      if (!credit.usedBy.includes(name)) credit.usedBy.push(name);
      credits.set(key, credit);
    }
  }
  return [...credits.values()].sort(
    (a, b) =>
      a.source.title.localeCompare(b.source.title, 'zh-Hans-CN') ||
      a.source.id.localeCompare(b.source.id),
  );
}
