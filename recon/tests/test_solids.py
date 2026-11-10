"""板（plate）、凸包（hull）和材质 opacity / unlit：校验、网格、实例覆盖材质、查看用 glb（SHAPES 第 2 节）。

跨语言向量（三角形数、包围盒、不合法的数据）在 test_shared_vectors.py 里核对，这里补边界情况。
"""

import io
import json
import struct

import numpy as np
import pytest
from PIL import Image

from metaverse_recon import shapes as sh
from metaverse_recon.processing import shape_mesh as sm
from metaverse_recon.processing.preview_glb import export_glb, gltf_image, roughness_png

SLANTED = [[0, 0, 0], [2, 0, 0], [2, 0.9, 0.3], [0, 0.9, 0.3]]
BOW = [
    [0, 0, 0],
    [0.82, 0.03, 0.11],
    [0.79, 0.62, 0.07],
    [0.04, 0.58, -0.21],
    [0.43, 0.05, 0.93],
    [0.36, 0.66, 0.84],
    [0.4, 0.3, 1.42],
]


def test_plate_frame_and_projection():
    center, normal, area = sh.plate_frame([[0, 1, 0], [0, 1, 2], [3, 1, 2], [3, 1, 0]])
    assert normal == [0.0, 1.0, 0.0] and center == [1.5, 1.0, 1.0] and area == pytest.approx(6)
    assert sh.plate_frame([[0, 0, 0], [1, 0, 0], [2, 0, 0]]) is None
    assert sh.plate_frame([[0, 0, 0]]) is None
    assert sh.plate_projection_axes([0, 0, -1]) == (0, 1)
    assert sh.plate_projection_axes([0.6, 0.6, 0.1]) == (1, 2)
    assert sh.plate_projection_axes([0.1, 0.6, 0.6]) == (0, 2)
    assert sh.segments_intersect((0, 0), (2, 2), (0, 2), (2, 0))
    assert sh.segments_intersect((0, 0), (2, 0), (1, 0), (1, 1))
    assert not sh.segments_intersect((0, 0), (1, 0), (2, 0), (3, 0))


@pytest.mark.parametrize(
    ("shape", "path"),
    [
        ({"type": "plate", "points": SLANTED, "thickness": 0}, "$.thickness"),
        ({"type": "plate", "points": SLANTED[:2], "thickness": 0.1}, "$.points"),
        ({"type": "plate", "points": [[0, 0, 0], [0, 0, 0], *SLANTED[1:]], "thickness": 0.1}, "$.points[0]"),
        (
            {
                "type": "plate",
                "points": [[0, 0, 0], [2, 0, 0], [2, 2, 0], [1, 0, 0], [0, 2, 0]],
                "thickness": 0.1,
            },
            "$.points",
        ),
        ({"type": "hull", "points": [[0, 0, 0]] * 4}, "$.points"),
        ({"type": "hull", "points": [[0, 0, 0]] * 257}, "$.points"),
        (
            {"type": "box", "size": [1, 1, 1], "material": {"color": [1, 1, 1], "opacity": -0.1}},
            "$.material.opacity",
        ),
    ],
)
def test_invalid_solids_report_paths(shape, path):
    with pytest.raises(sh.ShapeError) as error:
        sh.validate_shape(shape)
    assert error.value.path == path


@pytest.mark.parametrize(
    "shape",
    [
        {"type": "plate", "points": "x", "thickness": 0.1},
        {"type": "plate", "points": [[0, 0]], "thickness": 0.1},
        {"type": "plate", "points": SLANTED},
        {"type": "hull", "points": [[0, 0, 0, 1]]},
        {"type": "box", "size": [1, 1, 1], "material": {"color": [1, 1, 1], "unlit": "yes"}},
    ],
)
def test_malformed_solids_rejected_at_parse(shape):
    with pytest.raises(sh.ShapeError) as error:
        sh.validate_shape(shape)
    assert error.value.path is None


def test_builders_round_and_validate():
    plate = sh.plate(SLANTED, 0.020001, material=sh.color_material([200, 230, 240], opacity=0.3))
    assert plate["thickness"] == 0.02 and plate["material"] == {"color": [200, 230, 240], "opacity": 0.3}
    sh.validate_shape(plate)
    hull = sh.hull(
        BOW, xf=sh.transform(position=[1, 0, 0]), material=sh.color_material([90, 90, 96], unlit=True)
    )
    sh.validate_shape(hull)
    assert sh.shape_bounds(hull)["min"] == pytest.approx([1, 0, -0.21])
    tex = sh.texture_material("ab" * 32, "box", opacity=0.5, unlit=False)
    assert tex == {"texture": "ab" * 32, "uv": "box", "opacity": 0.5, "unlit": False}
    with pytest.raises(sh.ShapeError):
        sh.color_material([1, 2, 3], opacity=2)


def test_plate_mesh_faces_point_outward_with_natural_uvs():
    mesh = sm.plate_mesh({"type": "plate", "points": SLANTED, "thickness": 0.02})
    assert mesh.triangle_count == 12
    _, normal, _ = sh.plate_frame(SLANTED)
    middle = np.asarray([1.0, 0.45, 0.15]) - 0.01 * np.asarray(normal)
    assert ((mesh.positions - middle) * mesh.normals).sum(axis=1).min() > 0
    # 侧面的 u 沿轮廓累计到周长。
    assert mesh.uvs[:, 0].max() == pytest.approx(4 + 2 * np.hypot(0.9, 0.3))
    assert sm.plate_mesh({"type": "plate", "points": SLANTED, "thickness": 2}).triangle_count == 0


def test_hull_mesh_is_closed_and_outward():
    mesh = sm.hull_mesh({"type": "hull", "points": BOW})
    assert mesh.triangle_count == 10
    tri = mesh.triangles()
    face = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    center = np.asarray(BOW).mean(axis=0)
    assert (np.einsum("ij,ij->i", face, tri[:, 0] - center) > 0).all()
    # 封闭：体积 = Σ 有向四面体体积，与 scipy 的凸包体积相同。
    volume = np.einsum("ij,ij->i", tri[:, 0], np.cross(tri[:, 1], tri[:, 2])).sum() / 6
    from scipy.spatial import ConvexHull

    assert volume == pytest.approx(ConvexHull(np.asarray(BOW)).volume)
    assert sm.hull_mesh({"type": "hull", "points": BOW[:3]}).triangle_count == 0


def test_material_keys_and_instance_override_keep_glass():
    keys = {
        sm.material_key(m)
        for m in (
            {"color": [1, 2, 3]},
            {"color": [1, 2, 3], "opacity": 0.3},
            {"color": [1, 2, 3], "unlit": True},
            {"texture": "ab" * 32, "uv": "box"},
            {"texture": "ab" * 32, "uv": "box", "unlit": True},
        )
    }
    assert len(keys) == 5
    assert sm.material_key({"color": [1, 2, 3], "opacity": 1, "unlit": False}) == "c:1,2,3"
    templates = {
        "cabinet": sh.group(
            [
                sh.box([1, 1, 0.5], material=sh.color_material([120, 90, 60])),
                sh.plate(
                    [[-0.5, 0.1, 0.26], [0.5, 0.1, 0.26], [0.5, 0.9, 0.26], [-0.5, 0.9, 0.26]],
                    0.01,
                    material=sh.color_material([210, 230, 240], opacity=0.3),
                ),
                sh.box([0.8, 0.4, 0.02], material=sh.texture_material("cd" * 32, "planar", unlit=True)),
            ]
        )
    }
    parts = sm.build_parts(sh.instance("cabinet", material=sh.color_material([30, 60, 200])), templates)
    materials = [p.material for p in parts]
    assert {"color": [30, 60, 200]} in materials
    assert {"color": [30, 60, 200], "opacity": 0.3} in materials
    assert {"texture": "cd" * 32, "uv": "planar", "unlit": True, "tint": [30, 60, 200]} in materials
    frosted = sm.build_parts(
        sh.instance("cabinet", material=sh.color_material([255, 255, 255], opacity=0.8)), templates
    )
    assert all(p.material["opacity"] == 0.8 for p in frosted)


def _read_glb(path) -> dict:
    with open(path, "rb") as fh:
        data = fh.read()
    magic, version, total = struct.unpack("<4sII", data[:12])
    assert magic == b"glTF" and version == 2 and total == len(data)
    length, kind = struct.unpack("<I4s", data[12:20])
    assert kind == b"JSON"
    return json.loads(data[20 : 20 + length])


def test_preview_glb_writes_blend_and_unlit(tmp_path):
    entities = {
        "glass": {
            "kind": "object",
            "shape": sh.plate(SLANTED, 0.012, material=sh.color_material([200, 225, 235], opacity=0.3)),
        },
        "sign": {
            "kind": "object",
            "shape": sh.box([0.7, 0.24, 0.04], material=sh.color_material([255, 128, 84], unlit=True)),
        },
        "wedge": {"kind": "object", "shape": sh.hull(BOW, material=sh.color_material([118, 98, 84]))},
        "model-only": {"kind": "object", "assetHash": "ab" * 32},
    }
    path = tmp_path / "preview.glb"
    stats = export_glb(entities, {}, str(path), unlit=False)
    assert stats["nodes"] == 3 and stats["triangles"] == 12 + 12 + 10
    doc = _read_glb(path)
    by_color = {
        tuple(round(c, 3) for c in m["pbrMetallicRoughness"]["baseColorFactor"][:3]): m
        for m in doc["materials"]
    }
    glass = next(m for m in doc["materials"] if m.get("alphaMode") == "BLEND")
    assert glass["pbrMetallicRoughness"]["baseColorFactor"][3] == pytest.approx(0.3)
    assert glass["doubleSided"] is True
    unlit = [m for m in doc["materials"] if "extensions" in m]
    assert len(unlit) == 1 and "KHR_materials_unlit" in unlit[0]["extensions"]
    assert doc["extensionsUsed"] == ["KHR_materials_unlit"]
    assert len(by_color) == 3
    # 整份导出要求不打光时，每个材质都带扩展。
    export_glb(entities, {}, str(path))
    assert all("extensions" in m for m in _read_glb(path)["materials"])
    # 都不打光、也没有不打光的材质时，不写 extensionsUsed。
    export_glb({"wedge": entities["wedge"]}, {}, str(path), unlit=False)
    assert "extensionsUsed" not in _read_glb(path)


def test_preview_glb_tiling_normal_and_roughness_maps(tmp_path):
    """SHAPES 2"glb 导出"：平铺的材质重复采样；受光照的材质写法线贴图、粗糙度贴图（G 通道）和标量。"""

    def image(fmt: str, value: tuple[int, int, int]) -> bytes:
        out = io.BytesIO()
        Image.new("RGB", (4, 4), value).save(out, fmt)
        return out.getvalue()

    color, normal, rough = "c" * 64, "d" * 64, "e" * 64
    textures = {
        color: image("JPEG", (200, 180, 160)),
        normal: image("PNG", (128, 128, 255)),
        rough: image("WEBP", (10, 90, 200)),
    }
    maps = {"normalMap": normal, "normalScale": 0.5, "roughnessMap": rough, "roughness": 0.8}
    tiled = {"texture": color, "uv": "box", "tile": [0.5, 0.5], "shading": "albedo", **maps}
    entities = {
        "floor": {"kind": "object", "shape": sh.box([2, 0.02, 2], material=tiled)},
        "scan": {"kind": "object", "shape": sh.box([1, 1, 1], material={"texture": color, "uv": "box"})},
        "metal": {
            "kind": "object",
            "shape": sh.box([1, 1, 1], material={"color": [90, 90, 96], "metalness": 0.7}),
        },
    }
    path = tmp_path / "maps.glb"
    export_glb(entities, textures, str(path), unlit=False)
    doc = _read_glb(path)
    floor = next(m for m in doc["materials"] if "normalTexture" in m)
    pbr = floor["pbrMetallicRoughness"]
    assert pbr["roughnessFactor"] == pytest.approx(0.8) and pbr["metallicFactor"] == 0
    assert floor["normalTexture"]["scale"] == 0.5
    sampler = {i: doc["samplers"][t["sampler"]] for i, t in enumerate(doc["textures"])}
    for ref in (pbr["baseColorTexture"], floor["normalTexture"], pbr["metallicRoughnessTexture"]):
        assert sampler[ref["index"]]["wrapS"] == 10497 and sampler[ref["index"]]["wrapT"] == 10497
    # 同一张颜色贴图：平铺的和不平铺的各一个 texture，图片只嵌一次
    others = [
        m for m in doc["materials"] if m is not floor and "baseColorTexture" in m["pbrMetallicRoughness"]
    ]
    assert [sampler[m["pbrMetallicRoughness"]["baseColorTexture"]["index"]]["wrapS"] for m in others] == [
        33071
    ]
    assert len(doc["images"]) == 3 and len(doc["textures"]) == 4
    assert {img["mimeType"] for img in doc["images"]} == {"image/jpeg", "image/png"}
    metal = next(
        m for m in doc["materials"] if m["pbrMetallicRoughness"]["metallicFactor"] == pytest.approx(0.7)
    )
    assert metal["pbrMetallicRoughness"]["roughnessFactor"] == pytest.approx(0.9)
    # 粗糙度贴图：R、B 是 255，G 取原图的 G 通道；webp 转成 PNG
    with Image.open(io.BytesIO(roughness_png(textures[rough]))) as img:
        r, g, b = img.convert("RGB").getpixel((1, 1))
    assert r == 255 and b == 255 and abs(g - 90) <= 3
    data, mime = gltf_image(textures[rough])
    assert mime == "image/png" and data[:4] == b"\x89PNG"
