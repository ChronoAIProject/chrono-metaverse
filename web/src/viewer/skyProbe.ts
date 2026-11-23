import * as THREE from 'three';

/** Rotate radiance coefficients in panorama coordinates into the scene's world coordinates. */
export function skyProbe(coefficients: readonly number[], yaw: number, intensity: number) {
  const source = new THREE.SphericalHarmonics3().fromArray(coefficients);
  if (yaw % 360 === 0) return new THREE.LightProbe(source, intensity);

  // The product of two order-two harmonics has degree at most four. The
  // 14-point Lebedev rule integrates it exactly, including the quadratic band.
  const angle = THREE.MathUtils.degToRad(-yaw);
  const axis = new THREE.Vector3(0, 1, 0);
  const rotated = new THREE.SphericalHarmonics3();
  const direction = new THREE.Vector3();
  const sourceDirection = new THREE.Vector3();
  const radiance = new THREE.Vector3();
  const basis: number[] = [];
  function project(x: number, y: number, z: number, weight: number) {
    direction.set(x, y, z).normalize();
    sourceDirection.copy(direction).applyAxisAngle(axis, angle);
    source.getAt(sourceDirection, radiance);
    THREE.SphericalHarmonics3.getBasisAt(direction, basis);
    rotated.coefficients.forEach((c, i) =>
      c.addScaledVector(radiance, 4 * Math.PI * weight * basis[i]!),
    );
  }
  for (const sign of [-1, 1]) {
    project(sign, 0, 0, 1 / 15);
    project(0, sign, 0, 1 / 15);
    project(0, 0, sign, 1 / 15);
    for (const y of [-1, 1]) for (const z of [-1, 1]) project(sign, y, z, 3 / 40);
  }
  return new THREE.LightProbe(rotated, intensity);
}
