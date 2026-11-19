import * as T from 'three';
import { projectionMaterial } from './projection';
import { createDracoLoader } from '../draco';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import stationUrl from '../../assets/broadcast/station.glb?url';
import launchUrl from '../../assets/broadcast/launch.glb?url';

/** 从真实设备的各部件表面采样截线，保留太阳翼和舱体的遮挡。 */
export function loadHardware(kind: 'station' | 'launch', parent: T.Group, signal: AbortSignal) {
  const url = kind === 'station' ? stationUrl : launchUrl;
  const loader = new GLTFLoader();
  const decoder = kind === 'station' ? createDracoLoader() : null;
  if (decoder) loader.setDRACOLoader(decoder);
  void loader
    .loadAsync(url)
    .then(({ scene }) => {
      const box = new T.Box3().setFromObject(scene);
      const size = box.getSize(new T.Vector3());
      const scale = (kind === 'station' ? 0.56 : 0.17) / Math.max(size.x, size.y, size.z);
      const centre = box.getCenter(new T.Vector3());
      scene.scale.setScalar(scale);
      scene.position.copy(centre).multiplyScalar(-scale);
      const originalMaterials = new Set<T.Material>();
      scene.traverse((o) => {
        if (!(o instanceof T.Mesh)) return;
        for (const m of Array.isArray(o.material) ? o.material : [o.material])
          originalMaterials.add(m);
        o.geometry.computeBoundingBox();
        const extent = o.geometry.boundingBox!.getSize(new T.Vector3());
        const pitch = Math.max(extent.x, extent.y, extent.z, 0.001) / 30;
        o.material = projectionMaterial(pitch, kind === 'station' ? 0.65 : 0.82);
      });
      const dispose = () => {
        scene.removeFromParent();
        const resources = new Set<T.BufferGeometry | T.Material | T.Texture>();
        for (const mat of originalMaterials) {
          resources.add(mat);
          for (const v of Object.values(mat)) if (v instanceof T.Texture) resources.add(v);
        }
        scene.traverse((o) => {
          if (!(o instanceof T.Mesh)) return;
          resources.add(o.geometry);
          for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
            resources.add(m);
            for (const v of Object.values(m)) if (v instanceof T.Texture) resources.add(v);
          }
        });
        for (const r of resources) r.dispose();
      };
      if (signal.aborted) dispose();
      else {
        parent.add(scene);
        signal.addEventListener('abort', dispose, { once: true });
      }
    })
    .catch((error) => {
      if (!signal.aborted) console.warn('轨道设备加载失败', kind, error);
    })
    .finally(() => decoder?.dispose());
}
