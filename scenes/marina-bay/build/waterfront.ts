import type { Kit, Vec3 } from '@chrono-metaverse/sdk';
import type { Placement } from './placement.ts';

export interface Quay {
  id: string;
  label: string;
  source: string;
  granite: { color: string; normal: string; roughness: string };
  start: Vec3;
  end: Vec3;
}

/** 岸线端点与 OneMap 外景用同一米制坐标。截面的 +X 朝陆地，+Z 沿岸。 */
export function waterfront(kit: Kit, quay: Quay, placement: Placement, regionId?: string) {
  const [x, y, z] = quay.start;
  const dx = quay.end[0] - x,
    dz = quay.end[2] - z;
  const length = Math.hypot(dx, dz);
  const count = Math.max(1, Math.round(length / 2.5));
  const span = length / count;
  const angle = (placement.yaw * Math.PI) / 180;
  const yaw = placement.yaw + (Math.atan2(dx, dz) * 180) / Math.PI;
  const [tx, ty, tz] = placement.translation;
  const steel = { color: '#9ea9ab', roughness: 0.38, metalness: 0.55 };
  // 错缝铺设，单块略有色差。石板的实体边缘在斜视时仍能接住日光。
  const paving = ['#b5b2a8', '#b9b6ac', '#b7b4a9', '#b2b0a7'];
  const granite = (tint: string, variant: number) => ({
    texture: { hash: quay.granite.color, uv: 'box' as const, tint },
    normalMap: quay.granite.normal,
    normalScale: 0.36,
    roughnessMap: quay.granite.roughness,
    roughness: 0.93,
    shading: 'albedo' as const,
    tile: 0.52,
    offset: [variant * 0.073, variant * 0.137] as const,
    rotate: 17 + variant * 53,
  });
  const slabs = Array.from({ length: 5 }, (_, row) => {
    const ends = row % 2 ? [0, 0.25, 0.75, 1] : [0, 0.5, 1];
    return ends.slice(1).map((end, col) => {
      const start = ends[col]!;
      const variant = (row + col) % paving.length;
      return kit.box([0.594, 0.115, (end - start) * span - 0.006], {
        at: [0.78 + row * 0.6, 0.17, (0.5 * (start + end) - 0.5) * span],
        ...granite(paving[variant]!, variant),
        chamfer: 0.003,
      });
    });
  }).flat();
  const children = [
    kit.box([3.04, 0.45, span], { at: [1.98, -0.18, 0], color: '#777771', roughness: 0.91 }),
    ...slabs,
    kit.box([0.48, 1.1, span], { at: [0.21, -0.6, 0], color: '#535958', roughness: 0.88 }),
    kit.box([0.52, 0.27, span - 0.016], { at: [0.19, 0.22, 0], color: '#8e8980', roughness: 0.83 }),
    kit.box([0.63, 0.16, span - 0.012], {
      at: [0.2, 0.5, 0],
      chamfer: 0.016,
      ...granite('#c9c3b3', 2),
    }),
    kit.cylinder(0.071, 0.025, { at: [0.21, 0.66, 0], segments: 10, ...steel }),
    kit.cylinder(0.031, 0.98, { at: [0.21, 0.68, 0], segments: 10, ...steel }),
    ...[0.95, 1.22, 1.66].map((height) =>
      kit.cylinder(height === 1.66 ? 0.035 : 0.016, span, {
        at: [0.21, height, -span / 2],
        pitch: 90,
        segments: 10,
        ...steel,
      }),
    ),
  ];
  return Array.from({ length: count }, (_, i) => {
    const t = (i + 0.5) / count;
    const px = x + dx * t,
      pz = z + dz * t;
    const at: Vec3 = [
      tx + Math.cos(angle) * px + Math.sin(angle) * pz,
      ty + y + (quay.end[1] - y) * t,
      tz - Math.sin(angle) * px + Math.cos(angle) * pz,
    ];
    return kit.entity(`${quay.id}.${i + 1}`, kit.group(children, { at, yaw }), {
      label: quay.label,
      regionId,
      kind: 'structure',
      props: {
        background: true,
        来源地址: quay.source,
        版权: '© OpenStreetMap contributors · ODbL',
      },
    });
  });
}
