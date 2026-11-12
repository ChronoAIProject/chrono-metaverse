import hashlib
import json

import pytest
import trimesh

from metaverse_recon.bench.cli import main


@pytest.mark.parametrize(
    "label, background", [("休息区椅子", False), ("展台装饰", False), ("远处模型", True)]
)
def test_model_import_is_an_ordinary_edit_plan_without_map_or_plot(tmp_path, label, background):
    model = tmp_path / "model.glb"
    model.write_bytes(trimesh.Scene(trimesh.creation.box(extents=[2, 4, 6])).export(file_type="glb"))
    args = [
        "content",
        "import",
        "--workspace",
        str(tmp_path),
        "--model",
        str(model),
        "--id",
        "anything",
        "--label",
        label,
        "--at",
        "10",
        "2",
        "-10",
        "--yaw",
        "90",
        "--scale",
        "2",
        "1",
        "1",
    ]
    assert main(args + (["--background"] if background else [])) == 0
    plan = json.loads((tmp_path / "work/edit.json").read_text())
    entity = plan["ops"][0]["entity"]
    assert plan["version"] == 1 and plan["ops"][0]["op"] == "placeEntity"
    assert entity["entityId"] == "anything" and entity["label"] == label
    assert entity["bounds"]["min"] == pytest.approx([7, 2, -12])
    assert entity["bounds"]["max"] == pytest.approx([13, 6, -8])
    assert "regionId" not in entity
    assert entity["props"].get("background", False) == background
    assert "oneMap" not in plan and "host" not in plan
    asset = plan["assets"][0]
    data = (tmp_path / "assets" / (asset["hash"] + ".glb")).read_bytes()
    assert hashlib.sha256(data).hexdigest() == entity["assetHash"]


def test_import_rejects_nonfinite_position_and_invalid_scale(tmp_path):
    model = tmp_path / "model.glb"
    model.write_bytes(trimesh.Scene(trimesh.creation.box()).export(file_type="glb"))
    args = [
        "content",
        "import",
        "--workspace",
        str(tmp_path),
        "--model",
        str(model),
        "--id",
        "thing",
        "--label",
        "内容",
    ]
    assert main([*args, "--at", "nan", "0", "0"]) == 2
    assert main([*args, "--scale", "0", "1", "1"]) == 2
