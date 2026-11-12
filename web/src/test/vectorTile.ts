import Pbf from 'pbf';

/** 自有简单多边形夹具，不包含第三方地理数据。 */
export function vectorTileFixture(height = 24, hole = false): Uint8Array {
  const bytes = new Pbf();
  bytes.writeMessage(
    3,
    (_, layer) => {
      layer.writeVarintField(15, 2);
      layer.writeStringField(1, 'shapes');
      layer.writeVarintField(5, 4096);
      layer.writeStringField(3, 'elevation');
      layer.writeMessage(4, (_, value) => value.writeDoubleField(3, height), null);
      layer.writeMessage(
        2,
        (_, feature) => {
          feature.writeVarintField(1, 1);
          feature.writeVarintField(3, 3);
          feature.writePackedVarint(2, [0, 0]);
          const geometry: number[] = [];
          let x = 0,
            y = 0;
          const zigzag = (n: number) => (n < 0 ? -n * 2 - 1 : n * 2);
          const ring = (points: number[][]) => {
            for (let i = 0; i < points.length; i++) {
              const p = points[i]!;
              if (i === 0) geometry.push(9);
              if (i === 1) geometry.push(((points.length - 1) << 3) | 2);
              geometry.push(zigzag(p[0]! - x), zigzag(p[1]! - y));
              [x, y] = [p[0]!, p[1]!];
            }
            geometry.push(15);
          };
          ring([
            [1024, 1024],
            [3072, 1024],
            [3072, 3072],
            [1024, 3072],
          ]);
          if (hole)
            ring([
              [1536, 1536],
              [1536, 2560],
              [2560, 2560],
              [2560, 1536],
            ]);
          feature.writePackedVarint(4, geometry);
        },
        null,
      );
    },
    null,
  );
  return bytes.finish();
}
