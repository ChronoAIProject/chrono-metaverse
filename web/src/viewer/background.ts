import type { EntityBody } from '../core/api/types';
import { isBackgroundEntity } from '../core/scene';

type Point = [number, number, number];
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function point(value: unknown): Point | null {
  return Array.isArray(value) &&
    value.length === 3 &&
    value.every((v) => typeof v === 'number' && Number.isFinite(v))
    ? (value as Point)
    : null;
}
function distance(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** 背景可按离关注位置的距离切换：近看室内剖面，远看完整楼体。 */
export function backgroundView(entity: EntityBody) {
  if (!isBackgroundEntity(entity)) return null;
  const config = record(entity.props?.backgroundView);
  const focus = point(config?.focus);
  if (!config || !focus) return null;
  const min = distance(config.minDistance, 0);
  const max = distance(config.maxDistance, Infinity);
  return max > min ? { focus, min, max } : null;
}

/** 位置标记独立于家具标签，拉远后保持可读，点击可返回指定范围。 */
export function backgroundLandmark(entity: EntityBody) {
  if (!isBackgroundEntity(entity)) return null;
  const config = record(entity.props?.landmark);
  const position = point(config?.position);
  const bounds = record(config?.focusBounds);
  const min = point(bounds?.min),
    max = point(bounds?.max);
  if (
    !config ||
    typeof config.label !== 'string' ||
    !config.label.trim() ||
    config.label.length > 200 ||
    !position ||
    !min ||
    !max ||
    min.some((v, i) => v >= max[i]!)
  )
    return null;
  return {
    label: config.label,
    position,
    bounds: { min, max },
    minDistance: distance(config.minDistance, 0),
  };
}
