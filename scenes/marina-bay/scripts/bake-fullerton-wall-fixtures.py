"""Reconstruct the round fittings visible on the One Fullerton seawall in 2014."""
import hashlib
import json
from pathlib import Path

import numpy as np
import trimesh
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals

ROOT = Path(__file__).resolve().parents[1]
# Centres traced along the water-facing course, rows 2119–2130 in the 4288 × 2848 image.
PHOTO_COLUMNS = [43, 140, 236, 333, 432, 527, 623, 719, 815, 910, 1003, 1096, 1190, 1284,
                1379, 1472, 1566, 1660, 1755, 1849, 1941, 2034, 2128, 2221, 2314, 2407,
                2502, 2595, 2690, 2783, 2875, 2969, 3063, 3159, 3253, 3348, 3442, 3536,
                3629, 3723, 3819, 3918, 4012, 4111, 4207]


def bake():
    reference = json.loads((ROOT/"references/fullerton-entrance-lamps.json").read_text())
    paving = json.loads((ROOT/"references/fullerton-entrance-paving.json").read_text())
    lookup = {(int(i), int(j)): (x, s) for x, s, i, j in paving["centres"]}
    survey = np.asarray(reference["inlays"])
    measured = np.array([lookup[tuple(ij)] for ij in survey[:, :2]])
    # Fit photograph columns to metres along/across the wall. The controls are
    # on the entrance plaza, so absolute station is estimated beyond that area.
    design = np.column_stack((measured, np.ones(len(measured))))
    dx, ds, offset = np.linalg.lstsq(design, survey[:, 2], rcond=None)[0]
    height = .337
    wall_x = -.09
    stations = (np.array(PHOTO_COLUMNS) - offset - dx * wall_x) / ds
    quay = json.loads((ROOT/"context.json").read_text())["quay"]
    start, end = np.array(quay["start"]), np.array(quay["end"])
    delta = end - start
    length = np.linalg.norm(delta[[0, 2]])
    along = np.array([delta[0], 0, delta[2]]) / length
    inland = np.cross([0, 1, 0], along)
    up = np.array([0., 1., 0.])
    basis = np.column_stack((along, up, np.cross(along, up)))
    if stations.min() < 0 or stations.max() > length:
        raise ValueError("A photographed wall fitting lies outside the registered quay")

    # The source resolves a dark circular rim around a shallow warm face.
    # Seat the rear edge in the flat upper course. Sections and finishes are estimates.
    collar = [(0., -.009), (.131, -.009), (.134, .004), (.130, .021), (.113, .025), (.106, .015)]
    cover = [(0., .016), (.115, .016), (.114, .026), (.103, .043), (.079, .054), (.046, .062), (0., .065)]
    scene = trimesh.Scene()
    for profile, name, color, metallic, roughness in [
        (collar, "Quay fitting rim", [56, 41, 25, 255], .46, .52),
        (cover, "Quay fitting face", [200, 140, 57, 255], .12, .40),
    ]:
        template = trimesh.creation.revolve(profile, sections=16)
        template.apply_scale([.87, .87, 1])
        copies = []
        for station in stations:
            transform = np.eye(4)
            transform[:3, :3] = basis
            transform[:3, 3] = start + delta*station/length + wall_x*inland + [0, height, 0]
            copies.append(template.copy().apply_transform(transform))
        mesh = trimesh.util.concatenate(copies)
        mesh.visual = TextureVisuals(material=PBRMaterial(name=name, baseColorFactor=color,
                                                         metallicFactor=metallic, roughnessFactor=roughness))
        scene.add_geometry(mesh, geom_name=name)
    low, high = scene.bounds
    origin = (low + high) / 2
    origin[1] = low[1]
    for mesh in scene.geometry.values():
        mesh.apply_translation(-origin)
    data = trimesh.exchange.gltf.export_glb(scene, include_normals=True)
    digest = hashlib.sha256(data).hexdigest()
    (ROOT/"assets"/(digest+".glb")).write_bytes(data)
    return dict(entityId="bay.fullerton-seawall-fittings", kind="structure", layer="ext",
                regionId="marina-bay-exterior", label="浮尔顿驳岸 · 临水侧圆形构件", assetHash=digest,
                bounds={"min":low.tolist(),"max":high.tolist()}, material={"shading":"albedo"},
                props={"background":True, "实景参考":reference["image"], "岸线":quay["source"],
                       "backgroundView":{"focus":((high+low)/2).tolist(), "maxDistance":300},
                       "构件依据":"45 处圆形轮廓来自 2014 年岸线照片，沿岸位置按广场嵌石换算。照片范围外留空。构件高度、曲率与表面颜色为照片估值，功能和现状未经现场核实。"})


if __name__ == "__main__":
    entry = bake()
    path = ROOT/"build/streetscape.json"
    records = {e["entityId"]:e for e in json.loads(path.read_text())}
    records[entry["entityId"]] = entry
    path.write_text(json.dumps(list(records.values()), ensure_ascii=False, indent=2)+"\n")
    print(entry["assetHash"])
