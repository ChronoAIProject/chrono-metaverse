import argparse
import copy
import hashlib
import io
import json

import pytest
import trimesh

from metaverse_recon.bench.cli import main
from metaverse_recon.bench.core import ReconError
from metaverse_recon.context.config import read, validate, write
from metaverse_recon.context.download import download
from metaverse_recon.context.workflow import import_model


def test_glb_import_restore_and_primary_unchanged(tmp_path):
    write(tmp_path, "metaverse.json", {"spaceId": "gallery", "plot": "exterior"})
    write(tmp_path, "space.json", {"spaceId": "gallery", "seq": 3, "plots": []})
    primary = {
        "entityId": "rb.room",
        "layer": "rebuilt",
        "kind": "object",
        "bounds": {"min": [100, 20, -80], "max": [110, 23, -60]},
    }
    write(tmp_path, "entities.json", [primary])
    model = tmp_path / "input.glb"
    model.write_bytes(trimesh.Scene(trimesh.creation.box(extents=[12, 40, 20])).export(file_type="glb"))
    args = argparse.Namespace(
        workspace=tmp_path,
        model=model,
        prefix="outside.",
        label="展馆周边",
        at=[130, -5, -90],
        yaw=90,
        attribution="测试模型",
        landmark="展馆入口",
        overview_distance=90,
    )
    import_model(args)
    artifact = read(tmp_path, "out/context/entities.json")
    entity = artifact["entities"][0]
    assert entity["regionId"] == "exterior"
    assert entity["bounds"]["min"] == pytest.approx([120, -5, -96])
    marker = entity["props"]["landmark"]
    assert marker["focusBounds"] == primary["bounds"]
    assert marker["position"] == [105, 21.5, -70]
    assert read(tmp_path, "entities.json") == [primary]
    assert (
        hashlib.sha256((tmp_path / "assets" / (entity["assetHash"] + ".glb")).read_bytes()).hexdigest()
        == entity["assetHash"]
    )
    write(tmp_path, "entities.json", [primary, entity])
    assert main(["context", "restore", "--workspace", str(tmp_path), "--prefix", "outside."]) == 0
    assert read(tmp_path, "context.json") == entity["props"]["backgroundConfig"]
    assert read(tmp_path, "out/context/entities.json")["entities"] == [entity]


@pytest.mark.parametrize(
    "change, path",
    [
        ({"version": 2}, "version"),
        ({"entityPrefix": "rb."}, "entityPrefix"),
        ({"entityPrefix": "../"}, "entityPrefix"),
    ],
)
def test_invalid_config_reports_field(change, path):
    with pytest.raises(ReconError, match=path):
        validate({"version": 1, "entityPrefix": "scene.", **change})


def test_download_cannot_write_outside_workspace(tmp_path):
    for uri in ["../escape_0.b3dm", "/escape", "https://other.invalid/model", "%2e%2e/file"]:
        with pytest.raises(ReconError):
            download(uri, tmp_path, "https://source.invalid/", {})
    assert not (tmp_path.parent / "escape_0.b3dm").exists()


def test_cache_reuses_only_matching_source_and_valid_bytes(tmp_path, monkeypatch):
    from metaverse_recon.context.cache import cached_bytes

    calls = []

    def fetch(request, timeout):
        calls.append(request.full_url)
        return io.BytesIO(request.full_url.encode())

    monkeypatch.setattr("urllib.request.urlopen", fetch)
    target = tmp_path / "same-name.png"
    first, second = "https://first.invalid/tile", "https://second.invalid/tile"
    assert cached_bytes(first, target, {}) == first.encode()
    assert cached_bytes(first, target, {}) == first.encode()
    assert calls == [first]
    assert cached_bytes(second, target, {}) == second.encode()
    target.write_bytes("损坏".encode())
    assert cached_bytes(second, target, {}) == second.encode()
    assert calls == [first, second, second]
    with pytest.raises(ReconError, match="下载超过"):
        cached_bytes(first, target, {}, limit=1)
    assert target.read_bytes() == second.encode()


def test_model_and_marker_input_must_be_finite(tmp_path):
    # 用户配置在下载前失败，不能把 NaN 写进物件范围。
    from metaverse_recon.context.config import number

    for value in [float("nan"), float("inf"), True]:
        with pytest.raises(ReconError):
            number(value, "position")


def test_config_does_not_mutate_input():
    config = {"version": 1, "entityPrefix": "scene.", "message": "背景"}
    before = copy.deepcopy(config)
    validate(config)
    assert config == before
    assert json.loads(json.dumps(config)) == config


def test_large_mesh_parts_remain_within_platform_limits_without_mutating_source():
    import numpy as np

    from metaverse_recon.content import triangle_groups

    mesh = trimesh.creation.box()
    mesh.faces = np.tile(mesh.faces, (10000, 1))
    before = mesh.vertices.copy()
    groups = triangle_groups([mesh, trimesh.creation.box()])
    assert len(groups) == 2
    assert sum(len(part.faces) for group in groups for part in group) == 120012
    assert all(sum(len(part.faces) for part in group) <= 90000 for group in groups)
    groups[0][0].apply_translation([100, 0, 0])
    assert np.array_equal(mesh.vertices, before)


@pytest.mark.parametrize(
    "label, turn, offset", [("城市展厅", 0, [100, 0, -80]), ("山间工坊", 90, [-60, 20, 120])]
)
def test_host_sections_and_marker_in_independent_workspace(tmp_path, label, turn, offset):
    import numpy as np

    from metaverse_recon.context.host import main as align
    from metaverse_recon.context.workflow import placed

    floor = {
        "entityId": "rb.surface",
        "layer": "rebuilt",
        "kind": "structure",
        "shape": {
            "type": "extrude",
            "outline": {"points": [[0, 0], [10, 0], [10, 10], [0, 10]]},
            "height": 0.1,
            "transform": {"position": offset, "yaw": turn},
        },
        "bounds": {"min": [0, 0, 0], "max": [10, 0.1, 10]},
    }
    glazing = {
        "entityId": "rb.window",
        "layer": "rebuilt",
        "kind": "structure",
        "shape": {"transform": {"yaw": 180 + turn}},
        "bounds": {"min": [0, 0, 10], "max": [10, 3, 10.1]},
    }
    for entity in [floor, glazing]:
        entity["bounds"] = placed(entity, {"yaw": turn, "translation": offset})["bounds"]
    subject_min = np.minimum(floor["bounds"]["min"], glazing["bounds"]["min"])
    subject_max = np.maximum(floor["bounds"]["max"], glazing["bounds"]["max"])
    box = (
        np.concatenate([np.floor((subject_min - 0.1) / 0.05), np.ceil((subject_max + 0.1) / 0.05)])
        .astype(int)
        .tolist()
    )
    write(tmp_path, "metaverse.json", {"spaceId": "lab", "plot": "outside"})
    write(
        tmp_path, "space.json", {"regions": [{"id": "room", "kind": "physical", "boxes": [box]}], "plots": []}
    )
    saved_background = {
        "entityId": "outside.saved",
        "layer": "ext",
        "props": {"background": True},
        "bounds": {"min": [-1000, -1000, -1000], "max": [1000, 1000, 1000]},
    }
    write(tmp_path, "entities.json", [floor, glazing, saved_background])
    model = trimesh.creation.box(extents=[30, 100, 30])
    # 模型放置在原始局部坐标，配准将它移到任意主体位置及朝向。
    model.apply_translation([0, 50, 0])
    data = trimesh.Scene(model).export(file_type="glb")
    digest = hashlib.sha256(data).hexdigest()
    (tmp_path / "assets").mkdir()
    (tmp_path / "assets" / (digest + ".glb")).write_bytes(data)
    write(
        tmp_path,
        "build/own-tower.json",
        [{"assetHash": digest, "bounds": {"min": [-15, -60, -15], "max": [15, 40, 15]}, "props": {}}],
    )
    write(tmp_path, "build/alignment.json", {"headingDegrees": 0, "officeFloor": 8, "officeHeightMeters": 60})
    config = {
        "version": 1,
        "entityPrefix": "outside.",
        "host": {
            "modelFile": "build/own-tower.json",
            "entityPrefix": "outside.host",
            "label": label,
            "levelLabel": "8层",
            "focusRegionId": "room",
            "floorEntityId": "rb.surface",
            "facadeEntityId": "rb.window",
            "sectionHeightMeters": 1.4 + offset[1],
            "facadeDirection": [0, 1],
            "facadeNormalMinDot": 0.98,
            "facadeEdgeMinLengthMeters": 3,
            "facadeInsetMeters": 0.12,
            "minimumClearanceMeters": 0.05,
            "boundaryMarginMeters": 0.02,
            "sliceOverlapMeters": 0.01,
            "overviewDistanceMeters": 80,
            "landmark": {"label": label + "入口", "offset": [0, 0, 0.08]},
            "slab": {"thicknessMeters": 0.25, "color": [145, 147, 150, 255]},
            "note": "模拟源",
        },
    }
    write(tmp_path, "context.json", config)
    before = read(tmp_path, "entities.json")
    align(tmp_path)
    placement = read(tmp_path, "build/placement.json")
    assert placement["officeContained"] and placement["minimumFacadeClearanceMeters"] > 0.05
    host = placement["hostEntities"]
    assert any(e["props"].get("backgroundView", {}).get("minDistance") == 80 for e in host)
    marker = next(e["props"]["landmark"] for e in host if "landmark" in e["props"])
    assert marker["label"] == label + "入口"
    assert marker["focusBounds"]["min"] == pytest.approx(subject_min)
    assert marker["focusBounds"]["max"] == pytest.approx(subject_max)
    assert read(tmp_path, "entities.json") == before
