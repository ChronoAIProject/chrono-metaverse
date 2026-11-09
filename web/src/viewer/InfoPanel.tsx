import { modelSourceOf } from '../core/sources';
import { SourceLine } from './ModelSources';
import type { Selection } from './sceneView';

const LAYER: Record<string, string> = { rebuilt: '重建层', ext: '扩展层' };
const KIND: Record<string, string> = { structure: '结构', object: '物体', template: '模板' };

function plain(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/**
 * 点选物件后的信息面板（设计 4.4）：物件的 `props` 是不透明的键值，
 * 这里只按纯文本列出（React 文本节点，不解释成 HTML），不做其他解释。
 * 例外：`props.source` 是合规的外部模型署名时，显示成来源（标题链到来源页、作者、许可）。
 */
export function InfoPanel({
  selection,
  onClose,
}: {
  readonly selection: Selection;
  readonly onClose: () => void;
}) {
  const { entity } = selection;
  const source = modelSourceOf(entity);
  const props = Object.entries(entity.props ?? {}).filter(
    ([key]) => key !== 'glass' && !(key === 'source' && source !== null),
  );
  const fit = entity.fit;
  return (
    <aside className="viewer__info" aria-label="物件信息">
      <header>
        <h2>{entity.label ?? entity.entityId}</h2>
        <button type="button" className="viewer__info-close" onClick={onClose} aria-label="关闭">
          ×
        </button>
      </header>
      <dl>
        <dt>编号</dt>
        <dd>{entity.entityId}</dd>
        <dt>图层</dt>
        <dd>
          {LAYER[entity.layer] ?? entity.layer} · {KIND[entity.kind] ?? entity.kind}
        </dd>
        {entity.anchorId && (
          <>
            <dt>锚点</dt>
            <dd>{entity.anchorId}</dd>
          </>
        )}
        {fit?.meanCm !== undefined && (
          <>
            <dt>拟合偏差</dt>
            <dd>
              平均 {fit.meanCm} 厘米{fit.p90Cm !== undefined ? `，90% ≤ ${fit.p90Cm} 厘米` : ''}
            </dd>
          </>
        )}
        {source !== null && (
          <>
            <dt>来源</dt>
            <dd className="viewer__info-source">
              <SourceLine source={source} />
            </dd>
          </>
        )}
        {props.map(([key, value]) => (
          <div key={key} className="viewer__info-prop">
            <dt>{key}</dt>
            <dd>{plain(value)}</dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}
