import * as THREE from 'three';
import type { GeographicMap } from '../core/environment';
import type { Tile } from './geography';
import { skyRadiance } from './skyRadiance';
import reflectanceUrl from '../assets/geography/reservoir-reflectance.png';

type Coverage = NonNullable<GeographicMap['offshore']>;
type Uniforms = OffshoreWater['uniforms'];
export type OffshorePatch = Uniforms & { oceanRect: THREE.IUniform<THREE.Vector4> };

/** The mask follows the geographic tile UVs even when a lower-resolution photograph is displayed. */
export class OffshoreWater {
  readonly uniforms = {
    oceanMask: { value: null as THREE.Texture | null },
    oceanSky: { value: null as THREE.Texture | null },
    oceanReflectance: { value: null as THREE.Texture | null },
    oceanReady: { value: 0 },
    oceanRoughness: { value: 0 },
  };
  private disposed = false;

  constructor(
    private readonly config: Coverage,
    load: (hash: string) => Promise<THREE.Texture>,
  ) {
    this.uniforms.oceanRoughness.value = Math.cbrt(config.rmsSlope / 6);
    const table = new THREE.TextureLoader().loadAsync(reflectanceUrl).then((texture) => {
      if (this.disposed) {
        texture.dispose();
        return;
      }
      texture.flipY = false;
      texture.generateMipmaps = false;
      texture.minFilter = THREE.LinearFilter;
      this.uniforms.oceanReflectance.value = texture;
    });
    const mask = load(config.texture).then((source) => {
      if (this.disposed) return;
      const texture = source.clone();
      texture.colorSpace = THREE.NoColorSpace;
      texture.flipY = true;
      texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.needsUpdate = true;
      this.uniforms.oceanMask.value = texture;
    });
    void Promise.all([table, mask])
      .then(() => {
        if (!this.disposed) this.uniforms.oceanReady.value = 1;
      })
      .catch(() => {
        /* Keep the geographic imagery while either resource is unavailable. */
      });
  }

  setSky(sky: THREE.Texture | null) {
    this.uniforms.oceanSky.value = sky && (skyRadiance.get(sky) ?? sky);
  }

  patch(tile: Tile): OffshorePatch | undefined {
    const [left, top, right, bottom] = this.config.rect;
    const size = 1 / 2 ** tile.z;
    const x = tile.x * size,
      y = tile.y * size;
    if (x >= right || y >= bottom || x + size <= left || y + size <= top) return;
    const w = right - left,
      h = bottom - top;
    return {
      ...this.uniforms,
      oceanRect: {
        value: new THREE.Vector4((x - left) / w, 1 - (y - top) / h, size / w, size / h),
      },
    };
  }

  dispose() {
    this.disposed = true;
    this.uniforms.oceanMask.value?.dispose();
    this.uniforms.oceanReflectance.value?.dispose();
  }
}

export const offshoreLight = /* glsl */ `
  if (oceanReady > 0.0 && path > 1800.0 && all(greaterThanEqual(oceanUv,vec2(0))) &&
      all(lessThanEqual(oceanUv,vec2(1)))) {
    float coverage = texture2D(oceanMask,oceanUv).r * smoothstep(1800.0,4000.0,path) * groundAirStrength;
    if (coverage > 0.0) {
      float cosine = clamp(-ray.y,0.0,1.0);
      vec2 size = vec2(textureSize(oceanReflectance,0));
      vec2 entry = vec2(sqrt(cosine),oceanRoughness);
      float fresnel = texture2D(oceanReflectance,(entry*(size-1.0)+0.5)/size).r;
      vec3 reflected = normalize(vec3(ray.x,max(0.025,cosine),ray.z));
      vec3 sky = textureLod(oceanSky,equirectUv(reflected),2.0).rgb;
      // Same linear deep-water reflectance as the detailed water surface (#325553).
      vec3 sea = mix(vec3(0.03190,0.09084,0.08650),sky,fresnel);
      #ifdef USE_MAP
        // Keep wakes and vessels in the image without reintroducing broad photographic colour casts.
        vec3 localMean = texture2D(map,vMapUv,3.0).rgb;
        sea += clamp(diffuseColor.rgb-localMean,vec3(-0.035),vec3(0.18));
      #endif
      outgoingLight = mix(outgoingLight,sea,coverage);
    }
  }`;
