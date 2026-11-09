"""`scan_import` 和 `rebuild`（设计 6.2、6.3、5.2）。

**scan_import** `{assetHash, observedAt?, transform?, rebuild?: true, voxelize?: false, hints?: {...}}`：

1. 选对齐方式：给了 `transform` 就直接用；没给时，这个扫描以前提交过就沿用它最近一次的变换；空间还没有
   坐标系（`frame`）就首次自动对齐；否则和参考扫描（`frame.referenceScan` 最近一次提交的变换）配准；
2. 子进程里：读取 → 解析前检查 → 对齐 → 网页用模型两档 → 结构 + 物体重建（`rebuild: false` 时跳过）；
3. 重扫配准误差超过阈值：不提交，任务完成，`result = {needsAlignment: true, proposedTransform, errorCm, …}`；
4. 事务外登记资源（网页用模型、贴图）和物件、锚点记录（按内容哈希幂等）；
5. 一次提交：`scan = {assetHash, webModelHashes, transform}`、`observedAt`、重建层物件替换（扩展层不动）、
   新锚点、资源引用（只登记网页用模型和贴图，原始扫描不登记）；首次扫描固定坐标系；`voxelize: true` 时
   在同一个事务里插入一个 `voxelize` 任务（编号 `<本任务编号>-voxelize`）。

**重建层替换**：物体重建正常运行时，重建层的全部旧物件（结构、物体、模板）换成这次的结果；物体重建模块
导入失败、只交了结构时，只替换重建层的结构物件，旧的物体保留（不会因为模块缺失把物体删光）。

**rebuild** `{scanAssetHash?, hints?}`：对指定扫描（默认最新扫描）用它最近一次提交的变换重跑结构 + 物体
重建并提交（不重新生成网页用模型）。指定的不是当前扫描时，提交里带上这个扫描的引用，让扫描层和重建层一致。
结果与当前状态完全相同时不提交，任务直接完成（`result.unchanged = true`）。
"""

from __future__ import annotations

import logging
import math
from collections.abc import Mapping
from typing import Any

from ..assets import put_asset
from ..chunk import GRID_UNIT
from ..errors import PermanentJobError
from ..ids import is_object_id
from ..jobs.lease import mark_done
from ..jobs.writeback import (
    CommitPlan,
    current_anchor_ids,
    current_entity_ids,
    diff_ids,
    head_scan,
    put_anchor_records,
    put_entity_records,
    scan_commit,
    write_back,
)
from ..processing.align import matrix_from_params
from ..processing.rebuild import OBJECTS_TARGET as DEFAULT_OBJECTS_TARGET
from ..processing.scan import sniff_format
from ..processing.sniff import CONTENT_TYPES
from ..records import RecordError, validate_anchor_body
from ..timeutil import format_ts, parse_ts
from .context import JobContext, optional_dict, require_hash

log = logging.getLogger(__name__)

# 物体重建函数（'模块:函数'）。测试里换成假实现。
OBJECTS_TARGET: str | None = DEFAULT_OBJECTS_TARGET

ANCHOR_KINDS = {
    "table": "table",
    "desk": "table",
    "seat": "seat",
    "chair": "seat",
    "sofa": "seat",
    "bench": "seat",
    "stool": "seat",
    "door": "door",
    "camera": "camera",
    "counter": "counter",
    "reception": "counter",
    "bar": "counter",
}


# ---------------------------------------------------------------------------- 小工具


def physical_boxes(space: Mapping[str, Any]) -> list[list[int]]:
    out: list[list[int]] = []
    for region in space.get("regions") or []:
        if region.get("kind") == "physical":
            out.extend([int(v) for v in box] for box in region.get("boxes") or [] if len(box) == 6)
    return out


def _snap(value: float) -> float:
    r = round(value)
    return r if abs(value - r) < 1e-6 else value


def grid_cover(bounds: Mapping[str, Any]) -> list[int]:
    """米制包围盒 → 覆盖它的格子盒子（半开区间），与接口服务 `Aabb::grid_cover` 相同。"""
    lo = [math.floor(_snap(v / GRID_UNIT)) for v in bounds["min"]]
    hi = [math.ceil(_snap(v / GRID_UNIT)) for v in bounds["max"]]
    hi = [max(h, low + 1) for low, h in zip(lo, hi, strict=True)]
    return [*lo, *hi]


def anchor_kind(anchor_id: str) -> str:
    head = anchor_id.lower().split("-")[0].split("_")[0].rstrip("0123456789")
    return ANCHOR_KINDS.get(head, "zone")


def anchor_proposals(entities: Mapping[str, Mapping[str, Any]]) -> dict[str, dict[str, Any]]:
    """带建议锚点编号的物体 → 锚点 body（`box` = 物体包围盒覆盖的格子，`visibility: public`）。"""
    out: dict[str, dict[str, Any]] = {}
    for eid in sorted(entities):
        body = entities[eid]
        aid = body.get("anchorId")
        if body.get("kind") != "object" or not is_object_id(aid) or aid.startswith("_") or aid in out:
            continue
        anchor: dict[str, Any] = {
            "anchorId": aid,
            "kind": anchor_kind(aid),
            "box": grid_cover(body["bounds"]),
            "visibility": "public",
        }
        if isinstance(body.get("label"), str):
            anchor["label"] = body["label"]
        try:
            validate_anchor_body(anchor)  # 与接口服务 AnchorBody 同样的规则，之后草稿才改得动它
        except RecordError as error:
            raise PermanentJobError(f"物体 {eid} 的建议锚点 {aid} 不合法：{error}") from error
        out[aid] = anchor
    return out


def normalize_observed_at(value: Any) -> str | None:
    if value is None:
        return None
    try:
        return format_ts(parse_ts(value))
    except (TypeError, ValueError) as error:
        raise PermanentJobError("参数 observedAt 必须是 RFC 3339 时间") from error


def _texture_content_type(data: bytes) -> str:
    fmt = sniff_format(data[:64])
    return CONTENT_TYPES.get(fmt or "", "application/octet-stream")


def _space(ctx: JobContext) -> dict[str, Any]:
    space = ctx.store.spaces.find_one(ctx.lease.scope.space_filter())
    if space is None:
        raise PermanentJobError(f"空间 {ctx.lease.space_id} 不存在，或主人与任务记录不一致")
    return space


def _register_rebuild(ctx: JobContext, rebuilt: Mapping[str, Any]) -> dict[str, Any]:
    """事务外：登记贴图资源、物件记录、锚点记录。返回写提交要用的东西。"""
    scope = ctx.lease.scope
    textures = []
    for sha, data in sorted(rebuilt["textures"].items()):
        info = put_asset(
            ctx.store, data, content_type=_texture_content_type(data), kind="texture", space_id=scope.space_id
        )
        if info.hash != sha:
            raise PermanentJobError(f"贴图 {sha} 的内容与哈希不符")
        textures.append(sha)
    bodies = rebuilt["entities"]
    hashes = put_entity_records(ctx.store, scope, bodies)
    anchors = anchor_proposals(bodies)
    anchor_hashes = put_anchor_records(ctx.store, scope, anchors)
    return {
        "bodies": bodies,
        "hashes": hashes,
        "textures": textures,
        "anchors": anchors,
        "anchor_hashes": anchor_hashes,
        "structure_only": bool(rebuilt.get("objectsSkipped")),
    }


def _entity_changes(ctx: JobContext, reg: Mapping[str, Any], session) -> tuple[list, dict, list, dict]:
    """事务内：按最新状态算重建层物件的变化和要新建的锚点（已存在的锚点不动）。"""
    scope = ctx.lease.scope
    kind = "structure" if reg["structure_only"] else None
    old = current_entity_ids(ctx.store, scope, layer="rebuilt", kind=kind, session=session)
    changed = diff_ids(old, reg["hashes"])
    bodies = {c["id"]: reg["bodies"][c["id"]] for c in changed if c["hash"] is not None}
    existing = current_anchor_ids(ctx.store, scope, session=session)
    new_anchors = [{"id": a, "hash": h} for a, h in sorted(reg["anchor_hashes"].items()) if a not in existing]
    anchor_bodies = {c["id"]: reg["anchors"][c["id"]] for c in new_anchors}
    return changed, bodies, new_anchors, anchor_bodies


def _rebuild_summary(rebuilt: Mapping[str, Any], changed: list, anchors: list) -> dict[str, Any]:
    metrics = rebuilt.get("metrics") or {}
    return {
        "structure": metrics.get("structure"),
        "objects": metrics.get("objects"),
        "entities": {
            "structure": len(rebuilt.get("structureIds") or []),
            "objects": len(rebuilt.get("objectIds") or []),
            "changed": sum(1 for c in changed if c["hash"] is not None),
            "removed": sum(1 for c in changed if c["hash"] is None),
        },
        "anchorsCreated": [a["id"] for a in anchors],
    }


# ---------------------------------------------------------------------------- scan_import


def run_import(ctx: JobContext) -> dict[str, Any]:
    params = ctx.params
    store, scope, config = ctx.store, ctx.lease.scope, ctx.config
    asset_hash = require_hash(params, "assetHash")
    given = params.get("transform")
    if given is not None:
        matrix_from_params(given)  # 先在父进程里校验，不合法直接失败
    observed_at = normalize_observed_at(params.get("observedAt"))
    do_rebuild = params.get("rebuild", True) is not False
    do_voxelize = params.get("voxelize") is True
    hints = optional_dict(params, "hints")
    space = _space(ctx)

    transform, method, reference = given, "given", None
    if transform is None:
        previous = scan_commit(store, scope, asset_hash)
        if previous is not None:
            transform, method = list(previous["scan"]["transform"]), "reused"
        elif space.get("frame"):
            ref_hash = (space.get("frame") or {}).get("referenceScan")
            ref_commit = scan_commit(store, scope, ref_hash) if ref_hash else None
            ref_commit = ref_commit or scan_commit(store, scope)
            if ref_commit is not None:
                ref_scan = ref_commit["scan"]
                reference = {
                    "path": ctx.download(ref_scan["assetHash"], "reference.bin", config.max_scan_bytes),
                    "transform": list(ref_scan["transform"]),
                    "assetHash": ref_scan["assetHash"],
                }
            else:
                log.warning("空间 %s 有坐标系但没有扫描提交，按首次扫描自动对齐", scope.space_id)
    scan_path = ctx.download(asset_hash, "scan.bin", config.max_scan_bytes)
    out = ctx.compute(
        "metaverse_worker.processing.tasks:scan_task",
        scan_path=scan_path,
        workdir=ctx.workdir,
        limits=ctx.limits(),
        transform=transform,
        transform_method=method,
        reference={k: reference[k] for k in ("path", "transform")} if reference else None,
        web_models=True,
        do_rebuild=do_rebuild,
        hints=hints,
        physical_boxes=physical_boxes(space),
        objects_target=OBJECTS_TARGET,
        align_max_error_cm=config.align_max_error_cm,
    )
    if out.get("needsAlignment"):
        result = {
            "needsAlignment": True,
            "scanAssetHash": asset_hash,
            "referenceScan": reference["assetHash"] if reference else None,
            "proposedTransform": out["proposedTransform"],
            "errorCm": out["errorCm"],
            "maxErrorCm": config.align_max_error_cm,
            "alignment": out.get("alignment"),
            "candidates": out.get("candidates"),
            "timings": out.get("timings"),
        }
        mark_done(store, ctx.lease, result=result)
        log.warning("扫描 %s 配准误差 %.2f 厘米超过阈值，不提交，等人工确认", asset_hash, out["errorCm"])
        return result
    ctx.check_cancel()

    web_models = []
    for model in out["webModels"]:
        info = put_asset(
            store, model["path"], content_type="model/gltf-binary", kind="web_model", space_id=scope.space_id
        )
        web_models.append({"hash": info.hash, **{k: v for k, v in model.items() if k != "path"}})
    web_hashes = [m["hash"] for m in web_models]
    reg = _register_rebuild(ctx, out["rebuild"]) if do_rebuild else None
    scan_ref = {"assetHash": asset_hash, "webModelHashes": web_hashes, "transform": out["transform"]}
    voxelize_job_id = f"{ctx.lease.job_id}-voxelize" if do_voxelize else None
    result: dict[str, Any] = {
        "scanAssetHash": asset_hash,
        "transform": out["transform"],
        "alignment": out.get("alignment"),
        "webModels": web_models,
        "scan": out.get("scan"),
        "timings": out.get("timings"),
    }
    if voxelize_job_id:
        result["voxelizeJobId"] = voxelize_job_id

    def build(session, space_doc) -> CommitPlan:
        plan = CommitPlan(
            message=f"导入扫描 {asset_hash[:12]}（{_METHOD_TEXT.get(_method(out), '对齐')}）",
            scan=scan_ref,
            observed_at=observed_at,
            # 资源引用表就是公开资源接口的白名单（设计 8.2）：只登记网页要用的网页用模型和贴图，
            # 原始扫描不登记，只能经 /api/v1 下载；它靠提交里的 scan.assetHash 免于被清理。
            asset_refs=list(web_hashes),
            reference_scan=asset_hash,
            result=dict(result),
        )
        if reg is not None:
            changed, bodies, anchors, anchor_bodies = _entity_changes(ctx, reg, session)
            plan.changed_entities = changed
            plan.entity_bodies = bodies
            plan.changed_anchors = anchors
            plan.anchor_bodies = anchor_bodies
            plan.asset_refs += reg["textures"]
            plan.result.update(_rebuild_summary(out["rebuild"], changed, anchors))
        if voxelize_job_id:
            plan.new_jobs = [
                {"_id": voxelize_job_id, "kind": "voxelize", "params": {"scanAssetHash": asset_hash}}
            ]
        return plan

    commit = write_back(store, ctx.lease, build)
    return {"commitId": commit.commit_id, "seq": commit.seq, **result}


_METHOD_TEXT = {"given": "指定变换", "reused": "沿用变换", "auto": "首次自动对齐", "registered": "重扫配准"}


def _method(out: Mapping[str, Any]) -> str:
    return str((out.get("alignment") or {}).get("method") or "")


# ---------------------------------------------------------------------------- rebuild


def run_rebuild(ctx: JobContext) -> dict[str, Any]:
    params = ctx.params
    store, scope, config = ctx.store, ctx.lease.scope, ctx.config
    target = require_hash(params, "scanAssetHash", optional=True)
    hints = optional_dict(params, "hints")
    space = _space(ctx)
    commit = scan_commit(store, scope, target)
    if commit is None:
        raise PermanentJobError("空间还没有导入扫描" if target is None else f"空间里没有扫描 {target}")
    scan_ref = dict(commit["scan"])
    asset_hash = scan_ref["assetHash"]
    current = head_scan(store, scope) or {}
    scan_path = ctx.download(asset_hash, "scan.bin", config.max_scan_bytes)
    out = ctx.compute(
        "metaverse_worker.processing.tasks:scan_task",
        scan_path=scan_path,
        workdir=ctx.workdir,
        limits=ctx.limits(),
        transform=list(scan_ref["transform"]),
        transform_method="reused",
        web_models=False,
        do_rebuild=True,
        hints=hints,
        physical_boxes=physical_boxes(space),
        objects_target=OBJECTS_TARGET,
    )
    ctx.check_cancel()
    reg = _register_rebuild(ctx, out["rebuild"])
    switch_scan = current.get("assetHash") != asset_hash
    result: dict[str, Any] = {"scanAssetHash": asset_hash, "timings": out.get("timings")}

    # 先在事务外看一眼：完全没变就不提交
    changed, _, anchors, _ = _entity_changes(ctx, reg, None)
    if not changed and not anchors and not switch_scan:
        result.update(_rebuild_summary(out["rebuild"], changed, anchors), unchanged=True)
        mark_done(store, ctx.lease, result=result)
        return result

    def build(session, space_doc) -> CommitPlan:
        changed, bodies, anchors, anchor_bodies = _entity_changes(ctx, reg, session)
        plan = CommitPlan(
            message=f"重新重建扫描 {asset_hash[:12]}",
            changed_entities=changed,
            entity_bodies=bodies,
            changed_anchors=anchors,
            anchor_bodies=anchor_bodies,
            asset_refs=list(reg["textures"]),
            result={**result, **_rebuild_summary(out["rebuild"], changed, anchors)},
        )
        if switch_scan:
            plan.scan = {
                "assetHash": asset_hash,
                "webModelHashes": list(scan_ref.get("webModelHashes") or []),
                "transform": list(scan_ref["transform"]),
            }
        return plan

    commit_result = write_back(store, ctx.lease, build)
    return {"commitId": commit_result.commit_id, "seq": commit_result.seq, **result}
