import type { Kit, Shape, Vec3 } from '@chrono-metaverse/sdk';
import type { Placement } from './placement.ts';

export interface Quay {
  id: string;
  label: string;
  source: string;
  granite: { color: string; normal: string; roughness: string };
  /** Centres of crosswise paving bands, in metres from the shoreline start. */
  pavingStations?: number[];
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
  const slabsFor = (moduleLength: number) =>
    Array.from({ length: 5 }, (_, row) => {
      const ends = row % 2 ? [0, 0.25, 0.75, 1] : [0, 0.5, 1];
      return ends.slice(1).map((end, col) => {
        const start = ends[col]!;
        const variant = (row + col) % paving.length;
        return kit.box([0.594, 0.115, (end - start) * moduleLength - 0.006], {
          at: [0.78 + row * 0.6, 0.17, (0.5 * (start + end) - 0.5) * moduleLength],
          ...granite(paving[variant]!, variant),
          chamfer: 0.003,
        });
      });
    }).flat();
  const children = [
    kit.box([3.04, 0.45, span], {
      at: [1.98, -0.18, 0],
      color: '#777771',
      roughness: 0.91,
    }),
    // 朝步道的基层内退 2 厘米，板缝露出深色基层，饰面与基层不会争用同一深度。
    kit.box([0.46, 1.1, span], {
      at: [0.2, -0.6, 0],
      color: '#535958',
      roughness: 0.88,
    }),
    kit.box([0.52, 0.28, span - 0.016], {
      at: [0.19, 0.22, 0],
      ...granite('#a6a095', 1),
    }),
    kit.box([0.63, 0.16, span - 0.012], {
      at: [0.2, 0.5, 0],
      chamfer: 0.016,
      ...granite('#c9c3b3', 2),
    }),
  ];
  // The photographed posts repeat every ~1.8 m. Stone joints have their own spacing.
  const railCount = Math.max(1, Math.round(length / 1.8));
  const railSpan = length / railCount;
  const rails = [
    kit.cylinder(0.071, 0.025, { at: [0.21, 0.66, 0], segments: 10, ...steel }),
    kit.cylinder(0.031, 0.98, { at: [0.21, 0.68, 0], segments: 10, ...steel }),
    ...[0.82, 0.99, 1.15, 1.32, 1.49, 1.66].map((height) =>
      kit.cylinder(height === 1.66 ? 0.035 : 0.016, railSpan, {
        at: [0.21, height, -railSpan / 2],
        pitch: 90,
        segments: 10,
        ...steel,
      }),
    ),
  ];
  const stationEntity = (
    id: string,
    label: string,
    parts: Shape[],
    t: number,
    props: Record<string, string> = {},
    scaleZ = 1,
  ) => {
    const px = x + dx * t,
      pz = z + dz * t;
    const at: Vec3 = [
      tx + Math.cos(angle) * px + Math.sin(angle) * pz,
      ty + y + (quay.end[1] - y) * t,
      tz - Math.sin(angle) * px + Math.cos(angle) * pz,
    ];
    const scale: Vec3 | undefined = scaleZ === 1 ? undefined : [1, 1, scaleZ];
    return kit.entity(id, kit.group(parts, { at, yaw, scale }), {
      label,
      regionId,
      kind: 'structure',
      props: {
        background: true,
        来源地址: quay.source,
        版权: '© OpenStreetMap contributors · ODbL',
        ...props,
      },
    });
  };
  const stations = quay.pavingStations ?? [];
  const redWidth = 0.32,
    darkWidth = 1.16;
  const bounds = stations.map((s) => [s - darkWidth / 2 - redWidth, s + darkWidth / 2] as const);
  if (
    bounds.some(
      ([lo, hi], i) =>
        !Number.isFinite(lo) || lo < 0 || hi > length || (i > 0 && lo <= bounds[i - 1]![1]),
    )
  ) {
    throw new Error('滨水步道的铺装带必须按岸线里程升序排列，且相互分离。');
  }
  const first = bounds.length ? Math.floor(bounds[0]![0] / span) : 0;
  const last = bounds.length ? Math.ceil(bounds.at(-1)![1] / span) : 0;
  const full = [children[0]!, ...slabsFor(span), ...children.slice(1)];
  const stone = Array.from({ length: count }, (_, i) =>
    stationEntity(
      `${quay.id}.${i + 1}`,
      quay.label,
      i >= first && i < last ? children : full,
      (i + 0.5) / count,
    ),
  );
  // The bands replace slab faces across the three-metre walk at the same elevation.
  // A single pair of granite materials is shared along all surveyed stations.
  const band = Array.from({ length: 5 }, (_, row) => {
    const across = 0.78 + row * 0.6;
    return [
      kit.box([0.594, 0.115, redWidth - 0.006], {
        at: [across, 0.17, -darkWidth / 2],
        ...granite('#956e70', 2),
        chamfer: 0.003,
      }),
      kit.box([0.594, 0.115, darkWidth - 0.006], {
        at: [across, 0.17, redWidth / 2],
        ...granite('#737376', 1),
        chamfer: 0.003,
      }),
    ];
  }).flat();
  const source = {
    正射影像: 'Map Data © Singapore Land Authority / OneMap · OrthoJPG z20',
    实景参考: 'https://commons.wikimedia.org/wiki/File:Singapore_-_panoramio_(109).jpg',
    铺装依据: '深灰带中心沿 OneMap 影像配准估读。宽度、窄红棕边与色泽来自 2014 年照片估值。',
  };
  const pavingEntities = bounds.map(([lo, hi], i) =>
    stationEntity(
      `${quay.id}.band.${i + 1}`,
      '浮尔顿滨水步道 · 双色横向石带',
      band,
      (lo + hi) / (2 * length),
      source,
    ),
  );
  // Fit the ordinary staggered slabs between surveyed bands. Root scaling keeps
  // the common slab mesh instanced even when the measured intervals differ.
  const gapLength = 1.9,
    field = slabsFor(gapLength);
  const gaps = bounds.map(([lo], i) => [i ? bounds[i - 1]![1] : first * span, lo]);
  if (bounds.length) gaps.push([bounds.at(-1)![1], last * span]);
  for (const [i, [lo, hi]] of gaps.entries()) {
    const width = hi! - lo!;
    if (width < 0.006) continue;
    const n = Math.max(1, Math.round(width / gapLength));
    for (let j = 0; j < n; j++) {
      const mid = lo! + ((j + 0.5) * width) / n;
      pavingEntities.push(
        stationEntity(
          `${quay.id}.field.${i + 1}.${j + 1}`,
          '浮尔顿滨水步道 · 错缝花岗岩',
          field,
          mid / length,
          {},
          width / (n * gapLength),
        ),
      );
    }
  }
  const railProps = {
    实景参考: 'https://commons.wikimedia.org/wiki/File:Singapore_-_panoramio_(109).jpg',
    栏杆依据:
      '2014 年临水立面可辨一道扶手、五道下横杆。按广场嵌石配准估读柱距约 1.8 米。杆径、高度、两端收口与现状均为估值。',
  };
  return [
    ...stone,
    ...pavingEntities,
    ...Array.from({ length: railCount }, (_, i) =>
      stationEntity(
        `${quay.id}.rail.${i + 1}`,
        '浮尔顿滨水步道 · 六道金属栏杆',
        rails,
        (i + 0.5) / railCount,
        railProps,
      ),
    ),
  ];
}
