import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { GeographicMap } from './geographicMap';

vi.mock('./mapTileCache', () => ({ mapTileImage: () => new Promise(() => undefined) }));

const config = {
  latitude: 35,
  longitude: 139,
  origin: [0, -60, 0] as const,
  heading: 28,
  sources: [
    {
      urlTemplate: 'https://tiles.example.org/{z}/{x}/{y}',
      page: 'https://tiles.example.org/',
      attribution: '测试影像',
      minZoom: 0,
      maxZoom: 18,
    },
  ],
};

describe('地图按镜头选择精度', () => {
  it('室内距离能细分到建筑尺度，其他半球被裁掉不会提前停止细分', () => {
    const host = document.createElement('div');
    Object.defineProperty(host, 'clientHeight', { value: 900 });
    const map = new GeographicMap(config, host);
    const camera = new THREE.PerspectiveCamera(50, 1.6, 0.02, 20000000);
    camera.position.set(15, 10, 25);
    camera.lookAt(0, -60, 0);
    map.update(camera, true);
    expect(map.getStats().zoom).toBeGreaterThanOrEqual(17);
    expect(map.getStats().pending).toBeLessThan(300);
    expect(map.group.children.length).toBeLessThanOrEqual(98);
    map.dispose();
    expect(host.querySelector('.viewer__map-credit')).toBeNull();
  });

  it('地球尺度会降低精度，地图来源署名是安全的链接和纯文本', () => {
    const host = document.createElement('div');
    Object.defineProperty(host, 'clientHeight', { value: 900 });
    const map = new GeographicMap(config, host);
    const camera = new THREE.PerspectiveCamera(50, 1.6, 0.02, 100000000);
    camera.position.set(0, 20000000, 10000000);
    camera.lookAt(map.reference.center);
    map.update(camera, true);
    expect(map.getStats().zoom).toBeLessThan(7);
    expect(host.querySelector('a')?.textContent).toBe('测试影像');
    expect(host.querySelector('a')?.rel).toBe('noopener noreferrer');
    map.dispose();
  });

  it('局部高清源不让其他半球请求超出全球来源上限的瓦片', () => {
    const host = document.createElement('div');
    Object.defineProperty(host, 'clientHeight', { value: 900 });
    const map = new GeographicMap(
      {
        ...config,
        sources: [
          { ...config.sources[0]!, minZoom: 12, bounds: [-123, 36, -121, 38] },
          { ...config.sources[0]!, maxZoom: 5 },
        ],
      },
      host,
    );
    const camera = new THREE.PerspectiveCamera(50, 1.6, 0.02, 20000000);
    camera.position.set(15, 10, 25);
    camera.lookAt(0, -60, 0);
    map.update(camera, true);
    expect(map.getStats().zoom).toBeLessThanOrEqual(5);
    map.dispose();
  });
});
