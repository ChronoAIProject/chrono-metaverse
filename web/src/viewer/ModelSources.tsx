import { LIBRARY_LABELS, LICENSE_INFO, type ModelSource, type SourceCredit } from '../core/sources';

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
function SourceLine({ source }: { readonly source: ModelSource }) {
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

const MODIFIED_NOTE =
  '这些模型可能经过调整（摆放烘进模型、减面、调色、缩小贴图）后重新导出，与原文件不同。';

/** 列出场景里所有带署名的模型（docs/SHAPES.md）。 */
export function ModelSources({ credits }: { readonly credits: readonly SourceCredit[] }) {
  if (credits.length === 0) return null;
  return (
    <section className="viewer__model-credits" aria-label="模型来源">
      <h3>模型来源</h3>
      <p className="viewer__sources-note">{MODIFIED_NOTE}</p>
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
