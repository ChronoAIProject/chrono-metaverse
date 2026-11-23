"""Project scanned broadleaf crowns into curved depth slices and export textured park stands."""
import hashlib
import json
import struct
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np
import trimesh
from PIL import Image
from scipy.ndimage import distance_transform_edt, gaussian_filter, map_coordinates, maximum_filter
from scipy.spatial import cKDTree
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals

from courtyard_tree import compact_bark

ROOT = Path(__file__).resolve().parents[1]
LAYERS, TILE = 5, 160
SOURCES = {
    "tree_small_02": "3062a709614c05b80fdc1e56583998bc3cb1027b0d52f956c8ecfb882ff8ca6d",
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


def fit_slice_opacity(pixels, surface, axes, scan):
    """Reduce opacity where the depth slice passes through an opening in the scan."""
    y, x = np.nonzero(pixels[:, :, 3])
    size = len(pixels)
    uv = np.column_stack(((x + .5) / size, 1 - (y + .5) / size))
    grid = uv * (len(surface) - 1)
    i, j = grid.astype(int).T
    a, b = (grid - grid.astype(int)).T
    # Interpolate the two triangles as the GPU does, including their shared diagonal.
    depth = (surface[i, j] * (1 - np.maximum(a, b)) + surface[i + 1, j + 1] * np.minimum(a, b)
             + surface[i + 1, j] * np.maximum(a - b, 0) + surface[i, j + 1] * np.maximum(b - a, 0))
    samples = np.empty((len(uv), 3))
    samples[:, axes] = np.column_stack((uv, depth))
    distance = scan.query(samples, distance_upper_bound=.054)[0]
    gap = np.clip((distance - .007) / .047, 0, 1)
    opacity = 1 - .92 * gap**2 * (3 - 2 * gap)
    pixels[y, x, 3] = np.rint(pixels[y, x, 3] * opacity).astype(np.uint8)


def slices(points, colors, canopy, fit_opacity=False):
    atlas = Image.new("RGBA", (TILE*LAYERS, TILE*3))
    vertices, uv, normals, faces = [], [], [], []
    scan = cKDTree(points[canopy]) if fit_opacity else None
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
            if scan is not None:
                fit_slice_opacity(pixels, surfaces[k], (u, v, depth), scan)
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


def write_tree_asset(scene, tree_postprocessor=None, *, packing_options=(), copyright=None):
    low, high = scene.bounds
    origin = (low+high)/2
    origin[1] = low[1]
    for surface in scene.geometry.values():
        surface.apply_translation(-origin)
    with TemporaryDirectory() as directory:
        source = Path(directory) / "trees.glb"
        packed = Path(directory) / "packed.glb"
        source.write_bytes(trimesh.exchange.gltf.export_glb(scene, include_normals=True,
                                                            tree_postprocessor=tree_postprocessor))
        subprocess.run(["node", str(ROOT / "node_modules/gltfpack/cli.js"),
                        "-i", str(source), "-o", str(packed), "-vp", "16", "-vt", "14",
                        "-vn", "10", "-km", "-kn", *packing_options], check=True)
        data = packed.read_bytes()
    if copyright:
        # gltfpack creates its own asset header. Attach redistribution credit to the packed GLB.
        length = struct.unpack_from("<I", data, 12)[0]
        doc = json.loads(data[20:20 + length])
        doc["asset"]["copyright"] = copyright
        header = json.dumps(doc, separators=(",", ":")).encode()
        header += b" " * (-len(header) % 4)
        chunks = data[20 + length:]
        data = struct.pack("<4sIII4s", b"glTF", 2, 20 + len(header) + len(chunks),
                           len(header), b"JSON") + header + chunks
    digest = hashlib.sha256(data).hexdigest()
    (ROOT/'assets'/(digest+'.glb')).write_bytes(data)
    return digest, {"min": low.tolist(), "max": high.tolist()}
