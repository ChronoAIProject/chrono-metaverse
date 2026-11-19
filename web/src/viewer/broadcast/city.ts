import * as T from 'three';
import { airship, drone } from './models';

export function buildCity(city: T.Group) {
  const planes = airship(),
    copter = drone();
  const traffic: { object: T.Group; center: T.Vector3; i: number; ship: boolean }[] = [];
  const carriers = [
    [-342, 171, 75, 1.9],
    [249, 256, 96, 3.2],
    [360, 118, 190, 1.4],
    [-310, 315, -590, 2.2],
    [-110, 105, 270, 1.22],
  ];
  carriers.forEach(([x, y, z, s], i) => {
    const obj = planes.clone();
    obj.scale.setScalar(s!);
    obj.position.set(x!, y!, z!);
    obj.rotation.y = i % 2 === 0 ? -0.35 : 2.7;
    obj.rotation.z = 0.04;
    city.add(obj);
    traffic.push({ object: obj, center: obj.position.clone(), i, ship: true });
  });
  for (let i = 0; i < 12; i++) {
    const obj = copter.clone();
    const flock = Math.floor(i / 4),
      j = i % 4;
    obj.position.set(
      -235 + flock * 231 + j * 10,
      112 + flock * 25 + Math.abs(j - 3) * 5,
      180 + flock * 20 + (j % 3) * 8,
    );
    obj.scale.setScalar(1.35 + (i % 3) * 0.19);
    if (i >= 10) {
      obj.position.set(i === 10 ? 180 : -235, i === 10 ? 190 : 156, 498);
      obj.scale.setScalar(1.55);
      obj.rotation.z = i === 10 ? -0.22 : 0.18;
    }
    city.add(obj);
    traffic.push({ object: obj, center: obj.position.clone(), i, ship: false });
  }
  return (t: number) => {
    for (const { object, center, i, ship } of traffic) {
      const a = t * (ship ? 0.075 : 0.29) + i;
      object.position.set(
        center.x + Math.sin(a) * (ship ? 55 : 6),
        center.y + Math.cos(a * 1.2) * (ship ? 4 : 2.8),
        center.z + Math.cos(a) * (ship ? 14 : 5),
      );
      if (!ship) object.rotation.y = a * 0.6;
    }
  };
}
