"""Fit the photographed diagonal facing below One Fullerton's waterfront coping."""

import hashlib
import json
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals

ROOT = Path(__file__).resolve().parents[1]
REFERENCE = "https://commons.wikimedia.org/wiki/File:Singapore_-_panoramio_(109).jpg"
BOTTOM, TOP = -.36, .504
REPEAT = 6.0
# The round fittings are seated in the flat top course above this rebate.
COURSE_FOOT = .17


def facing_material():
    # A diagonal historic stone pattern below a narrow horizontal course. Use
    # the site's CC0 granite grain within individually varied stones.
    rows, columns = 256, 1536
    y, x = np.indices((rows, columns))
    along = REPEAT * (x + .5) / columns
    level = TOP - (TOP - BOTTOM) * (y + .5) / rows
    a, b = (along + level) / .375, (along - level) / .375
    ia, ib = np.floor(a).astype(int), np.floor(b).astype(int)
    # Repeating tile joins match both the diamond grid and the stone colours.
    stone = np.random.default_rng(9804).uniform(-1, 1, (16, 16))
    tone = stone[ia % 16, ib % 16]
    assets = ROOT.parents[1] / "web/src/assets/geography"
    color = np.asarray(Image.open(assets / "pavers-color.webp").convert("RGB"), float)
    # Interior of a single stone in the scan, excluding its straight paving joints.
    grain = color[45:160, 60:175] @ [.2126, .7152, .0722]
    grain -= grain.mean()
    u = np.floor((a - ia) * 114).astype(int)
    v = np.floor((b - ib) * 114).astype(int)
    sample = grain[v, u]
    joint_distance = np.minimum(abs(a - np.rint(a)), abs(b - np.rint(b))) * .375 / np.sqrt(2)
    joint = np.clip(1 - joint_distance / .008, 0, 1)
    upper = level > COURSE_FOOT
    block_ends = np.abs((along + .375) % .75 - .375)
    joint = np.where(upper, np.clip(1-block_ends/.006, 0, 1), joint)
    joint = np.maximum(joint, np.clip(1-abs(level-COURSE_FOOT)/.008, 0, 1))
    tone = np.where(upper, stone[(along/.75).astype(int) % 8, 0], tone)
    # The mapped water is 3–5 cm above the quay datum along this reach.
    # Irregular darkening and small pale deposits follow the observed water edge.
    water = .044
    wave = .010*np.sin(along*2*np.pi/1.5) + .007*np.sin(along*2*np.pi/.375)
    damp = np.clip((water+.085+wave+.010*tone-level)/.08, 0, 1)
    deposits = np.exp(-((level-water-.043-wave)/.021)**2)
    granular = np.clip(.4 + sample/45 + .5*tone, 0, 1)
    factor = 1 - .29*damp
    dry = np.array([149, 142, 132]) + tone[:, :, None]*[14, 12, 9] + sample[:, :, None]*.47
    rgb = dry*factor[:, :, None] - joint[:, :, None]*25 + (deposits*granular)[:, :, None]*32
    albedo = Image.fromarray(np.uint8(np.clip(rgb, 0, 255)))
    albedo.format = "JPEG"

    # Joint returns perturb the lighting independently of the colour pattern.
    relief = -.0035*joint + .000014*sample
    dhdy, dhdx = np.gradient(relief, (TOP-BOTTOM)/rows, REPEAT/columns)
    n = np.dstack((-dhdx, dhdy, np.ones_like(joint)))
    n /= np.linalg.norm(n, axis=2, keepdims=True)
    normal = Image.fromarray(np.uint8((n+1)*127.5)).resize((768, 128), Image.Resampling.LANCZOS)
    normal.format = "PNG"
    roughness = np.uint8(np.clip(216-59*damp+13*joint+.18*sample, 120, 248))
    packed = Image.fromarray(np.dstack((np.full_like(roughness, 255), roughness, np.zeros_like(roughness))))
    packed = packed.resize((384, 64), Image.Resampling.BOX)
    return PBRMaterial(name="Fullerton diagonal embankment masonry", baseColorTexture=albedo,
                       normalTexture=normal, metallicRoughnessTexture=packed, metallicFactor=0, roughnessFactor=1)


def bake():
    quay = json.loads((ROOT / "context.json").read_text())["quay"]
    first, last = np.array(quay["start"]), np.array(quay["end"])
    delta = last - first
    length = np.linalg.norm(delta[[0, 2]])
    inland = np.array([delta[2], 0, -delta[0]]) / length
    # Fit beneath the 0.115 m coping projection. The slightly battered foot
    # extends below the rendered bay even at the ends of this 165 m reach.
    profile = [(BOTTOM, -.196), (COURSE_FOOT-.006, -.081), (COURSE_FOOT+.004, -.09), (TOP, -.09)]
    stations = np.linspace(0, length, round(length / 2.5) + 1)
    shade = np.random.default_rng(93).uniform(.88, 1, len(stations))
    vertices, uv, faces, colors = [], [], [], []
    for (h0, x0), (h1, x1) in zip(profile, profile[1:]):
        begin = len(vertices)
        for i, s in enumerate(stations):
            point = first + delta * s/length
            for h, x in [(h0, x0), (h1, x1)]:
                vertices.append(point + x*inland + [0, h, 0])
                uv.append((s/REPEAT, (h-BOTTOM)/(TOP-BOTTOM)))
                colors.append([round(255*shade[i])]*3 + [255])
            if i:
                a = begin+2*i
                faces.extend([(a-2, a, a+1), (a-2, a+1, a-1)])
    end_colors = [round(255*shade[0]), round(255*shade[-1])]
    # Close the narrow end returns where a low viewpoint can see past the last slab.
    for end, s, tint in [(first, 0, end_colors[0]), (last, length, end_colors[1])]:
        for (h0, x0), (h1, x1) in zip(profile, profile[1:]):
            start = len(vertices)
            for h, x in [(h0,x0), (h1,x1), (h1,0), (h0,0)]:
                vertices.append(end + x*inland + [0,h,0])
                uv.append(((s+x)/REPEAT, (h-BOTTOM)/(TOP-BOTTOM)))
                colors.append([tint, tint, tint, 255])
            tri = np.array([(0,1,2),(0,2,3)]) + start
            faces.extend(tri if s == 0 else tri[:, ::-1])
    visual = TextureVisuals(uv=uv, material=facing_material())
    visual.vertex_attributes["color"] = np.uint8(colors)
    mesh = trimesh.Trimesh(vertices=vertices, faces=faces, visual=visual, process=False)
    if mesh.face_normals[0] @ inland > -.95:
        raise ValueError("Water-facing wall winding is inverted")
    low, high = mesh.bounds.copy()
    center = (low + high)/2
    center[1] = low[1]
    mesh.apply_translation(-center)
    data = trimesh.exchange.gltf.export_glb(trimesh.Scene(mesh), include_normals=True)
    digest = hashlib.sha256(data).hexdigest()
    (ROOT / "assets" / (digest + ".glb")).write_bytes(data)
    return dict(entityId="bay.fullerton-seawall", regionId="marina-bay-exterior", kind="structure",
                layer="ext", label="浮尔顿滨水步道 · 菱砌驳岸", assetHash=digest,
                bounds={"min": low.tolist(), "max": high.tolist()}, material={"shading": "albedo"},
                props={"background": True, "岸线": quay["source"], "地图来源": "© OpenStreetMap contributors · ODbL",
                       "照片参考": REFERENCE, "材质来源": "Poly Haven · Granite Tile 04 · CC0",
                       "砌石": "沿已配准的岸线重建照片可见的菱形石缝与压条。块材尺寸、墙身坡度和湿痕宽度依照片估值，水线随场景水面配准。"})


if __name__ == "__main__":
    entity = bake()
    file = ROOT / "build/streetscape.json"
    records = {e["entityId"]: e for e in json.loads(file.read_text())}
    records[entity["entityId"]] = entity
    file.write_text(json.dumps(list(records.values()), ensure_ascii=False, indent=2) + "\n")
    print(entity["assetHash"])
