interface TilePoint {
  readonly x: number;
  readonly y: number;
}

export interface FacadeSection {
  readonly outline: readonly TilePoint[];
  readonly extent: number;
  readonly bottom: number;
  readonly top: number;
  readonly tint?: number;
  readonly firstVertex: number;
  readonly endVertex: number;
}

/** A tower can be several MVT polygons. Continue the upper facade down walls
 * that share a surveyed corner, allowing for a mechanical floor between them. */
export function continueStackedFacades(sections: FacadeSection[], facade: number[]) {
  if (!sections.some((s) => s.bottom > 0)) return;
  const upperEdges = new Map<string, FacadeSection[]>();
  sections.sort((a, b) => b.top - a.top);
  for (const section of sections) {
    const { outline, extent, bottom, top, tint } = section;
    // A clipped neighbour may have a different set of sections on its tile.
    if (outline.some((p) => p.x <= 0 || p.y <= 0 || p.x >= extent || p.y >= extent)) continue;
    const edges: string[] = [];
    const shared = new Map<FacadeSection, { count: number; length: number }>();
    for (let i = 1; i < outline.length; i++) {
      const a = outline[i - 1]!,
        b = outline[i]!;
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      if (!length) continue;
      // MVT exterior rings use the same winding. Adjacent buildings traverse
      // their party wall in opposite directions.
      const key = [extent, a.x, a.y, b.x, b.y].join('/');
      edges.push(key);
      for (const upper of upperEdges.get(key) ?? []) {
        if (
          upper.tint !== tint ||
          upper.top <= top ||
          upper.bottom <= bottom ||
          Math.abs(upper.bottom - top) > 3
        )
          continue;
        const match = shared.get(upper) ?? { count: 0, length: 0 };
        match.count++;
        match.length += length;
        shared.set(upper, match);
      }
    }
    let continuation: FacadeSection | undefined;
    let longest = 0;
    for (const [upper, match] of shared) {
      if (match.count < 2) continue;
      if (match.length > longest) {
        longest = match.length;
        continuation = upper;
      } else if (match.length === longest) {
        // Equally supported towers rising from a podium have their own facades.
        continuation = undefined;
      }
    }
    if (continuation) {
      const variant = facade[2 * continuation.firstVertex + 1]!;
      for (let v = section.firstVertex; v < section.endVertex; v++) facade[2 * v + 1] = variant;
    }
    if (bottom > 0)
      for (const key of edges) {
        const incident = upperEdges.get(key);
        if (incident) incident.push(section);
        else upperEdges.set(key, [section]);
      }
  }
}
