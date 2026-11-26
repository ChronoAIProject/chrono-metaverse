import { MathUtils, Vector3 } from 'three';
import type { Environment } from '../core/environment';
import { placePoint, type Placement } from '../core/scene';

/** The cylinder follows the environment's member when it is placed in a composition. */
export class CameraArea {
  private readonly center: Vector3;
  private readonly offset = new Vector3();
  private readonly minY: number;
  private readonly maxY: number;
  private readonly radius: number;

  constructor(area: NonNullable<Environment['cameraArea']>, placement: Placement) {
    this.center = new Vector3(
      ...placePoint(placement, [area.center[0], area.floor, area.center[1]]),
    );
    this.minY = this.center.y;
    this.maxY = this.minY + area.height;
    this.radius = area.radius;
  }

  private project(point: Vector3, margin = 0): void {
    const dx = point.x - this.center.x;
    const dz = point.z - this.center.z;
    const distance = Math.hypot(dx, dz);
    const radius = this.radius - margin;
    if (distance > radius) {
      point.x = this.center.x + (dx * radius) / distance;
      point.z = this.center.z + (dz * radius) / distance;
    }
    point.y = MathUtils.clamp(point.y, this.minY + margin, this.maxY - margin);
  }

  /** In first person the controls' target is the eye and their object only stores the look direction. */
  constrain(position: Vector3, target: Vector3, firstPerson = false): boolean {
    this.offset.copy(target);
    this.project(
      target,
      firstPerson ? 0 : Math.min(0.05, this.radius / 4, (this.maxY - this.minY) / 4),
    );
    this.offset.subVectors(target, this.offset);
    const moved = this.offset.lengthSq() > 0;
    position.add(this.offset);
    if (firstPerson) return moved;
    this.offset.copy(position);
    this.project(position);
    return moved || !position.equals(this.offset);
  }
}
