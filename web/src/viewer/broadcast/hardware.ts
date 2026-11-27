import * as T from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { projectionMaterial } from './projection';
import { retryTransientRead } from '../../core/api/readRetry';
import { createDracoLoader } from '../draco';
import type { BroadcastModel } from '../../core/broadcastTour';

const library = import.meta.glob<string>('../../assets/broadcast/*.glb', {
  eager: true,
  query: '?url',
  import: 'default',
});

type LoadEntity = (id: string) => Promise<ArrayBuffer> | undefined;

/** 同一巡演的设备实例共用解析后的几何与全息材质。模型实体由当前成员的资源接口读取。 */
export class EquipmentModels {
  private readonly models = new Map<string, Promise<T.Group>>();
  private readonly resources = new Set<T.BufferGeometry | T.Material | T.Texture>();
  private readonly instances: T.Object3D[] = [];
  private readonly abort = new AbortController();
  private disposed = false;

  constructor(private readonly loadEntity: LoadEntity) {}

  attach = (ref: BroadcastModel, holder: T.Group) => {
    const key = JSON.stringify(ref);
    let model = this.models.get(key);
    if (!model) {
      model = this.load(ref);
      this.models.set(key, model);
    }
    void model
      .then((template) => {
        if (this.disposed) return;
        const instance = template.clone();
        holder.add(instance);
        this.instances.push(instance);
      })
      .catch((error) => {
        if (!this.disposed) console.warn('巡演设备加载失败', ref, error);
      });
  };

  private async load(ref: BroadcastModel) {
    const decoder = createDracoLoader();
    const loader = new GLTFLoader().setDRACOLoader(decoder);
    try {
      let model;
      if (typeof ref === 'string') {
        const url = library[`../../assets/broadcast/${ref}.glb`];
        if (!url) throw new Error('设备资源库中没有这个模型');
        try {
          model = await loader.loadAsync(url);
        } catch (error) {
          const response = error instanceof Error && 'response' in error ? error.response : null;
          if (
            !(response instanceof Response) ||
            !(await retryTransientRead(response, this.abort.signal))
          ) {
            throw error;
          }
          model = await loader.loadAsync(url);
        }
      } else {
        const bytes = await this.loadEntity(ref.entity);
        if (!bytes) throw new Error('当前空间中缺少设备模型实体');
        model = await loader.parseAsync(bytes, '');
      }
      const { scene } = model;
      const projection = scene.userData.projection;
      if (projection?.fitUnit) {
        const bounds = new T.Box3().setFromObject(scene);
        const size = bounds.getSize(new T.Vector3());
        const scale = 1 / Math.max(size.x, size.y, size.z, Number.EPSILON);
        scene.scale.setScalar(scale);
        scene.position.copy(bounds.getCenter(new T.Vector3())).multiplyScalar(-scale);
      }
      scene.traverse((obj) => {
        if (!(obj instanceof T.Mesh)) return;
        this.resources.add(obj.geometry);
        obj.geometry.computeBoundingBox();
        const extent = obj.geometry.boundingBox!.getSize(new T.Vector3());
        const pitch = Math.max(extent.x, extent.y, extent.z, 0.001) / 30;
        const project = (original: T.Material) => {
          this.resources.add(original);
          for (const value of Object.values(original))
            if (value instanceof T.Texture) this.resources.add(value);
          const style = original.userData.projection ?? projection;
          const material = projectionMaterial(
            style?.pitch ?? pitch,
            style?.intensity ?? 0.7,
            style?.tint,
          );
          this.resources.add(material);
          return material;
        };
        obj.material = Array.isArray(obj.material)
          ? obj.material.map(project)
          : project(obj.material);
      });
      if (this.disposed) this.release();
      return scene;
    } finally {
      decoder.dispose();
    }
  }
  private release() {
    for (const resource of this.resources) resource.dispose();
    this.resources.clear();
  }
  dispose() {
    this.disposed = true;
    this.abort.abort();
    for (const instance of this.instances) instance.removeFromParent();
    this.instances.length = 0;
    this.models.clear();
    this.release();
  }
}
