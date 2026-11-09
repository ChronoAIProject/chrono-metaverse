"""记录校验与接口服务 `metaverse-core/src/record.rs` 一致：标签不能含控制字符，锚点 body 的规则。"""

import pytest

from metaverse_worker import shapes as sh
from metaverse_worker.errors import PermanentJobError
from metaverse_worker.handlers.scan import anchor_proposals
from metaverse_worker.records import RecordError, check_label, entity_body, validate_anchor_body

BOX = sh.box([1.0, 0.75, 0.8])


@pytest.mark.parametrize("label", ["前台", "会议桌 A-3", "x" * 200, "带 不换行空格", "表情😀"])
def test_label_accepted(label):
    check_label(label)
    entity_body(entity_id="table-01", kind="object", shape=BOX, label=label)


@pytest.mark.parametrize(
    "label",
    ["x" * 201, "两行\n标签", "制表\t符", "回车\r", "\x00", "删除\x7f", "C1 控制符\x85", 12, None],
)
def test_label_rejected(label):
    with pytest.raises(RecordError):
        check_label(label)
    if isinstance(label, str):
        with pytest.raises(RecordError):
            entity_body(entity_id="table-01", kind="object", shape=BOX, label=label)


def test_anchor_body_rules():
    ok = [
        {"anchorId": "t1", "kind": "table", "box": [0, 0, 0, 10, 15, 10], "visibility": "public"},
        {"anchorId": "_space", "kind": "space", "visibility": "public"},
        {
            "anchorId": "door",
            "kind": "door",
            "position": [0.12, 0, 0],
            "visibility": "internal",
            "label": "门",
        },
    ]
    for body in ok:
        validate_anchor_body(body)
    bad = [
        {"anchorId": "_x", "kind": "table", "position": [0, 0, 0], "visibility": "public"},
        {"anchorId": "t1", "kind": "space", "visibility": "public"},
        {"anchorId": "_space", "kind": "zone", "visibility": "public"},
        {"anchorId": "t1", "kind": "table", "visibility": "public"},
        {
            "anchorId": "t1",
            "kind": "table",
            "box": [0, 0, 0, 1, 1, 1],
            "position": [0, 0, 0],
            "visibility": "public",
        },
        {"anchorId": "t1", "kind": "table", "box": [0, 0, 0, 0, 1, 1], "visibility": "public"},
        {"anchorId": "t1", "kind": "table", "box": [0, 0, 0, 1.5, 1, 1], "visibility": "public"},
        {"anchorId": "t1", "kind": "table", "position": [0, float("nan"), 0], "visibility": "public"},
        {"anchorId": "t1", "kind": "table", "position": [0, 0, 0], "visibility": "secret"},
        {"anchorId": "t1", "kind": "sofa", "position": [0, 0, 0], "visibility": "public"},
        {"anchorId": "t1", "kind": "table", "position": [0, 0, 0], "visibility": "public", "label": "a\nb"},
        {"anchorId": "t1", "kind": "table", "position": [0, 0, 0], "visibility": "public", "extra": 1},
    ]
    for body in bad:
        with pytest.raises(RecordError):
            validate_anchor_body(body)


def test_anchor_proposals_copy_label_and_validate():
    table = entity_body(entity_id="table-01", kind="object", shape=BOX, anchor_id="table-01", label="会议桌")
    anchors = anchor_proposals({"table-01": table})
    assert anchors["table-01"]["label"] == "会议桌" and anchors["table-01"]["kind"] == "table"
    validate_anchor_body(anchors["table-01"])
    # 绕过物件校验塞进来的控制字符：建锚点时也拦下，不写出接口服务改不动的锚点
    broken = {**table, "label": "会议桌\n"}
    with pytest.raises(PermanentJobError):
        anchor_proposals({"table-01": broken})
