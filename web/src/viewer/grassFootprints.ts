import type { GeographicPolygon } from '../core/environment';
import { tileBounds, type Tile } from './geography';

/** Rasterize surveyed hardscape once when constructing a nearby grass patch. */
export class GrassFootprints {
  private readonly polygons;
  private context?: CanvasRenderingContext2D;

  constructor(polygons: readonly GeographicPolygon[]) {
    this.polygons = polygons.map((rings) => {
      let west = Infinity,
        east = -Infinity,
        south = Infinity,
        north = -Infinity;
      for (const [lon, lat] of rings[0]!) {
        west = Math.min(west, lon);
        east = Math.max(east, lon);
        south = Math.min(south, lat);
        north = Math.max(north, lat);
      }
      return { west, east, south, north, rings };
    });
  }

  coverage(tile: Tile, cells: number) {
    const [west, south, east, north] = tileBounds(tile);
    const overlaps = this.polygons.filter(
      (p) => p.east >= west && p.west <= east && p.north >= south && p.south <= north,
    );
    if (!overlaps.length) return null;
    this.context ??=
      document.createElement('canvas').getContext('2d', { willReadFrequently: true }) ?? undefined;
    const ctx = this.context;
    if (!ctx) return null;
    if (ctx.canvas.width !== cells || ctx.canvas.height !== cells) {
      ctx.canvas.width = cells;
      ctx.canvas.height = cells;
    } else ctx.clearRect(0, 0, cells, cells);
    // Near-field tiles are under 50 m wide. Rows run from north to south, like grassCell.
    // A half-cell margin also covers blade lean and subpixel edges at the root.
    ctx.lineWidth = 1;
    ctx.lineJoin = 'round';
    for (const { rings } of overlaps) {
      ctx.beginPath();
      for (const ring of rings) {
        for (const [i, [lon, lat]] of ring.entries()) {
          const x = (cells * (lon - west)) / (east - west);
          const y = (cells * (north - lat)) / (north - south);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
      }
      ctx.fill('evenodd');
      ctx.stroke();
    }
    return ctx.getImageData(0, 0, cells, cells).data;
  }

  filter(tile: Tile, cells: number, candidates: Uint16Array | null) {
    if (candidates?.length === 0) return candidates;
    const coverage = this.coverage(tile, cells);
    if (!coverage) return candidates;
    const available = candidates ?? Uint16Array.from({ length: cells * cells }, (_, i) => i);
    return available.filter((id) => coverage[id * 4 + 3] === 0);
  }
}
