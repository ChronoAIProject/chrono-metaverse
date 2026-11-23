"""Register One Fullerton walkway lamps to the entrance inlays and southern paving bands."""

import hashlib
import json
from pathlib import Path

import numpy as np
import trimesh
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals

ROOT = Path(__file__).resolve().parents[1]


def post_centres(reference):
    paving = json.loads((ROOT / "references/fullerton-entrance-paving.json").read_text())
    measured = {(int(i), int(j)): [x, s] for x, s, i, j in paving["centres"]}
    survey = np.array(reference["inlays"])
    xz = np.array([measured[tuple(index)] for index in survey[:, :2]])
    uv = survey[:, 2:]
    pixel_origin, site_origin = uv.mean(axis=0), xz.mean(axis=0)
    # Fit an affine map over this small, nearly planar portion of a telephoto view.
    # Leave-one-out residuals quantify the agreement within the paved control area.
    pixels = np.c_[uv - pixel_origin, np.ones(len(uv))]
    target = xz - site_origin
    fit = np.linalg.lstsq(pixels, target, rcond=None)[0]
    errors = []
    for i in range(len(uv)):
        keep = np.arange(len(uv)) != i
        predicted = pixels[i] @ np.linalg.lstsq(pixels[keep], target[keep], rcond=None)[0]
        errors.append(np.linalg.norm(predicted - target[i]))
    feet = np.asarray(reference["postFeetPixels"]) - pixel_origin
    return np.c_[feet, np.ones(len(feet))] @ fit + site_origin, np.sqrt(np.mean(np.square(errors)))


def fixture():
    # Height and head proportions estimated from the photograph. Revolve around
    # local vertical, then offset the shallow hoods to opposite sides of the shaft.
    upright = trimesh.transformations.rotation_matrix(-np.pi/2, [1, 0, 0])
    def turned(profile, x=0, s=0):
        shape = trimesh.creation.revolve(profile, sections=24)
        shape.apply_transform(upright)
        shape.apply_translation([x, 0, s])
        return shape

    pole = turned([(0, 0), (.129, 0), (.129, .07), (.117, .10), (.106, .13), (.092, 2.25),
                   (.067, 4.28), (.058, 4.78), (.047, 5.65), (.065, 5.68), (.065, 5.71), (0, 5.72)])
    white, glass = [pole], []
    for x, s, y, radius in [(-.28, .12, 4.37, .32), (.29, -.13, 4.62, .28)]:
        start, end = [0, y+.17, 0], [x, y+.11, s]
        white.append(trimesh.creation.cylinder(radius=.029, segment=[start, end], sections=12))
        profile = [(0, y-.015), (.94*radius, y-.015), (radius, y), (radius, y+.022),
                   (.92*radius, y+.04), (.30*radius, y+.127), (.075, y+.17), (0, y+.17)]
        white.append(turned(profile, x, s))
        glass.append(turned([(0, y-.112), (radius*.27, y-.089), (radius*.70, y-.045),
                             (radius*.86, y-.015), (0, y-.015)], x, s))
    return tuple(trimesh.util.concatenate(group) for group in [white, glass])


def bake():
    reference = json.loads((ROOT / "references/fullerton-entrance-lamps.json").read_text())
    positions, rms = post_centres(reference)
    south = reference["southWalk"]
    foot_columns = np.array(south["postFeetPixels"])[:, 0]
    columns, stations = np.array(south["bandControls"]).T
    if foot_columns.min() < columns[0] or foot_columns.max() > columns[-1]:
        raise ValueError("Southern lamp feet must be bracketed by registered pavement bands")
    south_stations = np.interp(foot_columns, columns, stations)
    south_x = np.full(len(south_stations), np.median(positions[:, 0]))
    positions = np.vstack([positions, np.column_stack((south_x, south_stations))])
    quay = json.loads((ROOT / "context.json").read_text())["quay"]
    start, end = np.array(quay["start"]), np.array(quay["end"])
    along = end - start
    along[1] = 0
    length = np.linalg.norm(along)
    along /= length
    inland = np.cross([0, 1, 0], along)
    scene = trimesh.Scene()
    bodies = fixture()
    for part, material in zip(bodies, [
        PBRMaterial(name="Promenade painted aluminium", baseColorFactor=[210,213,210,255],
                    metallicFactor=.08, roughnessFactor=.43),
        PBRMaterial(name="Daylight opal diffuser", baseColorFactor=[189,189,178,255],
                    metallicFactor=.02, roughnessFactor=.35),
    ], strict=True):
        copies = []
        for x, s in positions:
            placed = part.copy()
            transform = np.eye(4)
            transform[:3,:3] = np.column_stack([inland, [0,1,0], along])
            # The feet extend 18 mm into the sloping stone walkway.
            transform[:3,3] = start + x*inland + s*along + [0, .267+(end[1]-start[1])*s/length, 0]
            placed.apply_transform(transform)
            copies.append(placed)
        mesh = trimesh.util.concatenate(copies)
        mesh.visual = TextureVisuals(material=material)
        scene.add_geometry(mesh, geom_name=material.name)
    low, high = scene.bounds
    origin = (low + high)/2
    origin[1] = low[1]
    for mesh in scene.geometry.values():
        mesh.apply_translation(-origin)
    data = trimesh.exchange.gltf.export_glb(scene, include_normals=True)
    digest = hashlib.sha256(data).hexdigest()
    (ROOT / "assets" / (digest + ".glb")).write_bytes(data)
    print("Inlay leave-one-out RMS (m):", round(rms, 3), "post centres:", positions.round(2).tolist())
    return dict(entityId="bay.fullerton-entrance-lamps", kind="structure", layer="ext",
                regionId="marina-bay-exterior", label="One Fullerton · 临水步道双灯罩路灯",
                assetHash=digest, bounds={"min": low.tolist(), "max": high.tolist()}, material={"shading": "albedo"},
                props={"background": True, "实景照片": reference["image"],
                       "灯位": "由 2014 年照片中 25 个广场嵌石中心配准至 OneMap 正射影像。入口北端灯位在控制点外，中间灯脚受植栽遮挡。南段七个灯脚以相邻深灰石带定位，横向位置按入口三杆中位数估读。",
                       "灯具": "浅色渐缩杆、双层高低灯罩及乳白扩散罩依照片重建。5.72 米杆高、灯臂朝向与涂层为影像估值。"})


if __name__ == "__main__":
    entry = bake()
    path = ROOT / "build/streetscape.json"
    records = {e["entityId"]: e for e in json.loads(path.read_text())}
    records[entry["entityId"]] = entry
    path.write_text(json.dumps(list(records.values()), ensure_ascii=False, indent=2) + "\n")
    print(entry["assetHash"])
