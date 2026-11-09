import { coveredBy, type GridBox } from './grid.js';
import { isObjectId } from './ids.js';

/**
 * 路径范围（设计 9.4；Rust `scope.rs` 的移植）：地块路径下的每个操作都必须落在该地块内；
 * 实体区路径下的操作只能改实体区。
 */

export type RegionKind = 'physical' | 'virtual';

export interface Region {
  readonly id: string;
  readonly kind: RegionKind;
  readonly boxes: readonly GridBox[];
  readonly name?: string;
}

export interface Plot {
  readonly id: string;
  readonly regionId: string;
  readonly boxes: readonly GridBox[];
  readonly name?: string;
}

/** 路径给出的作用范围：`physical`、`plot:<编号>`、`source:<名称>`。 */
export type PathScope = 'physical' | `plot:${string}` | `source:${string}`;

export class ScopeError extends Error {
  constructor(
    readonly code: 'format' | 'unknown_plot' | 'no_geometry' | 'out_of_scope',
    message: string,
  ) {
    super(message);
    this.name = 'ScopeError';
  }
}

export function parsePathScope(value: string): PathScope {
  if (value === 'physical') return value;
  const at = value.indexOf(':');
  const kind = value.slice(0, at);
  const id = value.slice(at + 1);
  if (at < 0 || !isObjectId(id) || (kind !== 'plot' && kind !== 'source')) {
    throw new ScopeError('format', '作用范围格式不对');
  }
  return value as PathScope;
}

export function plotScope(plotId: string): PathScope {
  return parsePathScope(`plot:${plotId}`);
}

/** 一个操作的影响范围：涉及的格子盒子，以及是否涉及整个空间。 */
export interface Footprint {
  readonly cells: readonly GridBox[];
  readonly spaceWide: boolean;
}

/** 某个路径范围允许修改的格子范围。 */
export class AllowedArea {
  private constructor(
    readonly scope: PathScope,
    readonly boxes: readonly GridBox[],
  ) {}

  /** 实体区路径 → 所有实体区的盒子；地块路径 → 该地块的盒子；数据源路径不能改几何。 */
  static forScope(
    scope: PathScope,
    regions: readonly Region[],
    plots: readonly Plot[],
  ): AllowedArea {
    if (scope === 'physical') {
      return new AllowedArea(
        scope,
        regions.filter((r) => r.kind === 'physical').flatMap((r) => r.boxes),
      );
    }
    if (scope.startsWith('plot:')) {
      const id = scope.slice('plot:'.length);
      const plot = plots.find((p) => p.id === id);
      if (plot === undefined) throw new ScopeError('unknown_plot', `地块 ${id} 不存在`);
      return new AllowedArea(scope, plot.boxes);
    }
    throw new ScopeError('no_geometry', '这个路径范围不能修改几何内容');
  }

  /** 影响范围是否完全落在允许的范围内；空间级的影响只允许实体区路径。 */
  check(footprint: Footprint): void {
    const outOfScope = () => new ScopeError('out_of_scope', `操作超出了路径范围 ${this.scope}`);
    if (footprint.spaceWide && this.scope !== 'physical') throw outOfScope();
    if (!footprint.cells.every((cells) => coveredBy(cells, this.boxes))) throw outOfScope();
  }

  /** 不抛异常的版本：返回落在范围外的盒子。 */
  outside(footprint: Footprint): { spaceWide: boolean; cells: GridBox[] } {
    return {
      spaceWide: footprint.spaceWide && this.scope !== 'physical',
      cells: footprint.cells.filter((cells) => !coveredBy(cells, this.boxes)),
    };
  }
}
