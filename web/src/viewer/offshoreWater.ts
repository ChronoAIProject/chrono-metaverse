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
    oceanSkyLod: { value: 0 },
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
    const radiance = sky && (skyRadiance.get(sky) ?? sky);
    this.uniforms.oceanSky.value = radiance;
    // A facet tilt changes the reflected angle by twice the tilt. Convert this
    // angular width to texels in the latitude direction of the panorama.
    const height = radiance?.height ?? 1;
    this.uniforms.oceanSkyLod.value = Math.log2(
      Math.max(1, (2 * Math.atan(this.config.rmsSlope) * height) / Math.PI),
    );
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

export interface MemberOcean {
  readonly spaceId: string;
  readonly water: OffshoreWater;
}

export const offshoreSamplers = /* glsl */ `
  uniform sampler2D oceanMask, oceanSky, oceanReflectance;
  uniform float oceanReady, oceanRoughness, oceanSkyLod;
`;

export const offshoreRadiance = /* glsl */ `
  vec3 openSeaRadiance(vec3 ray, vec3 body) {
    float cosine = clamp(-ray.y,0.0,1.0);
    vec2 size = vec2(textureSize(oceanReflectance,0));
    vec2 entry = vec2(sqrt(cosine),oceanRoughness);
    vec3 lookup = texture2D(oceanReflectance,(entry*(size-1.0)+0.5)/size).rgb;
    float fresnel = lookup.r;
    // Visible wave faces reflect sky above the geometric horizon at grazing angles.
    // The LUT stores the displacement in units of pi, directly in panorama V.
    float elevationShift = (dot(lookup.gb,vec2(65280.0,255.0))-32768.0)/32767.0;
    vec2 skyUv = equirectUv(vec3(ray.x,cosine,ray.z));
    skyUv.y = clamp(skyUv.y + elevationShift,0.5,1.0);
    vec3 sky = textureLod(oceanSky,skyUv,oceanSkyLod).rgb;
    return mix(body,sky,fresnel);
  }
`;

export const offshoreLight = /* glsl */ `
  if (oceanReady > 0.0 && path > 1800.0 && all(greaterThanEqual(oceanUv,vec2(0))) &&
      all(lessThanEqual(oceanUv,vec2(1)))) {
    float coverage = texture2D(oceanMask,oceanUv).r * smoothstep(1800.0,4000.0,path) * groundAirStrength;
    if (coverage > 0.0) {
      vec3 sea = openSeaRadiance(ray, vec3(0.03190,0.09084,0.08650));
      #ifdef USE_MAP
        // Transfer the photograph's local luminance contrast to the reflected sky.
        // At grazing angles an additive residual loses dark hulls against the bright sea.
        const vec3 luma = vec3(0.2126,0.7152,0.0722);
        float localMean = dot(texture2D(map,vMapUv,3.0).rgb,luma);
        float detail = dot(diffuseColor.rgb,luma) - localMean;
        sea *= clamp(1.0 + detail / max(localMean,0.015),0.55,1.55);
      #endif
      outgoingLight = mix(outgoingLight,sea,coverage);
    }
  }`;
