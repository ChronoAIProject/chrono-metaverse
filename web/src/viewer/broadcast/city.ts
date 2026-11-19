import * as T from 'three';
import type { BroadcastModel, Equipment, Point } from '../../core/broadcastTour';
const zero: Point = [0, 0, 0];

export function placeEquipment(
  parent: T.Group,
  items: Equipment[],
  attach: (model: BroadcastModel, holder: T.Group) => void,
) {
  const updates: ((time: number) => void)[] = [];
  for (const item of items) {
    const { model, motion, count = 1, position = zero, rotation = zero, scale = 1 } = item;
    for (let i = 0; i < count; i++) {
      const object = new T.Group();
      attach(model, object);
      object.position.fromArray(position);
      object.rotation.set(...rotation);
      object.scale.setScalar(scale);
      parent.add(object);
      if (!motion) continue;
      const phase = (motion.phase ?? 0) + (i * 2 * Math.PI) / count;
      updates.push((t) => {
        const a = (t * 2 * Math.PI) / motion.period + phase;
        const [x, y, z] = position,
          [rx, ry, rz] = motion.radius;
        const sin = Math.sin(a),
          cos = Math.cos(a);
        if (motion.kind === 'route') {
          object.position.set(x + rx * sin, y + ry * Math.sin(2 * a), z + rz * cos);
          object.rotation.set(
            rotation[0],
            rotation[1] + Math.atan2(rz * sin, rx * cos),
            rotation[2] + 0.055 * Math.cos(2 * a),
          );
        } else if (motion.kind === 'hover') {
          object.position.set(x + rx * sin, y + ry * cos, z + rz * Math.cos(0.74 * a));
          const target = motion.lookAt;
          const yaw = target
            ? Math.atan2(target[0] - object.position.x, target[2] - object.position.z)
            : 0;
          object.rotation.set(
            rotation[0] + 0.06 * sin,
            rotation[1] + yaw,
            rotation[2] + 0.09 * cos,
          );
        } else {
          object.position.set(x + rx * sin, y + ry * sin, z + rz * sin);
          const turn = motion.turn ?? zero;
          object.rotation.set(
            rotation[0] + turn[0] * sin,
            rotation[1] + turn[1] * sin,
            rotation[2] + turn[2] * sin,
          );
        }
      });
    }
  }
  return (time: number) => {
    for (const update of updates) update(time);
  };
}
