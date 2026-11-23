import { readFileSync } from 'node:fs';
import { MeshoptSimplifier } from '../../../web/node_modules/meshoptimizer/meshopt_simplifier.js';

// Preserve bark texture seams and the important changes in trunk direction.
const { faces, position, attributes } = JSON.parse(readFileSync(0, 'utf8'));
await MeshoptSimplifier.ready;
const [indices] = MeshoptSimplifier.simplifyWithAttributes(
  Uint32Array.from(faces), Float32Array.from(position), 3, Float32Array.from(attributes), 5,
  [0.10, 0.10, 0.10, 0.015, 0.015], null, 420 * 3, 0.055, ['Permissive'],
);
process.stdout.write(JSON.stringify(Array.from(indices)));
