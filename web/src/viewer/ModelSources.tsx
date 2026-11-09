import { LIBRARY_LABELS, LICENSE_INFO, type ModelSource, type SourceCredit } from '../core/sources';

/** 一条署名：标题（链到来源页）、作者、许可、模型库。全部是纯文本，链接只接受 https。 */
export function SourceLine({ source }: { readonly source: ModelSource }) {
  const license = LICENSE_INFO[source.license];
  return (
    <>
      <a
        className="viewer__source-title"
        href={source.page}
        target="_blank"
        rel="noopener noreferrer"
      >
        {source.title}
      </a>
      <span className="viewer__source-meta">
        <span>作者 {source.author}</span>
        <span data-license={source.license}>{license.label}</span>
        <span>{LIBRARY_LABELS[source.library]}</span>
      </span>
    </>
  );
}

/**
 * "模型来源"面板（docs/SHAPES.md 第 3 节）：列出场景里所有外部模型的标题、作者、许可和来源页。
 * 场景里有外部模型时，查看器右下角一直有"模型来源"按钮，CC-BY 模型的署名点开就能看到。
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
  const needsCredit = credits.filter((c) => LICENSE_INFO[c.source.license].attribution).length;
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
        {needsCredit > 0 ? `，其中 ${needsCredit} 个按 CC BY 许可署名如下` : ''}。
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
