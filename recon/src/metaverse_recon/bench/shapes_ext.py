"""工作台的形状辅助：在处理服务的形状词表之上处理 AI 物件集独有的烘焙指令 `bake`。

`plate`、`hull` 和材质的 `opacity`、`unlit` 是形状词表的一部分（docs/SHAPES.md），校验、包围盒和网格直接用
处理服务的实现（`shapes.py`、`processing/shape_mesh.py`），与接口服务、网站、命令行逐条对过同一批测试向量。

`bake`（`planar` | `box` | `cylindrical`）只出现在 AI 物件集里，表示"把扫描的颜色烘焙成贴图"，可以带一个
`color` 作为预览色（也是写回时采不到颜色的后备色）。规则与写回路径相同（`metaverse_recon.authored`）：
不能和 `texture`、`uv`、`tint`，以及平铺、法线、粗糙度贴图（`tile`、`offset`、`rotate`、`normalMap`、
`normalScale`、`roughnessMap`）同时出现，模板里不能写。校验和包围盒时把它换成纯色材质（保留 `opacity`、
`unlit` 等其他字段）；生成网格时材质里留着 `bake` 标记，对比图按它从扫描取色预览。
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from .. import shapes as sh
from ..authored import BAKE_EXCLUSIVE, BAKE_MODES
from ..processing import shape_mesh as sm

NEW_TYPES = ("plate", "hull")
PREVIEW_COLOR = [200, 200, 200]


def check_bake(material: Any, path: str) -> None:
    """烘焙指令本身的规则（其余材质字段交给形状词表校验）。"""
    if not isinstance(material, Mapping) or "bake" not in material:
        return
    if material["bake"] not in BAKE_MODES:
        raise sh.ShapeError(f"{path}.bake", f"bake 必须是 {'、'.join(BAKE_MODES)} 之一")
    if any(material.get(k) is not None for k in BAKE_EXCLUSIVE):
        raise sh.ShapeError(
            path, f"bake 不能和 {'、'.join(BAKE_EXCLUSIVE)} 一起出现（烘焙出的是一张按包围盒铺满的颜色贴图）"
        )


def baked_material(material: Mapping[str, Any], *, mark: bool) -> dict[str, Any]:
    """烘焙指令 → 纯色材质（`color` 没给时用预览色）；`mark` 为真时留着 `bake` 标记（生成网格用）。"""
    out = {k: v for k, v in material.items() if k not in ("bake", "color")}
    out = {"color": list(material.get("color") or PREVIEW_COLOR), **out}
    if mark:
        out["bake"] = material["bake"]
    return out


def without_bake(shape: Any, path: str = "$", *, mark: bool = False) -> Any:
    """形状的副本：带 `bake` 的材质换成纯色（先按烘焙规则检查，不合格抛 `ShapeError`）。"""
    if not isinstance(shape, Mapping):
        return shape
    out = dict(shape)
    material = out.get("material")
    if isinstance(material, Mapping) and "bake" in material:
        check_bake(material, f"{path}.material")
        out["material"] = baked_material(material, mark=mark)
    if out.get("type") == "group" and isinstance(out.get("children"), list):
        out["children"] = [
            without_bake(c, f"{path}.children[{i}]", mark=mark) for i, c in enumerate(out["children"])
        ]
    return out


def templates_without_bake(templates: Mapping[str, Any] | None) -> dict[str, Any]:
    return {k: without_bake(v) for k, v in (templates or {}).items()}


def validate_shape(shape: Any) -> None:
    sh.validate_shape(without_bake(shape))


def shape_bounds(shape: Any, templates: Mapping[str, Any] | None = None) -> sh.Bounds:
    return sh.shape_bounds(without_bake(shape), templates_without_bake(templates))


def rounded_shape_bounds(shape: Any, templates: Mapping[str, Any] | None = None) -> sh.Bounds:
    return sh.rounded_bounds(shape_bounds(shape, templates))


def lower_body(body: Mapping[str, Any]) -> dict[str, Any]:
    """物件 body 的副本：烘焙指令换成纯色，好交给 `records.validate_entity_body`。"""
    out = dict(body)
    if out.get("shape") is not None:
        out["shape"] = without_bake(out["shape"])
    return out


def lower_templates(templates: Mapping[str, Any] | None) -> dict[str, Any]:
    return templates_without_bake(templates)


def uses_ext(shape: Any) -> list[str]:
    """形状里用到的较新内容（plate、hull、opacity、unlit、bake），提示用。"""
    found: set[str] = set()

    def walk(s):
        if not isinstance(s, Mapping):
            return
        if s.get("type") in NEW_TYPES:
            found.add(s["type"])
        mat = s.get("material")
        if isinstance(mat, Mapping):
            found.update(k for k in ("opacity", "unlit", "bake") if k in mat)
        for c in s.get("children") or []:
            walk(c)

    walk(shape)
    return sorted(found)


def build_parts(shape: Mapping[str, Any], templates: Mapping[str, Any] | None = None) -> list[sm.Part]:
    """处理服务的 `shape_mesh.build_parts`；烘焙部件的材质是预览色加 `bake` 标记。"""
    return sm.build_parts(without_bake(shape, mark=True), templates_without_bake(templates))
