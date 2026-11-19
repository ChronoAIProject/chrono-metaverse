import * as T from 'three';
import { airship, drone, flightLane, gold, ice, rose } from './models';

function canvasMaterial(
  width: number,
  height: number,
  paint: (ctx: CanvasRenderingContext2D) => void,
) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  paint(ctx);
  const map = new T.CanvasTexture(canvas);
  map.colorSpace = T.SRGBColorSpace;
  map.anisotropy = 4;
  return new T.MeshBasicMaterial({ map, toneMapped: false });
}

export function nameplate(text: string) {
  const material = canvasMaterial(1024, 64, (ctx) => {
    ctx.fillStyle = '#0c1928';
    ctx.fillRect(0, 0, 1024, 64);
    ctx.fillStyle = ice;
    ctx.fillRect(0, 0, 10, 64);
    ctx.font = 'bold 39px monospace';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 30, 33, 960);
  });
  const sign = new T.Mesh(new T.PlaneGeometry(16, 0.95), material);
  sign.position.set(0, -5.26, 0.04);
  return sign;
}

/** 前厅断流时巨幕仍保留转播台的台标与开场图。 */
export function programCard() {
  return canvasMaterial(1024, 576, (ctx) => {
    const g = ctx.createLinearGradient(0, 0, 1024, 576);
    g.addColorStop(0, '#101c37');
    g.addColorStop(0.58, '#075b73');
    g.addColorStop(1, '#15a6ab');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 1024, 576);
    ctx.save();
    ctx.translate(820, 280);
    ctx.rotate(-0.27);
    for (let i = -16; i <= 16; i++) {
      ctx.strokeStyle = i % 4 === 0 ? '#bffff5' : '#48d8d1';
      ctx.lineWidth = i % 4 === 0 ? 3 : 1;
      ctx.beginPath();
      ctx.ellipse(
        i * 5,
        i * 1.5,
        Math.sqrt(290 ** 2 - (i * 14) ** 2),
        76,
        i * 0.08,
        0,
        Math.PI * 2,
      );
      ctx.stroke();
    }
    ctx.restore();
    ctx.fillStyle = '#effffa';
    ctx.font = 'bold 33px Arial';
    ctx.fillText('ChronoAI', 54, 76);
    ctx.font = 'bold 99px Arial';
    ctx.fillText('KEYNOTE', 48, 305);
    ctx.font = '32px sans-serif';
    ctx.fillText('发 布 会', 57, 364);
    ctx.fillStyle = '#8af9e8';
    ctx.fillRect(56, 479, 85, 5);
    ctx.font = '22px monospace';
    ctx.fillText('SINGAPORE   /   MARINA BAY', 56, 534);
  });
}

function facade() {
  return canvasMaterial(128, 512, (ctx) => {
    ctx.fillStyle = '#18273c';
    ctx.fillRect(0, 0, 128, 512);
    for (let row = 0; row < 64; row++)
      for (let col = 0; col < 12; col++) {
        const value = Math.sin(row * 156.29 + col * 61.76) * 14625.391;
        const n = value - Math.floor(value);
        ctx.fillStyle =
          n > 0.95 ? '#ce9d7e' : n > 0.75 ? '#69889b' : n > 0.4 ? '#37475b' : '#273549';
        ctx.fillRect(3 + col * 10.5, row * 8, 7, 3);
      }
    ctx.fillStyle = '#7394a4';
    ctx.fillRect(1, 0, 2, 512);
    ctx.fillRect(121, 0, 2, 512);
  });
}

export function buildCity(city: T.Group) {
  const planes = airship(),
    copter = drone();
  const traffic: { object: T.Group; center: T.Vector3; i: number; ship: boolean }[] = [];
  const carriers = [
    [-375, 207, 80, 3.7],
    [275, 279, 54, 5.6],
    [360, 118, 190, 1.4],
    [-310, 315, -590, 2.2],
    [-55, 100, 285, 1.1],
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
  for (let i = 0; i < 23; i++) {
    const obj = copter.clone();
    const flock = Math.floor(i / 7),
      j = i % 7;
    obj.position.set(
      -235 + flock * 231 + j * 10,
      112 + flock * 25 + Math.abs(j - 3) * 5,
      180 + flock * 20 + (j % 3) * 8,
    );
    obj.scale.setScalar(1.35 + (i % 3) * 0.19);
    if (i >= 21) {
      obj.position.set(i === 21 ? 180 : -235, i === 21 ? 190 : 156, 498);
      obj.scale.setScalar(3.5);
      obj.rotation.z = i === 21 ? -0.22 : 0.18;
    }
    city.add(obj);
    traffic.push({ object: obj, center: obj.position.clone(), i, ship: false });
  }
  for (let i = 0; i < 4; i++) {
    const points = [
      [-580, 94, -205],
      [-270, 72, -145],
      [-58, 65, 92],
      [170, 55, 164],
      [540, 86, 15],
    ];
    city.add(
      flightLane(
        points.map(([x, y, z]) => new T.Vector3(x, y! + i * 2.1, z! + i * 7)),
        i % 2 === 0 ? ice : rose,
        0.38,
      ),
    );
  }
  // 巨幕后的环形天线设有分段发射阵列，弧段随转播缓慢扫过。
  const antenna = new T.Group();
  antenna.position.set(-86, 199, 54);
  antenna.rotation.set(-0.16, 0.18, -0.19);
  for (const [r, tube, color] of [
    [160, 2.3, '#38495f'],
    [153, 1.2, ice],
    [166, 0.8, rose],
  ] as const) {
    antenna.add(
      new T.Mesh(new T.TorusGeometry(r, tube, 6, 128), new T.MeshBasicMaterial({ color })),
    );
  }
  const segments = new T.Group();
  for (let i = 0; i < 12; i++) {
    const arc = new T.Mesh(
      new T.TorusGeometry(160, 3.4, 6, 12, 0.19),
      new T.MeshStandardMaterial({ color: i % 3 === 0 ? gold : '#acbecb' }),
    );
    arc.rotation.z = (i * Math.PI) / 6;
    segments.add(arc);
  }
  antenna.add(segments);
  city.add(antenna);
  const windows = facade();
  const geometry = new T.BoxGeometry(1, 1, 1),
    count = 44;
  const blocks = new T.InstancedMesh(geometry, windows, count * 2);
  const beacons = new T.InstancedMesh(geometry, new T.MeshBasicMaterial({ color: gold }), count);
  const pose = new T.Object3D();
  for (let i = 0; i < count; i++) {
    const a = i * 2.39996;
    const h = 55 + 140 * (0.5 + 0.5 * Math.sin(i * 31.3)) ** 2;
    const x = Math.cos(a) * (580 + (i % 4) * 155),
      z = -530 + Math.sin(a) * 230;
    pose.position.set(x, h / 2 - 60, z);
    pose.scale.set(21 + (i % 5) * 7, h, 23 + (i % 7) * 4);
    pose.updateMatrix();
    blocks.setMatrixAt(i, pose.matrix);
    pose.position.y = h * 1.09 - 60;
    pose.scale.multiply(new T.Vector3(0.64, 0.18, 0.6));
    pose.updateMatrix();
    blocks.setMatrixAt(i + count, pose.matrix);
    pose.position.y = h * 1.18 - 56;
    pose.scale.set(1.1, 6, 1.1);
    pose.updateMatrix();
    beacons.setMatrixAt(i, pose.matrix);
  }
  city.add(blocks, beacons);
  return (t: number) => {
    segments.rotation.z = t * 0.065;
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
