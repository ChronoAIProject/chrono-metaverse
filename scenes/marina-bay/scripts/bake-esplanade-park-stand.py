"""Build the inland Esplanade Park canopy from census trees and depth slices of a scanned broadleaf."""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np
import trimesh
from PIL import Image
from scipy.spatial import cKDTree
from scipy.ndimage import distance_transform_edt, gaussian_filter, map_coordinates, maximum_filter
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals

from courtyard_tree import compact_bark
from fullerton_shrubs import combined

ROOT = Path(__file__).resolve().parents[1]
LAYERS, TILE = 5, 160
RAIN_TREE_HEADROOM = 1.4
SOURCES = {
    "island_tree_01": "78e905a40670bfabb2760601d4d9a6c17193a50d68e6271c66893eb7bd75906d",
    "jacaranda_tree": "ba4aa8ab4c3e3741ce3699604d6ec1607cd6b126ae2d32abbcc0d98e8edb3be4",
}


def sample_scan(folder, name):
    raw = (folder / f"{name}_1k.gltf").read_bytes()
    if hashlib.sha256(raw).hexdigest() != SOURCES[name]:
        raise ValueError(f"Expected the Poly Haven {name} 1k glTF")
    doc = json.loads(raw)
    binary = (folder / doc["buffers"][0]["uri"]).read_bytes()

    def read(index):
        a = doc["accessors"][index]
        view = doc["bufferViews"][a["bufferView"]]
        size = {"SCALAR": 1, "VEC2": 2, "VEC3": 3}[a["type"]]
        dtype = {5126: "<f4", 5125: "<u4", 5123: "<u2"}[a["componentType"]]
        return np.frombuffer(binary, dtype, a["count"] * size,
                             view.get("byteOffset", 0) + a.get("byteOffset", 0)).reshape(-1, size)

    rng = np.random.default_rng(308)
    points, colours = [], []
    bark_index = None
    for primitive in doc["meshes"][0]["primitives"]:
        attr = primitive["attributes"]
        pos = read(attr["POSITION"])
        faces = read(primitive["indices"]).reshape(-1, 3)
        tri = pos[faces]
        area = np.linalg.norm(np.cross(tri[:, 1]-tri[:, 0], tri[:, 2]-tri[:, 0]), axis=1)
        # Sample by surface area so the large trunk polygons and individual leaf
        # blades resolve equally in every orthographic section.
        total = 1300000 if len(faces) > 1000000 else 450000
        sample = rng.choice(len(area), size=total, p=area.astype(float)/area.sum(dtype=float))
        w = rng.random((total, 2), dtype=np.float32)
        flip = w.sum(axis=1) > 1
        w[flip] = 1 - w[flip]
        weights = np.column_stack((1-w.sum(axis=1), w))
        mat = doc["materials"][primitive["material"]]
        texture = mat["pbrMetallicRoughness"]["baseColorTexture"]
        transform = texture.get("extensions", {}).get("KHR_texture_transform", {})
        uv = read(attr["TEXCOORD_0"]) * transform.get("scale", [1, 1]) + transform.get("offset", [0, 0])
        st = np.einsum("ij,ijk->ik", weights, uv[faces[sample]]) % 1
        tex = doc["textures"][texture["index"]]["source"]
        image = np.array(Image.open(folder / doc["images"][tex]["uri"]).convert("RGB"))
        u, v = (st * image.shape[1::-1]).astype(int).T
        keep = np.ones(total, bool)
        if mat["name"] == f"{name}_leaves":
            with Image.open(folder / f"textures/{name}_leaves_alpha_1k.png") as opacity:
                mask = np.asarray(opacity)
                if mask.ndim == 3:
                    mask = mask[:, :, 0]
            keep = mask[v,u] >= np.iinfo(mask.dtype).max / 2
        if mat["name"] in (name, f"{name}_trunk"):
            bark_index = len(points)
            paint = PBRMaterial(name=f"{name} park bark", baseColorTexture=Image.fromarray(image),
                                metallicFactor=0, roughnessFactor=.96)
            bark = trimesh.Trimesh(vertices=pos, faces=faces, vertex_normals=read(attr["NORMAL"]),
                                   visual=TextureVisuals(uv=uv * [1, -1] + [0, 1], material=paint),
                                   process=False)
            bark = compact_bark(bark, target_triangles=240, max_error=.12)
        points.append(np.einsum("ij,ijk->ik", weights, tri[sample])[keep])
        colours.append(image[v[keep],u[keep]])
    xyz = np.vstack(points)
    if bark_index is None:
        raise ValueError(f"No bark primitive in {name}")
    low, span = xyz.min(0), np.ptp(xyz, axis=0)
    xyz = (xyz - low) / span
    bark_normals = bark.vertex_normals * span
    bark.vertices = (bark.vertices - low) / span
    bark.vertex_normals = bark_normals / np.linalg.norm(bark_normals, axis=1)[:, None]
    rgb = np.vstack(colours).astype(float)
    # Approximate blocked skylight from depth above each scanned surface sample.
    coverage = np.zeros(len(xyz))
    for ray in [[0,1,0],[.75,.66,0],[-.75,.66,0],[0,.66,.75],[0,.66,-.75]]:
        ray = np.asarray(ray)
        side = np.array([1,0,0]) if ray[1] == 1 else np.cross(ray, [0,1,0])
        side = side / np.linalg.norm(side)
        uv = xyz @ np.array([side, np.cross(ray, side)]).T
        grid = np.floor((uv-uv.min(0))*85).astype(int)
        depth = xyz @ ray
        front = np.full(grid.max(0)+1, -np.inf)
        np.maximum.at(front, tuple(grid.T), depth)
        coverage += np.clip((maximum_filter(front, size=3)[tuple(grid.T)]-depth-.025)/.26, 0, 1)
    canopy = np.concatenate([np.full(len(part), i != bark_index) for i, part in enumerate(points)])
    shade = 1 - .34 * coverage / 5
    shaded = np.uint8(np.clip(rgb * shade[:, None], 0, 255))
    # Preserve the scanned skylight occlusion after separating solid wood from the atlas.
    nearest = cKDTree(xyz[~canopy]).query(bark.vertices, k=12)[1]
    linear = np.power(shade[~canopy][nearest].mean(axis=1), 2.2)
    bark.visual.vertex_attributes["color"] = np.uint8(
        np.column_stack((linear, linear, linear, np.ones(len(linear)))) * 255)
    return xyz, shaded, canopy, bark


def canopy_depths(points, u, v, depth, cells=3):
    """Fit each depth layer to the local distribution of scanned branches."""
    bands = 64
    grid = np.clip(points[:, [u, v]] * cells, 0, cells)
    levels = np.minimum(bands - 1, (points[:, depth] * bands).astype(int))
    ix, iy = np.rint(grid).astype(int).T
    hist = np.zeros((cells + 1, cells + 1, bands))
    np.add.at(hist, (ix, iy, levels), 1)
    cumulative = gaussian_filter(hist, (.70, .70, 0)).cumsum(axis=2)
    fractions = cumulative / np.maximum(cumulative[:, :, -1:], 1e-12)
    quantiles = (np.arange(LAYERS) + .5) / LAYERS
    heights = np.stack([(np.argmax(fractions >= q, axis=2) + .5) / bands for q in quantiles])
    boundaries = (heights[:-1] + heights[1:]) / 2
    layers = np.zeros(len(points), dtype=int)
    for boundary in boundaries:
        layers += points[:, depth] > map_coordinates(boundary, grid.T, order=1, mode="nearest")
    return heights, layers


def slices(points, colors, canopy):
    atlas = Image.new("RGBA", (TILE*LAYERS, TILE*3))
    vertices, uv, normals, faces = [], [], [], []
    for row, (u,v,depth) in enumerate([(0,1,2),(2,1,0),(0,2,1)]):
        surfaces, layers = canopy_depths(points, u, v, depth)
        for k in range(LAYERS):
            where = np.flatnonzero((layers == k) & canopy)
            ordered = where[np.argsort(points[where,depth], kind="stable")]
            size = TILE * 2
            px = np.rint(3 + (size-7)*points[ordered,u]).astype(int)
            py = np.rint(3 + (size-7)*(1-points[ordered,v])).astype(int)
            rgba = np.zeros((size,size,4),np.uint8)
            rgba[py,px,:3] = colors[ordered]
            rgba[py,px,3] = 255
            image = Image.fromarray(rgba).resize((TILE,TILE),Image.Resampling.LANCZOS)
            pixels = np.array(image)
            nearest = distance_transform_edt(pixels[:,:,3] == 0,return_indices=True,return_distances=False)
            pixels[:,:,:3] = pixels[tuple(nearest)][:,:,:3]
            atlas.paste(Image.fromarray(pixels), (k*TILE,row*TILE))
            base = len(vertices)
            surface = surfaces[k]
            steps = len(surface) - 1
            for ix, iy in np.ndindex(surface.shape):
                a, b = ix / steps, iy / steps
                pos = np.zeros(3)
                pos[[u, v, depth]] = [a, b, surface[ix, iy]]
                vertices.append(pos)
                n = pos - [.5, .32, .5]
                n[1] = max(n[1], .12)
                normals.append(n / np.linalg.norm(n))
                uv.append([(k + a) / LAYERS, 1 - (row + 1 - b) / 3])
            # Both sides use the same crown-outward shading normals.
            for ix, iy in np.ndindex((steps, steps)):
                first = base + ix * (steps + 1) + iy
                right = first + steps + 1
                for tri in [(first, right, right + 1), (first, right + 1, first + 1)]:
                    faces.extend((tri, tri[::-1]))
    atlas.format = "PNG"
    return np.array(vertices), np.array(uv), np.array(normals), np.array(faces), atlas


def bake(folder, spreading_tree):
    ref = json.loads((ROOT/"references/esplanade-park-stand.json").read_text())
    points, colors, canopy, compact_bark_mesh = sample_scan(folder, "island_tree_01")
    compact_xyz, uv, compact_normals, faces, compact = slices(points, colors, canopy)
    points, colors, canopy, spreading_bark_mesh = sample_scan(spreading_tree, "jacaranda_tree")
    spreading_xyz, _, spreading_normals, _, spreading = slices(points, colors, canopy)
    stems = {0: [], 1: []}
    atlas = Image.new("RGBA", (compact.width, compact.height * 2))
    atlas.paste(compact, (0, 0))
    # Reserve linear tint range for the brighter surveyed crowns. Decode and re-encode
    # sRGB here because glTF vertex colours multiply the sampled texture in linear light.
    encoded = np.arange(256) / 255
    linear = np.where(encoded <= .04045, encoded / 12.92, ((encoded + .055) / 1.055)**2.4)
    boosted = np.minimum(1, linear * RAIN_TREE_HEADROOM)
    lut = np.rint(255 * np.where(boosted <= .0031308, 12.92 * boosted,
                                1.055 * boosted**(1/2.4) - .055)).astype(np.uint8)
    pixels = np.array(spreading)
    pixels[:, :, :3] = lut[pixels[:, :, :3]]
    atlas.paste(Image.fromarray(pixels), (0, compact.height))
    atlas.format = "PNG"
    paint = PBRMaterial(name="Esplanade Park layered broadleaf canopy", baseColorTexture=atlas,
                        metallicFactor=0, roughnessFactor=.98, alphaMode="MASK", alphaCutoff=.32)
    vertices, shading, tones, texcoords = [], [], [], []
    widths = {"Samanea saman":1.38,"Tabebuia rosea":.69,"Pterocarpus indicus":1.05,
              "Peltophorum pterocarpum":1.12}
    aerial_median = np.median([t["aerialRGB"] for t in ref["trees"]],axis=0)
    avenue = json.loads((ROOT / "references/connaught-drive-rain-trees.json").read_text())
    along = np.array(avenue["crownSurvey"]["alongLocalXZ"])
    along /= np.linalg.norm(along)
    road_axes = np.array([along, [-along[1], along[0]]])
    trees = ref["trees"] + avenue["trees"]
    for tree in trees:
        # Both source volumes use the same slice grid. Select its UV region for each crown.
        if tree["species"] == "Samanea saman":
            xyz, normals, bark, atlas_offset = spreading_xyz, spreading_normals, spreading_bark_mesh, 0
        else:
            xyz, normals, bark, atlas_offset = compact_xyz, compact_normals, compact_bark_mesh, 1
        tree_uv = uv.copy()
        tree_uv[:, 1] = (tree_uv[:, 1] + atlas_offset) / 2
        texcoords.extend(tree_uv)
        rng = np.random.default_rng(int(tree["treeId"]))
        height = tree["heightUpper"] - rng.uniform(.5,2.5)
        width = widths[tree["species"]] * height
        axes = np.array([width*rng.uniform(.86,1.07),height,width*rng.uniform(.84,1.04)])
        angle = rng.uniform(-np.pi,np.pi)
        basis = trimesh.transformations.rotation_matrix(angle,[0,1,0])[:3,:3]
        transform = basis @ np.diag(axes)
        fit = tree.get("crownFit")
        if fit:
            warp = np.eye(3)
            horizontal = np.ix_([0, 2], [0, 2])
            warp[horizontal] = road_axes.T @ np.diag(fit["scaleAlongAcross"]) @ road_axes
            # Shear from ground level so the visible crown can lean beyond the stem.
            warp[[0, 2], 1] = (fit["offsetAlongAcrossMetres"] @ road_axes) / (.70 * height)
            transform = warp @ transform
        x,z = tree["localXZ"]
        ground = np.array([x, tree["groundY"] - .04, z])
        normal_transform = np.linalg.inv(transform)
        mapped = (xyz - [.5, 0, .5]) @ transform.T + ground
        n = normals @ normal_transform
        vertices.extend(mapped)
        trunk = bark.copy()
        trunk.vertices = (bark.vertices - [.5, 0, .5]) @ transform.T + ground
        trunk_normals = bark.vertex_normals @ normal_transform
        trunk.vertex_normals = trunk_normals / np.linalg.norm(trunk_normals, axis=1)[:, None]
        stems[atlas_offset].append(trunk)
        shading.extend(n/np.linalg.norm(n,axis=1)[:,None])
        tint = np.clip((np.array(tree["aerialRGB"])/aerial_median)**.65,.70,1.13)
        color = np.minimum(255, 231*tint)
        if tree["species"] == "Samanea saman":
            color = color * np.array(tree.get("foliageGainLinear", [1, 1, 1])) / RAIN_TREE_HEADROOM
        color = np.uint8(np.clip(np.rint(color), 0, 255)).tolist()
        tones.extend(np.tile([*color, 255], (len(xyz), 1)))
    visual = TextureVisuals(uv=np.asarray(texcoords), material=paint)
    visual.vertex_attributes["color"] = np.asarray(tones,np.uint8)
    mesh = trimesh.Trimesh(vertices=vertices,faces=np.vstack([faces+i*len(xyz) for i in range(len(trees))]),
                           vertex_normals=shading,visual=visual,process=False)
    scene = trimesh.Scene(mesh)
    for bark_source, group in [(spreading_bark_mesh, stems[0]), (compact_bark_mesh, stems[1])]:
        trunk_mesh = combined(group)
        trunk_mesh.visual.vertex_attributes["color"] = np.tile(bark_source.visual.vertex_attributes["color"], (len(group), 1))
        scene.add_geometry(trunk_mesh, geom_name=trunk_mesh.visual.material.name)
    low, high = scene.bounds
    origin = (low+high)/2
    origin[1] = low[1]
    for surface in scene.geometry.values():
        surface.apply_translation(-origin)
    with TemporaryDirectory() as directory:
        source = Path(directory) / "trees.glb"
        packed = Path(directory) / "packed.glb"
        source.write_bytes(trimesh.exchange.gltf.export_glb(scene, include_normals=True))
        subprocess.run(["node", str(ROOT / "node_modules/gltfpack/cli.js"),
                        "-i", str(source), "-o", str(packed), "-vp", "16", "-vt", "14",
                        "-vn", "10", "-km", "-kn"], check=True)
        data = packed.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    (ROOT/'assets'/(digest+'.glb')).write_bytes(data)
    return dict(entityId="bay.esplanade-park-stand",regionId="marina-bay-exterior",layer="ext",kind="structure",
                label="滨海公园 · 步道与康乐通道林冠",assetHash=digest,bounds={"min":low.tolist(),"max":high.tolist()},
                material={"shading":"albedo"},props={"background":True,"surfaceRole":"landscape","树木名录":ref["source"],
                "树木依据":"树位、树种与树高档来自 NParks 2021 名录。航拍参考树冠色差。各树枝形、冠径与档内高度为估值。",
                "林荫道":"康乐通道两侧额外 41 株雨树，树根高度取自浏览器地表。33 株树冠按 OneMap 航拍估读纵横冠幅及偏向。",
                "道路位置":avenue["road"],
                "树形素材":"Poly Haven · Island Tree 01、Jacaranda Tree · CC0。雨树借用蓝花楹展开的分枝形态，按名录高度和估计冠宽拟合；其余树使用 Island Tree 01。"})


if __name__ == "__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tree",type=Path)
    parser.add_argument("spreading_tree", type=Path, help="Directory containing the 1k Jacaranda Tree glTF")
    args = parser.parse_args()
    entry = bake(args.tree, args.spreading_tree)
    path=ROOT/"build/streetscape.json"
    records={r["entityId"]:r for r in json.loads(path.read_text())}
    records[entry["entityId"]]=entry
    path.write_text(json.dumps(list(records.values()),ensure_ascii=False,indent=2)+"\n")
    print(entry["assetHash"])
