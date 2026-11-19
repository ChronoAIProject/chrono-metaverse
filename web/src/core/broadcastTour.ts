import { record } from './externalSource';

export type Point = [number, number, number];
export interface Pose {
  position?: Point;
  rotation?: Point;
  scale?: number;
}
export type BroadcastModel = string | { entity: string };
export interface Motion {
  kind: 'route' | 'hover' | 'oscillate';
  period: number;
  radius: Point;
  phase?: number;
  turn?: Point;
  lookAt?: Point;
}
export interface Equipment extends Pose {
  model: BroadcastModel;
  count?: number;
  motion?: Motion;
}
export interface TourStop {
  id: string;
  label: string;
  frame: 'screen' | 'local' | 'earth';
  position?: Point;
  rotation?: Point;
  minDistance: number;
  hideBeyond?: number;
  holdMs: number;
  camera: { eye: Point; target: Point };
  screen?: Pose;
  equipment?: Equipment[];
}
export interface BroadcastTour {
  version: 1;
  program: string;
  mirror: string;
  linkedScreens?: string[];
  environment?: string;
  initial: string;
  order: string[];
  stops: TourStop[];
}

const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const point = (v: unknown): v is Point => Array.isArray(v) && v.length === 3 && v.every(number);
const name = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
function pose(v: Record<string, unknown>) {
  return (
    (v.position === undefined || point(v.position)) &&
    (v.rotation === undefined || point(v.rotation)) &&
    (v.scale === undefined || (number(v.scale) && v.scale > 0))
  );
}
function equipment(value: unknown): boolean {
  const v = record(value);
  if (!v || !(name(v.model) || name(record(v.model)?.entity)) || !pose(v)) return false;
  if (
    v.count !== undefined &&
    !(number(v.count) && Number.isInteger(v.count) && v.count >= 1 && v.count <= 256)
  )
    return false;
  if (v.motion === undefined) return true;
  const m = record(v.motion);
  return (
    !!m &&
    (m.kind === 'route' || m.kind === 'hover' || m.kind === 'oscillate') &&
    point(m.radius) &&
    number(m.period) &&
    m.period > 0 &&
    (m.phase === undefined || number(m.phase)) &&
    (m.turn === undefined || point(m.turn)) &&
    (m.lookAt === undefined || point(m.lookAt))
  );
}
function stop(value: unknown): value is TourStop {
  const v = record(value);
  if (!v || !name(v.id) || !name(v.label) || !pose(v)) return false;
  const camera = record(v.camera);
  const screen = record(v.screen);
  return (
    (v.frame === 'screen' || v.frame === 'local' || v.frame === 'earth') &&
    number(v.minDistance) &&
    v.minDistance >= 0 &&
    (v.hideBeyond === undefined || (number(v.hideBeyond) && v.hideBeyond > v.minDistance)) &&
    number(v.holdMs) &&
    v.holdMs >= 0 &&
    !!camera &&
    point(camera.eye) &&
    point(camera.target) &&
    camera.eye.some((coord, i) => coord !== (camera.target as Point)[i]) &&
    (v.screen === undefined || (!!screen && pose(screen))) &&
    (v.equipment === undefined || (Array.isArray(v.equipment) && v.equipment.every(equipment)))
  );
}

/** 快照中的机位编号仅在该巡演内有意义。距离带和播放顺序可独立编排。 */
export function readBroadcastTour(value: unknown): BroadcastTour | null {
  const v = record(value);
  if (
    !v ||
    v.version !== 1 ||
    !name(v.program) ||
    !name(v.mirror) ||
    !name(v.initial) ||
    (v.environment !== undefined && !name(v.environment)) ||
    (v.linkedScreens !== undefined &&
      !(Array.isArray(v.linkedScreens) && v.linkedScreens.every(name))) ||
    !Array.isArray(v.stops) ||
    !v.stops.length ||
    !v.stops.every(stop) ||
    !Array.isArray(v.order) ||
    !v.order.length
  )
    return null;
  const stops = v.stops as TourStop[];
  const ids = new Set(stops.map((s) => s.id));
  const distances = new Set(stops.map((s) => s.minDistance));
  const total = stops.reduce(
    (n, s) => n + (s.equipment ?? []).reduce((m, e) => m + (e.count ?? 1), 0),
    0,
  );
  if (
    ids.size !== stops.length ||
    distances.size !== stops.length ||
    !distances.has(0) ||
    !ids.has(v.initial) ||
    !v.order.every((id) => ids.has(id)) ||
    total > 256
  )
    return null;
  return v as unknown as BroadcastTour;
}
