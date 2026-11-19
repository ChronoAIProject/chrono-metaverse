import * as THREE from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import dracoWrapper from 'three/examples/jsm/libs/draco/gltf/draco_wasm_wrapper.js?url';
import dracoWasm from 'three/examples/jsm/libs/draco/gltf/draco_decoder.wasm?url';

export function createDracoLoader() {
  const decoderManager = new THREE.LoadingManager();
  decoderManager.setURLModifier((url) => {
    if (url.endsWith('draco_wasm_wrapper.js')) return dracoWrapper;
    if (url.endsWith('draco_decoder.wasm')) return dracoWasm;
    throw new Error('未知的三维解码资源');
  });
  return new DRACOLoader(decoderManager)
    .setDecoderPath('/__decoder__/')
    .setDecoderConfig({ type: 'wasm' })
    .setWorkerLimit(2);
}
