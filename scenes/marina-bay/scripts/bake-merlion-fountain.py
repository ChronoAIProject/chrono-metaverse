"""Fit the Merlion's aerated jet to the SLA mouth and the orthophoto splash."""

import hashlib
import json
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image
from scipy.ndimage import gaussian_filter
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals

ROOT = Path(__file__).resolve().parents[1]
STATUE = "bay.a900c832-9448-4b5c-a1ef-a8828bfe76a9"
PHOTO = "https://commons.wikimedia.org/wiki/File:Merlion_Singapore_2018.tif"


def noise(rng, shape, sigma):
    field = gaussian_filter(rng.standard_normal(shape), sigma, mode="wrap")
    return (field - field.mean()) / max(.001, field.std())


def material(rng, name, long_axis):
    shape = (256, 128)
    broad = noise(rng, shape, (10 if long_axis else 4, 3))
    bubbles = noise(rng, shape, (2.5 if long_axis else 1.1, 1.1))
    density = np.clip(.57 + .25 * broad + .19 * bubbles, 0, 1)
    tint = np.clip(.91 + .05 * bubbles, .72, 1)
    rgb = (tint[:, :, None] * [224, 238, 236]).astype(np.uint8)
    image = Image.fromarray(np.dstack([rgb, np.uint8(255 * density)]))
    image.format = "PNG"
    # Coverage gives the dispersed jet a depth against the bay's transparent
    # surface, even in viewers that do not sort the two meshes per fragment.
    return PBRMaterial(name=name, baseColorTexture=image, metallicFactor=0, roughnessFactor=.38,
                       alphaMode="MASK", alphaCutoff=.36, doubleSided=False)


def strip(vertices, uv, alpha, surface, reverse=False):
    rows, cols, _ = vertices.shape
    i = np.arange((rows-1) * cols).reshape(rows-1, cols)[:, :-1].ravel()
    faces = np.vstack([np.column_stack([i, i+1, i+cols]),
                       np.column_stack([i+1, i+cols+1, i+cols])])
    if reverse:
        faces = faces[:, ::-1]
    mesh = trimesh.Trimesh(vertices=vertices.reshape(-1, 3), faces=faces, process=False)
    mesh.visual = TextureVisuals(uv=uv.reshape(-1, 2), material=surface)
    colors = np.full((rows * cols, 4), 255, dtype=np.uint8)
    colors[:, 3] = np.uint8(255 * np.clip(alpha.ravel(), 0, 1))
    mesh.visual.vertex_attributes["color"] = colors
    return mesh


def droplets(rng, mouth, forward, lateral, distance, drop):
    # Bake a normal glTF pose and per-drop velocity. The viewer can advect the
    # drops inside short overlapping intervals without a CPU particle loop.
    count = 1250
    t = rng.uniform(.22, 1, count)
    reach = distance + rng.normal(0, .34, count)
    rise = rng.normal(.9, .20, count)
    fan = t**1.6
    ht = rise*t - (drop+rise)*t*t + rng.normal(0, .17, count)*fan
    center = mouth + (reach*t)[:, None]*forward + (rng.normal(0, .28, count)*fan)[:, None]*lateral
    center[:, 1] += ht
    velocity = reach[:, None]*forward / 1.5
    velocity[:, 1] = (rise - 2*(drop+rise)*t)/1.5
    # At the impact, some spray rebounds up out of the water.
    bounce = 260
    rad = np.sqrt(rng.random(bounce))
    angle = rng.random(bounce)*2*np.pi
    axis = np.cos(angle)[:, None]*forward + np.sin(angle)[:, None]*lateral
    impact = mouth + forward*distance - [0, drop, 0]
    center[:bounce] = impact + rad[:, None]*axis*rng.uniform(.8, 1.6, (bounce, 1))
    center[:bounce, 1] += .12 + rad*(1-rad)*rng.uniform(.5, 2.0, bounce)
    velocity[:bounce] = axis * 1.8
    velocity[:bounce, 1] = 2.5*(1-2*rad)
    long = velocity / np.linalg.norm(velocity, axis=1)[:, None]
    sideways = np.cross(long, [0, 1, 0])
    sideways /= np.linalg.norm(sideways, axis=1)[:, None]
    normal = np.cross(long, sideways)
    width = rng.uniform(.010, .036, (count, 1))
    length = width*rng.uniform(1.1, 2.2, (count, 1))
    spans = np.stack([long*length, sideways*width, normal*width, -sideways*width,
                      -normal*width, -long*length], axis=1)
    faces = np.array([[0, 1, 2], [0, 2, 3], [0, 3, 4], [0, 4, 1],
                      [5, 2, 1], [5, 3, 2], [5, 4, 3], [5, 1, 4]])
    single = PBRMaterial(name="Fountain droplets", baseColorFactor=[225, 236, 235, 255],
                         roughnessFactor=.36, metallicFactor=0)
    mesh = trimesh.Trimesh(vertices=(center[:, None, :] + spans).reshape(-1, 3),
                           faces=(faces[None, :, :] + 6*np.arange(count)[:, None, None]).reshape(-1, 3),
                           visual=TextureVisuals(material=single), process=False)
    mesh.vertex_attributes["_DROP_DRIFT"] = np.repeat(np.c_[velocity, rng.random(count)], 6, axis=0).astype("float32")
    return mesh


def fountain(statue):
    rng = np.random.default_rng(182819157)
    lo, hi = (np.array(statue["bounds"][key]) for key in ("min", "max"))
    origin = (lo + hi) / 2
    origin[1] = lo[1]
    # Front elevation of SLA 5_0.glb, centred in the opening immediately
    # below the upper lip. Coordinates are in the survey model's own frame.
    mouth = origin + [-1.30, 9.99, 1.10]
    # On the level-20 OrthoJPG, the jet runs east and 9.5 degrees north.
    # About 82 pixels separate the projected lip and the visible foam centre.
    angle = np.deg2rad(25 + 9.5)
    forward = np.array([-np.cos(angle), 0, np.sin(angle)])
    up = np.array([0, 1, 0])
    lateral = np.cross(up, forward)
    distance = 12.25
    water_y = -60.00
    drop = mouth[1] - water_y
    stream = material(rng, "Aerated fountain jet", True)
    spray = material(rng, "Fountain impact foam", False)
    streams = []
    t, a = np.meshgrid(np.linspace(0, 1, 33), np.linspace(0, 2*np.pi, 11), indexing="ij")
    # Flow leaves nearly horizontal, then accelerates vertically under gravity.
    # The asymmetric filaments open gradually around the main column.
    for k in range(6):
        direction = k * 2.39996
        reach = (distance if k == 0 else distance + rng.uniform(-.62, .62))
        rise = .9 if k == 0 else rng.uniform(.55, 1.15)
        tangent = reach * forward + (rise - 2 * (drop + rise) * t[..., None]) * up
        tangent /= np.linalg.norm(tangent, axis=2)[..., None]
        radial_up = np.cross(tangent, lateral)
        centers = mouth + t[..., None] * reach * forward + (rise*t - (drop+rise)*t*t)[..., None]*up
        fan = 0 if k == 0 else .19*t**1.4
        twist = direction + .65*np.sin(7.5*t + direction)
        centers += (fan*np.cos(twist))[..., None]*lateral + (fan*np.sin(twist))[..., None]*radial_up
        radius = (.105 + .108*t) if k == 0 else (.023 + .070*t)
        radius = radius * (1 + .09*t*np.sin(11*t + 3*a + direction))
        vertices = centers + radius[..., None]*(np.cos(a)[..., None]*lateral + np.sin(a)[..., None]*radial_up)
        uv = np.stack([a/(2*np.pi) + k*.13, t*(4.6 + k*.04)], axis=-1)
        alpha = (.96 - .38*t) if k == 0 else (.72 - .18*t + .17*t*np.cos(51*t+direction))
        streams.append(strip(vertices, uv, alpha, stream))
    # A low, turbulent crown at impact spreads into a patch of broken foam.
    impact = mouth + forward * distance
    impact[1] = water_y
    r, theta = np.meshgrid(np.linspace(0, 1, 12), np.linspace(0, 2*np.pi, 49), indexing="ij")
    irregular = 1 + .14*np.sin(3*theta+.5) + .08*np.cos(7*theta)
    along = r * (1.52*irregular*np.cos(theta) + .38*r)
    across = 1.08 * irregular * r * np.sin(theta)
    height = .105 + .21*np.exp(-8*r*r) + .17*np.exp(-((r-.32)/.13)**2)*(1 + .4*np.cos(9*theta))
    vertices = impact + along[..., None]*forward + across[..., None]*lateral + height[..., None]*up
    foam = strip(vertices, np.stack([across*.92, along*.88], axis=-1),
                 (1-r**1.25)*.97, spray, reverse=True)
    return streams, foam, droplets(rng, mouth, forward, lateral, distance, drop)


def bake():
    path = ROOT / "build/streetscape.json"
    existing = {e["entityId"]: e for e in json.loads(path.read_text())}
    statue = next(e for e in json.loads((ROOT/"build/onemap-entities.json").read_text()) if e["entityId"] == STATUE)
    streams, foam, mist = fountain(statue)
    # Keep each material in one primitive, including vertex opacity.
    parts = [trimesh.util.concatenate(streams), foam, mist]
    first = parts[0]
    first.visual = TextureVisuals(uv=np.vstack([m.visual.uv for m in streams]),
                                  material=streams[0].visual.material)
    first.visual.vertex_attributes["color"] = np.vstack([m.visual.vertex_attributes["color"] for m in streams])
    scene = trimesh.Scene()
    for part in parts:
        scene.add_geometry(part, geom_name=part.visual.material.name)
    lo, hi = scene.bounds
    anchor = (lo + hi)/2
    anchor[1] = lo[1]
    for part in scene.geometry.values():
        part.apply_translation(-anchor)
    def tag(doc):
        for mat in doc["materials"]:
            mat["extras"] = {"waterSurface": {"Aerated fountain jet": "fountainJet",
                                              "Fountain impact foam": "fountainFoam",
                                              "Fountain droplets": "fountainDrops"}[mat["name"]]}
    data = trimesh.exchange.gltf.export_glb(scene, include_normals=True, tree_postprocessor=tag)
    digest = hashlib.sha256(data).hexdigest()
    (ROOT/"assets"/(digest+".glb")).write_bytes(data)
    entity_id = "bay.merlion-fountain-water"
    existing[entity_id] = dict(entityId=entity_id, layer="ext", kind="object", regionId=statue["regionId"],
                               label="鱼尾狮公园 · 喷泉水柱", assetHash=digest,
                               bounds={"min":lo.tolist(), "max":hi.tolist()}, material={"shading":"albedo"},
                               props={"background":True, "surfaceRole":"water", "雕像":STATUE,
                                      "地理参考":"https://www.openstreetmap.org/way/182819157",
                                      "影像":"Map Data © Singapore Land Authority / OneMap OrthoJPG",
                                      "现场参考":PHOTO, "说明":"出水口取自 OneMap 雕像，喷射方向和落点参照正射影像。水流宽度、破碎程度与水花高度为日间估值。"})
    path.write_text(json.dumps(list(existing.values()), ensure_ascii=False, indent=2)+"\n")
    print(digest, len(data), sum(len(m.faces) for m in parts))


if __name__ == "__main__":
    bake()
