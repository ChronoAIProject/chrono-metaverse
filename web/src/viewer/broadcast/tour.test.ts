import { expect, it, vi } from 'vitest';
import * as T from 'three';
import { readBroadcastTour } from '../../core/broadcastTour';
import { LiveScreen } from '../liveScreen';
import { BroadcastVenue } from './venue';
import { placeEquipment } from './city';
import fixture from '../../../e2e/fixtures/observatory-tour.json';

it('机位和距离可独立排序，拒绝重复机位、悬空引用和无效的设备参数', () => {
  const fresh = () => readBroadcastTour(structuredClone(fixture))!;
  const tour = fresh();
  expect(tour.order).toEqual(['studio', 'zenith', 'pier']);
  expect(readBroadcastTour({ ...tour, order: ['missing'] })).toBeNull();
  expect(readBroadcastTour({ ...tour, stops: [...tour.stops, tour.stops[0]] })).toBeNull();
  const invalid = fresh();
  invalid.stops[1]!.equipment![0]!.motion!.period = 0;
  expect(readBroadcastTour(invalid)).toBeNull();
  const overlapping = fresh();
  overlapping.stops[1]!.minDistance = 0;
  expect(readBroadcastTour(overlapping)).toBeNull();
});

it('按配置布置设备，多个实例沿同一航线错相飞行', () => {
  const stop = readBroadcastTour(fixture)!.stops[1]!;
  const root = new T.Group();
  const update = placeEquipment(root, stop.equipment!, vi.fn());
  expect(root.children).toHaveLength(3);
  update(0);
  const [first, second] = root.children;
  expect(first!.position.toArray()).toEqual([18, 29, 21]);
  expect(first!.scale.toArray()).toEqual([0.5, 0.5, 0.5]);
  expect(second!.position.x).toBeCloseTo(18 + 30 * Math.sin((2 * Math.PI) / 3));
  update(37 / 4);
  expect(first!.position.x).toBeCloseTo(48);
});

it('按成员变换放置相机，手动拉远选择距离带，回到室内恢复同一个屏幕和剖切', () => {
  const tour = readBroadcastTour(structuredClone(fixture))!;
  tour.stops = tour.stops.slice(0, 2);
  tour.stops[1]!.equipment = [];
  const clipping = [new T.Plane()];
  const material = new T.MeshBasicMaterial({ clippingPlanes: clipping });
  const player = new LiveScreen(material, clipping);
  const home = new T.Group().add(player);
  const source = { kind: 'youtube' as const, url: 'https://example.org' };
  const change = vi.fn();
  const venue = new BroadcastVenue(
    {
      tour,
      map: undefined,
      source,
      mirror: { entityId: tour.mirror, kind: 'object', layer: 'ext' },
      screen: { source, width: 16, height: 9, matrix: new T.Matrix4() },
      placement: { offset: [0, 0, 0], rotation: 90 },
    },
    player,
    change,
    () => undefined,
  );
  const camera = new T.PerspectiveCamera();
  const pose = venue.camera('pier', 2)!;
  expect(pose.to.x).toBeCloseTo(171);
  expect(pose.to.z).toBeCloseTo(50);
  camera.position.copy(pose.to);
  venue.update(camera, null);
  expect(change.mock.lastCall![0].active).toBe('pier');
  expect(material.clippingPlanes).toBeNull();
  expect(player.parent).not.toBe(home);
  player.updateWorldMatrix(true, false);
  const center = new T.Vector3().setFromMatrixPosition(player.matrixWorld);
  expect(center.x).toBeCloseTo(41.11);
  expect(center.y).toBeCloseTo(22);
  expect(center.z).toBeCloseTo(42);
  venue.update(camera, 'studio');
  expect(player.parent).toBe(home);
  expect(material.clippingPlanes).toBe(clipping);
  expect(player.matrix.equals(new T.Matrix4())).toBe(true);
  venue.dispose();
});
