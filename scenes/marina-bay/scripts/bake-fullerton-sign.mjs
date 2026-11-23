// Register the waterfront lettering on the surveyed entrance canopy.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  Vector3,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Scene,
  ExtrudeGeometry,
  BoxGeometry,
} from "../../../web/node_modules/three/build/three.module.js";
import { FontLoader } from "../../../web/node_modules/three/examples/jsm/loaders/FontLoader.js";
import { GLTFExporter } from "../../../web/node_modules/three/examples/jsm/exporters/GLTFExporter.js";
import {
  mergeGeometries,
  mergeVertices,
} from "../../../web/node_modules/three/examples/jsm/utils/BufferGeometryUtils.js";

const root = new URL("../", import.meta.url);
const read = (file) => JSON.parse(readFileSync(new URL(file, root), "utf8"));
const { quay } = read("context.json");
const origin = new Vector3(...quay.start);
const along = new Vector3(...quay.end).sub(origin);
along.y = 0;
along.normalize();
const up = new Vector3(0, 1, 0);
const waterward = along.clone().cross(up);
const fontData = JSON.parse(
  readFileSync(
    new URL(
      "../../../web/node_modules/three/examples/fonts/gentilis_regular.typeface.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const font = new FontLoader().parse(fontData);

// Outside edges in the front photograph crop. Capital O and F rise above the smaller capitals.
// Scale is estimated against the canopy's 18.05 m surveyed leading edge.
const glyphs = [
  ["O", 30, 121, 81],
  ["N", 132, 193, 63],
  ["E", 204, 246, 62],
  ["F", 269, 314, 81],
  ["U", 322, 389, 64],
  ["L", 399, 443, 62],
  ["L", 449, 491, 62],
  ["E", 498, 539, 62],
  ["R", 548, 602, 63],
  ["T", 609, 651, 62],
  ["O", 657, 733, 66],
  ["N", 743, 805, 63],
];
const metresPerPixel = 10.02 / (805 - 30);
const parts = [];
for (const [letter, left, right, height] of glyphs) {
  const solid = new ExtrudeGeometry(font.generateShapes(letter, 1), {
    depth: 0.065,
    bevelEnabled: false,
    curveSegments: 2,
  });
  solid.computeBoundingBox();
  const bounds = solid.boundingBox;
  solid.translate(-bounds.min.x, -bounds.min.y, 0);
  solid.scale(
    (metresPerPixel * (right - left)) / (bounds.max.x - bounds.min.x),
    (metresPerPixel * height) / (bounds.max.y - bounds.min.y),
    1,
  );
  solid.translate((left - 30) * metresPerPixel, 0.035, 0);
  parts.push(solid);
}
// Thin continuous mounting rail on the canopy, inset behind the letter faces.
const rail = new BoxGeometry(10.02, 0.039, 0.075).toNonIndexed();
rail.translate(5.01, 0.0195, 0.003);
parts.push(rail);
const geometry = mergeVertices(mergeGeometries(parts));
geometry.deleteAttribute("uv");
const orientation = new Matrix4().makeBasis(along, up, waterward);
// OneMap roof corners at stations 92.53 and 110.58 m, canopy top 9.73 m above datum.
orientation.setPosition(
  origin
    .clone()
    .addScaledVector(along, 96.52)
    .addScaledVector(waterward, -13.28)
    .addScaledVector(up, 9.73),
);
geometry.applyMatrix4(orientation);
geometry.computeBoundingBox();
const bounds = geometry.boundingBox.clone();
const center = bounds.getCenter(new Vector3());
center.y = bounds.min.y;
geometry.translate(-center.x, -center.y, -center.z);
const material = new MeshStandardMaterial({
  name: "Champagne metal entrance lettering",
  color: 0xe4ce9e,
  roughness: 0.44,
  metalness: 0.24,
});
const scene = new Scene();
scene.add(new Mesh(geometry, material));
// GLTFExporter reads the BIN and final GLB Blobs with the browser FileReader interface.
globalThis.FileReader ??= class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((result) => {
      this.result = result;
      this.onloadend?.();
    });
  }
};
const binary = Buffer.from(
  await new GLTFExporter().parseAsync(scene, { binary: true }),
);
const hash = createHash("sha256").update(binary).digest("hex");
writeFileSync(new URL("assets/" + hash + ".glb", root), binary);
const records = read("build/streetscape.json");
const entry = {
  entityId: "bay.fullerton-entrance-lettering",
  regionId: "marina-bay-exterior",
  kind: "structure",
  layer: "ext",
  label: "One Fullerton · 海湾入口立体字",
  assetHash: hash,
  bounds: { min: bounds.min.toArray(), max: bounds.max.toArray() },
  material: { shading: "albedo" },
  props: {
    background: true,
    建筑定位: "Map Data © Singapore Land Authority / OneMap · 临水入口雨棚",
    实景参考:
      "https://commons.wikimedia.org/wiki/File:Singapore_-_panoramio_(109).jpg",
    字标: "按 2014 年实景照片估读十二个字母的间距、宽高和金属色；Gentilis 字形近似，厚度及安装进深为估值。",
    字形来源:
      "Gentilis · Copyright 2003–2008 SIL International · SIL Open Font License 1.1",
    backgroundView: {
      focus: bounds.getCenter(new Vector3()).toArray(),
      maxDistance: 320,
    },
  },
};
const index = records.findIndex((e) => e.entityId === entry.entityId);
if (index < 0) records.push(entry);
else records[index] = entry;
writeFileSync(
  new URL("build/streetscape.json", root),
  JSON.stringify(records, null, 2) + "\n",
);
console.log(hash, binary.length, geometry.index.count / 3);
