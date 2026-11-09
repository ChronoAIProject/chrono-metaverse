"""形状材质的平铺、着色、法线与粗糙度（docs/SHAPES.md 第 2 节）：校验、资源引用、贴图坐标、分组和覆盖。

跨语言的合法、不合法写法和贴图坐标由 `test_shared_vectors.py` 读向量核对；这里补向量没覆盖到的：错误路径、
网格生成的米版本自然坐标（放样、矩形截面扫掠、倒角盒子）、模板实例的覆盖、物件集里的烘焙搭配和待定贴图。
"""

import numpy as np
import pytest

from metaverse_worker import shapes as sh
from metaverse_worker.authored import shape_textures
from metaverse_worker.errors import PermanentJobError
from metaverse_worker.processing import shape_mesh as sm
from metaverse_worker.processing.authored_build import resolve_textures
from metaverse_worker.records import RecordError, entity_body

TEXTURE, NORMAL, ROUGH = "a" * 64, "b" * 64, "c" * 64


def _box(material):
    return {"type": "box", "size": [1, 1, 1], "material": material}


@pytest.mark.parametrize(
    ("material", "path"),
    [
        ({"texture": TEXTURE, "uv": "box", "roughnessMap": "C" * 64}, "$.material.roughnessMap"),
        ({"color": [1, 2, 3], "uv": "box", "roughnessMap": ROUGH, "tint": [1, 1, 1]}, "$.material"),
        ({"color": [1, 2, 3], "roughnessMap": ROUGH}, "$.material"),
        ({"color": [1, 2, 3], "uv": "box"}, "$.material"),
        ({"texture": TEXTURE, "uv": "box", "tile": [-1, 1]}, "$.material.tile"),
        ({"texture": TEXTURE, "uv": "box", "tile": [1, 1], "rotate": -360.5}, "$.material.rotate"),
        ({"texture": TEXTURE, "uv": "box", "tile": [1, 1], "offset": [0, -1001]}, "$.material.offset"),
        ({"texture": TEXTURE, "uv": "box", "offset": [0, 0]}, "$.material.offset"),
        (
            {"texture": TEXTURE, "uv": "box", "normalMap": NORMAL, "normalScale": -0.1},
            "$.material.normalScale",
        ),
        ({"texture": TEXTURE, "uv": "box", "normalScale": 1}, "$.material.normalScale"),
        ({"color": [1, 2, 3], "metalness": 1.5}, "$.material.metalness"),
        ({"color": [1, 2, 3], "tile": [1, 1]}, "$.material.tile"),
    ],
)
def test_material_errors_point_at_the_field(material, path):
    """路径与 Rust `Material::validate` 相同（接口服务的错误说明里给的就是它）。"""
    with pytest.raises(sh.ShapeError) as error:
        sh.validate_shape(_box(material))
    assert error.value.path == path


@pytest.mark.parametrize(
    "material",
    [
        {
            "texture": TEXTURE,
            "uv": "box",
            "normalMap": {"url": "https://x.org/n.png", "sha256": NORMAL, "size": 1},
        },
        {"color": [1, 2, 3], "shading": "unlit"},
        {"texture": TEXTURE, "uv": "box", "tile": [1, 1, 1]},
        {"texture": TEXTURE, "uv": "box", "tile": [1, "1"]},
        {"texture": TEXTURE, "uv": "box", "tile": [1, 1], "rotate": True},
        {"color": [1, 2, 3], "normal_map": NORMAL, "uv": "box"},
    ],
)
def test_material_parse_errors(material):
    """类型不对、外链对象、不认识的字段：解析阶段就拒绝（路径为空，对应 Rust 的反序列化错误）。"""
    with pytest.raises(sh.ShapeError) as error:
        sh.validate_shape(_box(material))
    assert error.value.path is None


def test_valid_materials_and_texture_references():
    for material in (
        {"color": [1, 2, 3], "uv": "planar", "roughnessMap": ROUGH, "tile": [1, 1], "rotate": 360},
        {"color": [1, 2, 3], "uv": "box", "normalMap": NORMAL, "normalScale": 0},
        {"texture": TEXTURE, "uv": "mesh", "tile": [0.001, 100], "offset": [1000, -1000], "rotate": -360},
        {"color": [1, 2, 3], "roughness": 0, "metalness": 1, "shading": "baked"},
        {"texture": TEXTURE, "uv": "box", "unlit": True, "shading": "albedo", "roughness": 1},
    ):
        sh.validate_shape(_box(material))
    assert sh.material_textures({"texture": TEXTURE, "normalMap": NORMAL, "roughnessMap": ROUGH}) == [
        TEXTURE,
        NORMAL,
        ROUGH,
    ]
    assert sh.material_textures({"color": [1, 2, 3]}) == []
    assert sh.material_textures(None) == []
    tree = sh.group(
        [
            _box({"texture": TEXTURE, "uv": "box", "roughnessMap": ROUGH}),
            sh.group([_box({"color": [1, 2, 3], "uv": "box", "normalMap": NORMAL})]),
        ]
    )
    assert shape_textures(tree) == {TEXTURE, NORMAL, ROUGH}


def test_model_material_shading():
    def model(material):
        return entity_body(
            entity_id="sofa-01",
            kind="object",
            asset_hash=TEXTURE,
            material=material,
            bounds={"min": [0, 0, 0], "max": [1, 1, 1]},
        )

    for shading in ("baked", "albedo"):
        assert model({"shading": shading})["material"] == {"shading": shading}
    for bad in ({"shading": "pbr"}, {"shading": "Albedo"}, {"tile": [1, 1]}, {"normalMap": NORMAL}):
        with pytest.raises(RecordError):
            model(bad)


# ---------------------------------------------------------------------------- 贴图坐标


def _side_meters(mesh, skip_axis: int):
    keep = np.abs(mesh.normals[:, skip_axis]) < 0.99
    return mesh.meter_uvs()[keep]


def test_loft_meters_are_arc_length_and_height_from_first_section():
    def square(half):
        return {"points": [[-half, -half], [half, -half], [half, half], [-half, half]]}

    mesh = sm.loft_mesh(
        {
            "type": "loft",
            "sections": [{"y": 0.2, "outline": square(0.5)}, {"y": 1.2, "outline": square(0.25)}],
        }
    )
    side = _side_meters(mesh, 1)
    assert side[:, 0].max() == pytest.approx(4)  # 底截面周长 4 米
    assert side[:, 1].min() == pytest.approx(0) and side[:, 1].max() == pytest.approx(1)
    # 不给 tile 时的自然坐标不变：u 在 0–1，v 按首末截面归一化
    natural = mesh.uvs[np.abs(mesh.normals[:, 1]) < 0.99]
    assert natural[:, 0].max() == pytest.approx(1) and natural[:, 1].max() == pytest.approx(1)


def test_rect_sweep_meters_follow_the_section_edges():
    mesh = sm.sweep_mesh(
        {"type": "sweep", "path": [[0, 0, 0], [2, 0, 0]], "section": {"rect": [0.4, 0.1]}, "caps": False}
    )
    assert sorted({round(float(u), 6) for u in mesh.meter_uvs()[:, 0]}) == [0, 0.1, 0.5, 0.6, 1.0]
    assert mesh.meter_uvs()[:, 1].max() == pytest.approx(2)
    capped = sm.sweep_mesh({"type": "sweep", "path": [[0, 0, 0], [1, 0, 0]], "section": {"circle": 0.1}})
    caps = np.abs(capped.normals[:, 0]) > 0.99
    assert np.abs(capped.meter_uvs()[caps]).max() == pytest.approx(0.1)
    assert capped.uvs[caps].min() == pytest.approx(0.4)


def test_meters_survive_chamfer_transform_and_merge():
    chamfered = sm.box_mesh({"type": "box", "size": [2, 1, 0.5], "chamfer": 0.05})
    assert chamfered.meters is not None and len(chamfered.meters) == len(chamfered.uvs)
    assert chamfered.meters.max() == pytest.approx(2)
    moved = sm.apply_matrix(chamfered, sm.transform_matrix({"position": [1, 0, 0], "yaw": 30}))
    assert moved.meters is chamfered.meters
    extrude = sm.extrude_mesh(
        {"type": "extrude", "outline": {"points": [[0, 0], [1, 0], [0, 1]]}, "height": 1}
    )
    assert extrude.meters is None  # 挤出的自然坐标本来就是米
    merged = sm.merge_meshes([chamfered, extrude])
    assert merged.meters is not None and len(merged.meters) == len(merged.uvs)
    assert np.array_equal(merged.meters[len(chamfered.uvs) :], extrude.uvs)


def test_projection_without_tile_is_unchanged_and_tiling_order():
    mesh = sm.box_mesh({"type": "box", "size": [2, 1, 0.5]})
    plain = sm.project_uvs(mesh, "box")
    with_material = sm.project_uvs(mesh, "box", None, {"texture": TEXTURE, "uv": "box"})
    assert np.array_equal(plain.uvs, with_material.uvs)
    assert sm.project_uvs(mesh, "mesh", None, {"texture": TEXTURE, "uv": "mesh"}) is mesh
    st = np.array([[1.0, 0.0], [0.0, 2.0]])
    material = {"tile": [0.5, 2], "offset": [1, 0], "rotate": 90}
    # (1+1, 0) 转 90° → (0, −2) → (0, −1)；(0+1, 2) → (2, −1) → (4, −0.5)
    assert sm.tiled_uvs(st, material).tolist() == [[0, -1], [4, -0.5]]
    assert sm.exact_sin_cos(-90) == (-1.0, 0.0) and sm.exact_sin_cos(540) == (0.0, -1.0)
    assert sm.uv_mode({"color": [1, 2, 3]}) == "mesh"
    assert sm.uv_mode({"color": [1, 2, 3], "uv": "planar", "normalMap": NORMAL}) == "planar"
    assert sm.uv_mode({"texture": TEXTURE}) == "box"


def test_material_key_and_instance_override_keep_new_fields():
    assert sm.material_key({"texture": TEXTURE, "uv": "box"}) == f"t:{TEXTURE}:"
    keys = {
        sm.material_key(m)
        for m in (
            {"texture": TEXTURE, "uv": "box"},
            {"texture": TEXTURE, "uv": "box", "tile": [1, 1]},
            {"texture": TEXTURE, "uv": "box", "tile": [1, 1], "shading": "albedo"},
            {"texture": TEXTURE, "uv": "box", "normalMap": NORMAL},
            {"color": [1, 2, 3], "uv": "box", "roughnessMap": ROUGH},
            {"color": [1, 2, 3]},
        )
    }
    assert len(keys) == 6
    templates = {
        "chair": _box(
            {"color": [9, 9, 9], "uv": "box", "tile": [0.5, 0.5], "normalMap": NORMAL, "roughness": 0.6}
        )
    }
    (part,) = sm.build_parts(
        {"type": "instance", "template": "chair", "material": {"color": [200, 10, 10], "opacity": 0.5}},
        templates,
    )
    assert part.material == {
        "color": [200, 10, 10],
        "uv": "box",
        "tile": [0.5, 0.5],
        "normalMap": NORMAL,
        "roughness": 0.6,
        "opacity": 0.5,
    }
    # 颜色材质带法线贴图：按它自己的 uv 投影并平铺（盒子 2 米宽、每 0.5 米重复一次 → u 到 4）
    (tiled,) = sm.build_parts(
        {
            "type": "box",
            "size": [2, 1, 0.5],
            "material": {"color": [1, 2, 3], "uv": "planar", "tile": [0.5, 0.5], "normalMap": NORMAL},
        }
    )
    assert tiled.mesh.uvs[:, 0].max() == pytest.approx(4)


# ---------------------------------------------------------------------------- 物件集的待定贴图


def _authored(material):
    return {
        "templates": {},
        "entities": {"panel-01": {"entityId": "panel-01", "kind": "object", "shape": _box(material)}},
    }


def test_pending_normal_and_roughness_maps_have_no_fallback():
    authored = _authored({"texture": TEXTURE, "uv": "box", "normalMap": NORMAL, "roughnessMap": ROUGH})
    used, replaced = resolve_textures(authored, {NORMAL}, {}, {NORMAL: b"png"})
    assert used == {NORMAL: b"png"} and replaced == []
    for material in (
        {"texture": TEXTURE, "uv": "box", "normalMap": NORMAL},
        {"color": [1, 2, 3], "uv": "box", "roughnessMap": NORMAL},
    ):
        with pytest.raises(PermanentJobError, match="不是本空间的贴图资源"):
            resolve_textures(_authored(material), {NORMAL}, {}, {})
