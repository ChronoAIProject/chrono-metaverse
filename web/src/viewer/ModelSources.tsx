import {
  attributionCredits,
  LIBRARY_LABELS,
  LICENSE_INFO,
  type ModelSource,
  type SourceCredit,
} from '../core/sources';

/** 外链：新窗口打开，不带来源信息。 */
function ExternalLink({
  href,
  className,
  children,
}: {
  readonly href: string;
  readonly className?: string;
  readonly children: string;
}) {
  return (
    <a className={className} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/** 一条署名：标题（链到来源页）、作者、许可（链到许可正文）、模型库。全部是纯文本，链接只接受 https。 */
export function SourceLine({ source }: { readonly source: ModelSource }) {
  const license = LICENSE_INFO[source.license];
  return (
    <>
      <ExternalLink className="viewer__source-title" href={source.page}>
        {source.title}
      </ExternalLink>
      <span className="viewer__source-meta">
        <span>作者 {source.author}</span>
        <span data-license={source.license}>
          <ExternalLink className="viewer__source-license" href={license.url}>
            {license.label}
          </ExternalLink>
        </span>
        <span>{LIBRARY_LABELS[source.library]}</span>
      </span>
    </>
  );
}

/**
 * 画面底部常驻的一行简短署名（CC BY 要求署名可见，不能藏在收起的面板里）：
 * "模型来源：标题 / 作者 / 许可 …，共 N 项"，标题链到来源页、许可链到许可正文；
 * 按钮展开完整的"模型来源"面板。场景里没有 CC BY 的模型时不显示（CC0 不要求署名）。
 * 一行放不下时先截短标题（模型库的标题常有四五十个字符），作者、许可和"共 N 项"留在行里看得见。
 */
export function CreditLine({
  credits,
  open,
  onToggle,
}: {
  readonly credits: readonly SourceCredit[];
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  const first = attributionCredits(credits)[0]?.source;
  if (first === undefined) return null;
  return (
    <div className="viewer__credit" role="note" aria-label="模型署名">
      <span className="viewer__credit-text">
        模型来源：
        <ExternalLink className="viewer__credit-title" href={first.page}>
          {first.title}
        </ExternalLink>
        <span className="viewer__credit-rest">
          {` / ${first.author} / `}
          <ExternalLink href={LICENSE_INFO[first.license].url}>{first.license}</ExternalLink>
          {credits.length > 1 ? ` …，共 ${credits.length} 项` : ''}
        </span>
      </span>
      <button
        type="button"
        className="viewer__credit-toggle"
        aria-expanded={open}
        aria-controls="viewer-model-sources"
        onClick={onToggle}
      >
        {open ? '收起' : '全部来源'}
      </button>
    </div>
  );
}

/**
 * 改动说明（CC BY 要求注明是否改动过）：物件模型由写入方的工具导入、调整后重新导出再上传
 * （docs/SHAPES.md 第 3 节），服务端只核对格式和上限，不知道也不规定用的是什么工具，
 * 所以说明不提具体是谁处理的，只说可能做过哪些调整。
 */
export const MODIFIED_NOTE =
  '这些模型可能经过调整（摆放烘进模型、减面、调色、缩小贴图）后重新导出，与原文件不同。';

/**
 * "模型来源"面板（docs/SHAPES.md 第 3 节）：列出场景里所有外部模型的标题、作者、许可和来源页。
 * 有 CC BY 模型时从底部的署名行展开；只有 CC0 模型时从右下角的"模型来源"按钮展开。
 */
export function ModelSources({
  credits,
  open,
  onClose,
}: {
  readonly credits: readonly SourceCredit[];
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  if (!open || credits.length === 0) return null;
  const needsCredit = attributionCredits(credits).length;
  return (
    <section className="viewer__sources" aria-label="模型来源" id="viewer-model-sources">
      <header>
        <h2>模型来源</h2>
        <button type="button" className="viewer__info-close" onClick={onClose} aria-label="关闭">
          ×
        </button>
      </header>
      <p className="viewer__sources-note">
        场景里 {credits.length} 个物件模型来自公开模型库
        {needsCredit > 0 ? `，其中 ${needsCredit} 个按 CC BY 许可署名如下` : ''}。{MODIFIED_NOTE}
      </p>
      <ul>
        {credits.map(({ source, usedBy }) => (
          <li key={`${source.library}:${source.id}`}>
            <SourceLine source={source} />
            <span className="viewer__source-used">用于：{usedBy.join('、')}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
