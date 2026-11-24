"""Place the surveyed promenade palms using the royal-palm meshes from 0 A.D."""

import argparse
import hashlib
import json
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals

from fullerton_shrubs import combined
from scanned_canopy import ROOT, write_tree_asset

CREDIT = ("Royal palm meshes and textures adapted from 0 A.D., Wildfire Games "
          "(https://wildfiregames.com/), CC BY-SA 3.0 "
          "(https://creativecommons.org/licenses/by-sa/3.0/). "
          "Scaled, rotated, tinted and batched for the Sands waterfront.")


def read_palm(path):
    """Read the position, shading normals and leaf UVs in a pinned COLLADA variant."""
    root = ET.parse(path).getroot()
    mesh = root.find(".//{*}geometry/{*}mesh")
    arrays = {}
    for source in mesh.findall("{*}source"):
        stride = int(source.find(".//{*}accessor").get("stride"))
        arrays[source.get("id")] = np.fromstring(source.findtext("{*}float_array"), sep=" ").reshape(-1, stride)
    triangles = mesh.find("{*}triangles")
    inputs = {field.get("semantic"): field for field in triangles.findall("{*}input")}
    width = max(int(field.get("offset")) for field in inputs.values()) + 1
    indices = np.fromstring(triangles.findtext("{*}p"), sep=" ", dtype=np.int32).reshape(-1, width)
    vertices, faces = np.unique(indices, axis=0, return_inverse=True)
    position_source = mesh.find("{*}vertices/{*}input[@semantic='POSITION']").get("source")[1:]
    positions = arrays[position_source][vertices[:, int(inputs["VERTEX"].get("offset"))]]
    normals = arrays[inputs["NORMAL"].get("source")[1:]][vertices[:, int(inputs["NORMAL"].get("offset"))]]
    uv = arrays[inputs["TEXCOORD"].get("source")[1:]][vertices[:, int(inputs["TEXCOORD"].get("offset"))]]
    node = np.fromstring(root.findtext(".//{*}visual_scene/{*}node/{*}matrix"), sep=" ").reshape(4, 4)
    # 0 A.D.'s Z-up COLLADA exports have different node rotations across the variants.
    to_y_up = np.array([[1, 0, 0], [0, 0, 1], [0, -1, 0]])
    transform = to_y_up @ node[:3, :3]
    positions = positions @ transform.T + to_y_up @ node[:3, 3]
    normals = normals @ np.linalg.inv(transform)
    normals /= np.maximum(1e-8, np.linalg.norm(normals, axis=1, keepdims=True))
    base = positions[positions[:, 1] <= positions[:, 1].min() + .15]
    foot = (base.min(0) + base.max(0)) / 2
    foot[1] = positions[:, 1].min()
    return positions - foot, normals, uv, faces.reshape(-1, 3)


def palm_stand(folder, trees):
    reference = json.loads((ROOT / "references/sands-waterfront-palms.json").read_text())
    for name, digest in reference["sourceHashes"].items():
        if hashlib.sha256((folder / name).read_bytes()).hexdigest() != digest:
            raise ValueError(f"Unexpected 0 A.D. palm resource: {name}")
    with Image.open(folder / "palm_royal.png") as file:
        color = file.convert("RGBA")
    with Image.open(folder / "palm_areca_norm.png") as file:
        normal = file.convert("RGB")
    material = PBRMaterial(name="Sands promenade palm fronds and bark", baseColorTexture=color,
                           normalTexture=normal, baseColorFactor=[125, 176, 168, 255], alphaMode="MASK", alphaCutoff=.38, doubleSided=True,
                           metallicFactor=0, roughnessFactor=.93)
    sources = {variant: read_palm(folder / f"tree_roystonea_regia_{variant}.dae")
               for variant in {tree["variant"] for tree in trees}}
    meshes, colours = [], []
    for tree in trees:
        xyz, n, uv, faces = sources[tree["variant"]]
        crown_width = np.sqrt(np.prod(np.ptp(xyz[:, [0, 2]], axis=0)))
        width = tree["crownDiameterMetres"] / crown_width
        height = tree["estimatedHeightMetres"] / np.ptp(xyz[:, 1])
        angle = np.radians(tree["yawDegrees"])
        rotation = trimesh.transformations.rotation_matrix(angle, [0, 1, 0])[:3, :3]
        transform = rotation @ np.diag([width, height, width])
        x, z = tree["localXZ"]
        if "trunkWidthFactor" in tree:
            # Taper into the crown without opening a seam at the leaf attachments.
            fraction = xyz[:, 1] / np.ptp(xyz[:, 1])
            blend = np.clip((fraction-.62)/.13, 0, 1)
            xyz = xyz.copy()
            xyz[:, [0,2]] *= (tree["trunkWidthFactor"]*(1-blend) + blend)[:, None]
        points = xyz @ transform.T + [x, tree["groundY"] - .025, z]
        normals = n @ np.linalg.inv(transform)
        normals /= np.maximum(1e-8, np.linalg.norm(normals, axis=1, keepdims=True))
        mesh = trimesh.Trimesh(vertices=points, vertex_normals=normals, faces=faces,
                               visual=TextureVisuals(uv=uv, material=material), process=False)
        meshes.append(mesh)
        colours.append(np.tile([*tree["linearTint"], 255], (len(points), 1)))
    stand = combined(meshes)
    stand.visual.vertex_attributes["color"] = np.vstack(colours).astype(np.uint8)
    return stand


def bake(folder):
    reference = json.loads((ROOT / "references/sands-waterfront-palms.json").read_text())
    stand = palm_stand(folder, reference["trees"])
    scene = trimesh.Scene()
    scene.add_geometry(stand, geom_name=stand.visual.material.name)

    digest, bounds = write_tree_asset(scene, packing_options=("-si", "0.48", "-se", "0.0005", "-slb"),
                                     copyright=CREDIT)
    row = dict(entityId="bay.sands-waterfront-palms", regionId="marina-bay-exterior", layer="ext",
               kind="structure", label="金沙滨水步道 · 棕榈树列", assetHash=digest, bounds=bounds,
               material={"shading": "albedo"}, props={"background": True, "surfaceRole": "landscape",
                   "树木依据": "树冠按 OneMap 正射影像定位，树高按鱼尾狮公园实拍估读。树种未确认，借用王棕的树干和羽状叶片。",
                   "树形素材": CREDIT, "素材来源": reference["source"]})
    path = ROOT / "build/streetscape.json"
    records = {e["entityId"]: e for e in json.loads(path.read_text())}
    records[row["entityId"]] = row
    path.write_text(json.dumps(list(records.values()), ensure_ascii=False, indent=2) + "\n")
    print(digest)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("folder", type=Path, help="0 A.D. royal palm DAE files and diffuse and normal PNGs")
    bake(parser.parse_args().folder)
