import type { EntityBody } from '@chrono-metaverse/sdk';

export interface Placement {
  yaw: number;
  translation: [number, number, number];
  hostEntities: EntityBody[];
}

/** 整片外景一起对齐所在楼层的外墙，原有办公室坐标保持原位。 */
export function placeExterior(entity: EntityBody, placement: Placement): EntityBody {
  if (!entity.bounds) throw new Error(`${entity.entityId} 缺少范围`);
  const angle = (placement.yaw * Math.PI) / 180;
  const c = Math.cos(angle),
    s = Math.sin(angle);
  const point = (x: number, y: number, z: number): [number, number, number] => [
    c * x + s * z + placement.translation[0],
    y + placement.translation[1],
    -s * x + c * z + placement.translation[2],
  ];
  const points: number[][] = [];
  for (const x of [entity.bounds.min[0], entity.bounds.max[0]]) {
    for (const y of [entity.bounds.min[1], entity.bounds.max[1]]) {
      for (const z of [entity.bounds.min[2], entity.bounds.max[2]]) {
        points.push(point(x, y, z));
      }
    }
  }
  const view = entity.props?.backgroundView;
  let props = entity.props;
  if (view && typeof view === 'object' && 'focus' in view) {
    const focus = view.focus;
    if (Array.isArray(focus) && focus.length === 3 && focus.every(Number.isFinite)) {
      props = { ...props, backgroundView: { ...view, focus: point(focus[0], focus[1], focus[2]) } };
    }
  }
  return {
    ...entity,
    ...(props ? { props } : {}),
    transform: {
      ...entity.transform,
      yaw: (entity.transform?.yaw ?? 0) + placement.yaw,
    },
    bounds: {
      min: [0, 1, 2].map((k) => Math.min(...points.map((p) => p[k]!))) as [number, number, number],
      max: [0, 1, 2].map((k) => Math.max(...points.map((p) => p[k]!))) as [number, number, number],
    },
  };
}
