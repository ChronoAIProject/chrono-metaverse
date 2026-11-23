"""Project the Mandarin Oriental's bay-facing guestroom grid onto the SLA survey."""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import trimesh
from scipy.signal import find_peaks
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals

ROOT = Path(__file__).resolve().parents[1]
HOTEL = "bay.cba4c479-1333-4eb8-a531-9f6e1049408e"
SOURCE = "37772bf78798e97dbd829f1ef013051d766c31b7281f35ffc3620180b7a300f4"
PHOTO = "https://commons.wikimedia.org/wiki/File:Mandarin_Oriental_Building_Singapore_Meqqal.jpg"


def guestroom_front(source):
    image = source.visual.material.baseColorTexture.convert("RGB")
    uv = source.visual.uv * [2048, -1024] + [-.5, 1023.5]
    # The survey contains two copies of the pair of triangles covering the front.
    faces = source.faces[(source.face_normals[:, 2] < -.97) & (source.area_faces > 1800)]
    pixels = uv[faces].reshape(-1, 2)
    design = np.column_stack((pixels, np.ones(len(pixels))))
    survey = source.vertices[faces].reshape(-1, 3)
    axes = np.linalg.lstsq(design, survey, rcond=None)[0]
    if np.linalg.norm(design @ axes - survey, axis=1).max() > .01:
        raise ValueError("Hotel front exceeds the surveyed plane tolerance")
    normal = np.cross(axes[1], axes[0])
    normal /= np.linalg.norm(normal)
    luminance = np.asarray(image) @ [.2126, .7152, .0722]
    # The upright elevation is stored sideways. Atlas X increases down the building.
    floor_signal = np.median(luminance[125:365], axis=0)
    floor_centres = find_peaks(floor_signal[1319:1540], distance=12, height=140)[0] + 1319
    pier_signal = np.median(luminance[:, 1312:1543], axis=1)
    pier_centres = find_peaks(pier_signal[108:361], distance=17, height=110)[0] + 108
    if len(floor_centres) != 15 or len(pier_centres) != 12:
        raise ValueError("The measured guestroom grid has changed")
    levels = np.r_[1309.7, floor_centres, 1547.4]
    # Stay inside the slightly tapered edge of the survey, leaving the green crown visible.
    columns = np.r_[99.0, pier_centres, 372.1]
    frame_vertices, sash_vertices, pane_vertices, pane_uv = [], [], [], []
    def quad(target, points):
        target.extend(np.asarray(points)[[0, 1, 2, 0, 2, 3]])

    def corners(top, bottom, left, right):
        return np.array([[top, left], [top, right], [bottom, right], [bottom, left]])

    def plane(points, depth):
        return np.column_stack((points, np.ones(4))) @ axes + depth * normal

    def frame(top, bottom, left, right, depth):
        rect = corners(top, bottom, left, right)
        back, front = plane(rect, .008), plane(rect, depth)
        quad(frame_vertices, front)
        for i in range(4):
            following = (i + 1) % 4
            quad(frame_vertices, [back[i], back[following], front[following], front[i]])

    # Slab projection, fascia thickness and mullion depth are photographic estimates.
    half_floor, half_pier = 1.62, .72
    for level in levels:
        frame(level-half_floor, level+half_floor, columns[0], columns[-1], .56)
    for top, bottom in zip(levels[:-1], levels[1:]):
        for pier in pier_centres:
            frame(top+half_floor, bottom-half_floor, pier-half_pier, pier+half_pier, .40)
        for left, right in zip(columns[:-1], columns[1:]):
            rect = corners(top+half_floor, bottom-half_floor,
                           left + (half_pier if left != columns[0] else 0),
                           right - (half_pier if right != columns[-1] else 0))
            quad(pane_vertices, plane(rect, .021))
            quad(pane_uv, (rect + .5 - [1307, 93]) / [243, 282] * [1, -1] + [0, 1])
            # The photograph resolves a narrow side light beside the main sash.
            # Face widths here follow its proportions, not a measured joinery section.
            split = left + .23 * (right - left)
            sash = corners(top+half_floor, bottom-half_floor, split-.24, split+.24)
            quad(sash_vertices, plane(sash, .058))
    stone = PBRMaterial(name="Mandarin Oriental balcony fascia", baseColorFactor=[163,169,165,255],
                        metallicFactor=.04, roughnessFactor=.68)
    crop = image.crop((1307, 93, 1550, 375))
    crop.format = "PNG"
    glass = PBRMaterial(name="Mandarin Oriental guestroom glass", baseColorTexture=crop,
                        baseColorFactor=[213,222,230,255], metallicFactor=0, roughnessFactor=.31)
    aluminium = PBRMaterial(name="Mandarin Oriental dark sash", baseColorFactor=[48,53,57,255],
                            metallicFactor=.38, roughnessFactor=.47)
    meshes = []
    for vertices, material, texcoords in [(frame_vertices, stone, None), (pane_vertices, glass, pane_uv),
                                         (sash_vertices, aluminium, None)]:
        meshes.append(trimesh.Trimesh(vertices=vertices, faces=np.arange(len(vertices)).reshape(-1, 3),
                                      visual=TextureVisuals(uv=texcoords, material=material), process=False))
    return meshes


def bake(path):
    if hashlib.sha256(path.read_bytes()).hexdigest() != SOURCE:
        raise ValueError("Expected the original OneMap survey of the Mandarin Oriental")
    model = trimesh.load_scene(path, process=False).geometry["25_0.glb"]
    record = next(e for e in json.loads((ROOT/"build/onemap-entities.json").read_text()) if e["entityId"] == HOTEL)
    anchor = np.mean([record["bounds"]["min"], record["bounds"]["max"]], axis=0)
    anchor[1] = record["bounds"]["min"][1]
    scene = trimesh.Scene()
    for mesh in guestroom_front(model):
        mesh.apply_translation(anchor)
        scene.add_geometry(mesh, geom_name=mesh.visual.material.name)
    low, high = scene.bounds
    origin = (low + high) / 2
    origin[1] = low[1]
    for mesh in scene.geometry.values():
        mesh.apply_translation(-origin)

    def materials(doc):
        panel = next(m for m in doc["materials"] if m["name"] == "Mandarin Oriental guestroom glass")
        panel["extras"] = {"surfaceRole":"facade", "reflectSky":True}
    data = trimesh.exchange.gltf.export_glb(scene, include_normals=True, tree_postprocessor=materials)
    digest = hashlib.sha256(data).hexdigest()
    (ROOT/"assets"/(digest+".glb")).write_bytes(data)
    return dict(entityId="bay.mandarin-oriental-bay-front", kind="structure", layer="ext", regionId=record["regionId"],
                label="文华东方酒店 · 临湾客房立面", assetHash=digest, material={"shading":"albedo"},
                bounds={"min":low.tolist(), "max":high.tolist()}, props={
                    "background":True, "立面调查":"Map Data © Singapore Land Authority / OneMap · "+HOTEL,
                    "实景参考":PHOTO, "重建":"16 层、13 开间按原始立面纹理定位。横梁、窗间柱挑出量和玻璃材质按照片估值。"})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    entry = bake(parser.parse_args().source)
    path = ROOT/"build/streetscape.json"
    records = {e["entityId"]:e for e in json.loads(path.read_text())}
    records[entry["entityId"]] = entry
    path.write_text(json.dumps(list(records.values()), ensure_ascii=False, indent=2)+"\n")
    print(entry["assetHash"])
