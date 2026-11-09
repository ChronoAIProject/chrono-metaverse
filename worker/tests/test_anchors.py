"""扫描导入 / 重新重建时给哪些物体建锚点（`handlers.scan.anchor_proposals`）。

只给有意义的物体建：桌子 → table、前台 → counter、沙发 → zone；椅子只在提示 `anchor: true` 时 → seat；
柜子、杂物、绿植、灯、立柱、圆形物件等不建。标签用物体的标签，没有就用类别的中文名。
"""

from __future__ import annotations

import pytest

from metaverse_worker import shapes as sh
from metaverse_worker.errors import PermanentJobError
from metaverse_worker.handlers.scan import anchor_proposals, grid_cover, requested_seats
from metaverse_worker.records import entity_body, validate_anchor_body


def obj(eid: str, category: str | None, x: float, z: float, size=(0.5, 0.9, 0.5), **kw) -> dict:
    """摆在 (x, z) 的盒子物体，和物体模块一样建议锚点编号 = 物件编号、类别写在 props.category。"""
    kw.setdefault("anchor_id", eid)
    return entity_body(
        entity_id=eid,
        kind="object",
        shape=sh.box(list(size), xf=sh.transform(position=[x, 0.0, z])),
        props={"category": category} if category else {},
        **kw,
    )


def scene() -> dict[str, dict]:
    """小前厅：会议桌 + 四把椅子（一把塞在桌下）、前台、沙发、柜子、杂物、绿植、灯、立柱、圆形物件。"""
    entities = {
        "table-01": obj("table-01", "table", 3.0, 3.0, (1.6, 0.75, 0.8), label="会议桌"),
        "chair-01": obj("chair-01", "chair", 2.4, 2.2, label="会议椅"),
        "chair-02": obj("chair-02", "chair", 3.6, 2.2),
        "chair-03": obj("chair-03", "chair", 2.4, 3.8, label="会议椅"),
        "chair-04": obj("chair-04", "chair", 3.5, 3.0, label="会议椅"),  # 塞在桌下
        "counter-01": obj("counter-01", "counter", 8.0, 1.0, (2.4, 1.1, 0.7), label="前台"),
        "sofa-01": obj("sofa-01", "sofa", 6.0, 6.0, (2.0, 0.8, 0.9)),
        "cabinet-01": obj("cabinet-01", "cabinet", 0.5, 6.0, (1.0, 1.8, 0.5), label="柜子"),
        "clutter-01": obj("clutter-01", "clutter", 5.0, 3.0, (0.3, 0.3, 0.3), label="杂物"),
        "plant-01": obj("plant-01", "plant", 9.0, 6.0, (0.5, 1.2, 0.5), label="绿植"),
        "lamp-01": obj("lamp-01", "lamp", 9.5, 4.0, (0.4, 1.6, 0.4), label="灯"),
        "pillar-01": obj("pillar-01", "pillar", 5.0, 8.0, (0.4, 2.8, 0.4), label="立柱"),
        "round-01": obj("round-01", "round", 1.0, 1.0, (0.6, 0.5, 0.6), label="圆形物件"),
    }
    chair = sh.box([0.5, 0.9, 0.5])
    entities["tpl-chair-01"] = entity_body(
        entity_id="tpl-chair-01", kind="template", shape=chair, label="会议椅", props={"category": "chair"}
    )
    return entities


def test_only_tables_counters_and_sofas_get_anchors_by_default():
    entities = scene()
    anchors = anchor_proposals(entities)
    assert set(anchors) == {"table-01", "counter-01", "sofa-01"}
    assert {a: b["kind"] for a, b in anchors.items()} == {
        "table-01": "table",
        "counter-01": "counter",
        "sofa-01": "zone",
    }
    # 标签用物体的标签（提示给的中文名）；沙发没有标签，用类别的中文名
    assert anchors["table-01"]["label"] == "会议桌"
    assert anchors["counter-01"]["label"] == "前台"
    assert anchors["sofa-01"]["label"] == "沙发"
    for aid, body in anchors.items():
        assert body["visibility"] == "public" and body["box"] == grid_cover(entities[aid]["bounds"])
        validate_anchor_body(body)
    # 没有提示时结果一样
    assert anchor_proposals(entities, {}) == anchors
    assert anchor_proposals(entities, {"objects": []}) == anchors


def test_chair_gets_seat_anchor_only_when_hint_asks():
    entities = scene()
    hints = {
        "objects": [
            {"center": [2.4, 0.45, 2.2], "kind": "chair", "label": "会议椅", "anchor": True},
            {"center": [3.6, 2.25], "anchor": True},  # 只给 x、z，不写 kind 也行
            {"center": [2.4, 0.45, 3.8], "kind": "chair"},  # 没要求锚点
        ]
    }
    anchors = anchor_proposals(entities, hints)
    assert set(anchors) == {"table-01", "counter-01", "sofa-01", "chair-01", "chair-02"}
    assert anchors["chair-01"]["kind"] == "seat" and anchors["chair-01"]["label"] == "会议椅"
    assert anchors["chair-02"]["kind"] == "seat" and anchors["chair-02"]["label"] == "椅子"
    validate_anchor_body(anchors["chair-01"])


@pytest.mark.parametrize(
    ("item", "expected"),
    [
        ({"center": [2.4, 0.45, 2.2], "anchor": True}, {"chair-01"}),
        ({"center": [2.4, 2.2], "kind": "Armchair", "anchor": True}, {"chair-01"}),
        ({"center": [2.4, 2.2], "kind": "stool", "anchor": True}, {"chair-01"}),
        # 中心在包围盒外 0.3 米以内也算（盒子 x 范围 2.15–2.65）
        ({"center": [2.9, 2.2], "anchor": True}, {"chair-01"}),
        ({"center": [1.8, 2.2], "anchor": True}, set()),  # 离最近的椅子 0.35 米：不算
        # 椅子塞在桌下：中心同时落在桌子和椅子的包围盒里，只在椅子里找
        ({"center": [3.5, 0.45, 3.0], "anchor": True}, {"chair-04"}),
        # 两把椅子都在 0.3 米内（离 chair-02 0.1 米、离 chair-04 0.2 米）：取离包围盒最近的
        ({"center": [3.5, 2.55], "anchor": True}, {"chair-02"}),
        # 不写 kind 时找最近的椅子，不管旁边的桌子
        ({"center": [3.0, 3.0], "anchor": True}, {"chair-04"}),
        # 不是椅子的提示、没明确要求的提示都不建
        ({"center": [3.0, 3.0], "kind": "table", "anchor": True}, set()),
        ({"center": [2.4, 2.2], "kind": "sofa", "anchor": True}, set()),
        ({"center": [2.4, 2.2], "kind": 3, "anchor": True}, set()),
        ({"center": [2.4, 2.2], "anchor": "true"}, set()),
        ({"center": [2.4, 2.2], "anchor": 1}, set()),
        ({"center": [2.4, 2.2], "anchor": False}, set()),
        ({"center": [2.4, 2.2]}, set()),
        # 中心格式不对就忽略
        ({"anchor": True}, set()),
        ({"center": [2.4], "anchor": True}, set()),
        ({"center": [2.4, 0, 2.2, 1], "anchor": True}, set()),
        ({"center": ["2.4", "2.2"], "anchor": True}, set()),
        ({"center": [True, False], "anchor": True}, set()),
        ({"center": [float("nan"), 2.2], "anchor": True}, set()),
        ({"center": [2.4, float("inf"), 2.2], "anchor": True}, set()),  # 和物体模块一样整项忽略
        ({"center": {"x": 2.4, "z": 2.2}, "anchor": True}, set()),
    ],
)
def test_requested_seats_matching(item, expected):
    assert requested_seats(scene(), {"objects": [item]}) == expected


@pytest.mark.parametrize(
    "hints",
    [
        None,
        {},
        {"objects": None},
        {"objects": "chair-01"},
        {"objects": {"center": [2.4, 2.2]}},
        {"objects": [1, "x"]},
    ],
)
def test_malformed_hints_are_ignored(hints):
    assert requested_seats(scene(), hints) == set()
    assert set(anchor_proposals(scene(), hints)) == {"table-01", "counter-01", "sofa-01"}


def test_anchor_hint_never_anchors_other_categories():
    """`anchor: true` 只对椅子起作用：柜子、杂物、绿植等就算被点名也不建。"""
    entities = scene()
    hints = {
        "objects": [
            {"center": [x, z], "anchor": True}
            for x, z in ((0.5, 6.0), (5.0, 3.0), (9.0, 6.0), (9.5, 4.0), (5.0, 8.0), (1.0, 1.0))
        ]
    }
    assert set(anchor_proposals(entities, hints)) == {"table-01", "counter-01", "sofa-01"}


def test_hint_list_is_capped():
    """提示最多看前 500 项（与物体模块一样）。"""
    filler = [{"center": [50.0, 50.0], "anchor": True}] * 500
    hints = {"objects": [*filler, {"center": [2.4, 2.2], "anchor": True}]}
    assert requested_seats(scene(), hints) == set()


def test_objects_without_category_or_anchor_id_are_skipped():
    entities = {
        # 没有类别（旧的物体模块、扩展出来的东西）：不按编号猜，不建
        "table-09": obj("table-09", None, 1.0, 1.0),
        # 没有建议锚点编号
        "table-02": obj("table-02", "table", 3.0, 1.0, anchor_id=None),
        # 保留编号（以 _ 开头）不能当锚点编号
        "table-03": obj("table-03", "table", 5.0, 1.0, anchor_id="_space"),
        # 类别不是字符串
        "table-04": {**obj("table-04", None, 7.0, 1.0), "props": {"category": ["table"]}},
        "table-05": obj("table-05", "table", 9.0, 1.0),
        # 和前一个建议了同一个锚点编号：先到先得
        "table-06": obj("table-06", "table", 11.0, 1.0, anchor_id="table-05"),
    }
    anchors = anchor_proposals(entities)
    assert set(anchors) == {"table-05"}
    assert anchors["table-05"]["box"] == grid_cover(entities["table-05"]["bounds"])


def test_blank_label_falls_back_to_category_name():
    entities = {
        "counter-01": {**obj("counter-01", "counter", 1.0, 1.0), "label": "  "},
        "table-01": obj("table-01", "table", 3.0, 1.0),
    }
    anchors = anchor_proposals(entities)
    assert anchors["counter-01"]["label"] == "前台" and anchors["table-01"]["label"] == "桌子"


def test_anchor_proposals_validate():
    table = obj("table-01", "table", 1.0, 1.0, (1.6, 0.75, 0.8), label="会议桌")
    validate_anchor_body(anchor_proposals({"table-01": table})["table-01"])
    # 绕过物件校验塞进来的控制字符：建锚点时也拦下，不写出接口服务改不动的锚点
    broken = {**table, "label": "会议桌\n"}
    with pytest.raises(PermanentJobError):
        anchor_proposals({"table-01": broken})
