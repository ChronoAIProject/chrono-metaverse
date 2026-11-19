import * as T from 'three';
import { airship, cargoDrone, drone, surveyPlane } from './models';

type Point = [number, number, number];

export function buildCity(city: T.Group) {
  const ferry = airship(),
    camera = drone(),
    cargo = cargoDrone(),
    survey = surveyPlane();
  const flights: ((t: number) => void)[] = [];
  // 航线穿过两岸的空域，掉头处留在巨幕视线之外。切换机位时保留同一批实例。
  function route(
    model: T.Group,
    center: Point,
    radius: Point,
    period: number,
    phase: number,
    scale: number,
  ) {
    const craft = model.clone();
    craft.scale.setScalar(scale);
    city.add(craft);
    flights.push((t) => {
      const a = (t * 2 * Math.PI) / period + phase;
      craft.position.set(
        center[0] + radius[0] * Math.sin(a),
        center[1] + radius[1] * Math.sin(2 * a),
        center[2] + radius[2] * Math.cos(a),
      );
      craft.rotation.y = Math.atan2(radius[2] * Math.sin(a), radius[0] * Math.cos(a));
      craft.rotation.z = 0.055 * Math.cos(2 * a);
    });
  }
  route(ferry, [275, 251, 143], [117, 5, 48], 90, 0.28, 3.2);
  route(ferry, [-277, 169, -28], [116, 6, 52], 110, 2.9, 1.7);
  route(ferry, [110, 251, -481], [359, 4, 68], 135, 1.9, 1.35);
  route(cargo, [-249, 94, 270], [112, 8, 49], 74, 0.18, 2.75);
  route(cargo, [261, 76, 62], [104, 7, 58], 80, 2.35, 1.35);
  route(survey, [-230, 267, 314], [144, 9, 82], 65, -0.32, 2.25);
  route(survey, [308, 201, -297], [145, 11, 87], 71, 2.55, 1.6);
  const vantagePoints: Point[] = [
    [-178, 195, 392],
    [161, 184, 491],
    [-159, 151, 187],
    [138, 174, 129],
    [-211, 131, -49],
    [241, 159, 16],
    [-281, 142, 226],
    [151, 150, 243],
  ];
  for (const [i, center] of vantagePoints.entries()) {
    const rig = camera.clone();
    rig.scale.setScalar(i < 2 ? 2.65 : 1.05);
    city.add(rig);
    flights.push((t) => {
      const a = t * 0.21 + i * 1.8;
      rig.position.set(
        center[0] + 3 * Math.sin(a),
        center[1] + 1.3 * Math.cos(a),
        center[2] + 2 * Math.cos(a * 0.74),
      );
      rig.rotation.set(
        0.06 * Math.sin(a),
        Math.atan2(-40 - rig.position.x, 96 - rig.position.z),
        0.09 * Math.cos(a),
      );
    });
  }
  return (t: number) => {
    for (const fly of flights) fly(t);
  };
}
