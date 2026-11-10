//! 旧文档往返读写不变（docs/design/server-slim.md 13.2 S1 验收）。
//!
//! 核心库给提交、任务、草稿、上传会话加了新字段和新取值（`ActorKind::Rebuild`、`JobKind::BundleImport`、
//! `ScanRef.alignment`、`Commit.bundleRef`、`Touched.scan` / `rebuiltLayer`、操作的 `ifPresent` / `ifNew`、
//! 上传用途 `webmodel` / `bundle`）。这里的文档照着现有数据写（处理服务 `jobs/writeback.py` 写的提交、
//! 接口服务发布草稿写的提交、各种任务和上传会话）：读进来再写出去必须与原文完全相同，
//! 滚动更新时新旧副本都能读写对方的文档。

use metaverse_core::model::{Commit, Draft, Job, Upload};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::{json, Value};

fn round_trip<T: Serialize + DeserializeOwned>(document: Value) {
    let parsed: T = serde_json::from_value(document.clone()).unwrap();
    assert_eq!(serde_json::to_value(&parsed).unwrap(), document);
}

fn hex(c: char) -> String {
    c.to_string().repeat(64)
}

fn owner() -> Value {
    json!({"kind": "org", "id": "52aa284c-b5b2-49bd-9d12-79f24772dbd7"})
}

/// 处理服务的任务写的提交（`actor.kind = job`，带扫描、方块表、脚本）。
#[test]
fn worker_commit() {
    round_trip::<Commit>(json!({
        "_id": "0f8e1c2b9a7d4e5f8a1b2c3d4e5f6a7b",
        "spaceId": "chronoai-lobby",
        "owner": owner(),
        "seq": 2,
        "at": "2026-11-08T12:00:00.123Z",
        "observedAt": "2026-10-20T00:00:00.000Z",
        "actor": {"sub": "system:demo-seed", "nyxServiceId": "", "scope": "physical", "kind": "job"},
        "message": "导入扫描 bfda42ee4c47（首次自动对齐，AI 物件集）",
        "changedChunks": [{"layer": "rebuilt", "cx": 0, "cy": -1, "cz": 2, "hash": hex('c')},
                          {"layer": "rebuilt", "cx": 1, "cy": 0, "cz": 0, "hash": null}],
        "changedEntities": [{"id": "wall-01", "hash": hex('e')}, {"id": "chair-a", "hash": null}],
        "changedAnchors": [{"id": "counter-01", "hash": hex('a')}],
        "paletteHash": hex('7'),
        "scan": {"assetHash": hex('1'), "webModelHashes": [hex('2'), hex('3')],
                 "transform": [0.4791, 0.0, 0.8777, 0.0, 0.0, 1.0, 0.0, 0.0, -0.8777, 0.0, 0.4791, 0.0,
                               3.25, -0.012, 7.5, 1.0]},
        "jobId": "6730a1b2c3d4e5f6a7b8c9d0",
        "scriptRef": hex('4')
    }));
}

/// 接口服务发布草稿写的提交：内联的操作（旧写法，没有 `ifPresent`、`ifNew`）。
#[test]
fn draft_commit_with_inline_ops() {
    round_trip::<Commit>(json!({
        "_id": "c-7",
        "spaceId": "restaurant",
        "owner": {"kind": "person", "id": "alice"},
        "seq": 7,
        "at": "2026-11-09T01:02:03.004Z",
        "actor": {"sub": "alice", "nyxServiceId": "svc", "scope": "plot:p1", "kind": "plot"},
        "author": {"sub": "bob"},
        "message": "摆桌椅",
        "ops": [
            {"op": "addBlock", "block": {"name": "brick", "kind": "solid", "color": [180, 60, 40], "tags": []}},
            {"op": "fill", "box": [0, 0, 0, 4, 1, 4], "block": "brick"},
            {"op": "hollowBox", "box": [0, 0, 0, 4, 4, 4], "block": 2, "thickness": 1},
            {"op": "placeEntity", "entity": {"entityId": "table-01", "layer": "ext", "kind": "object",
                "shape": {"type": "box", "size": [1.2, 0.75, 0.8], "transform": {"position": [1.0, 0.0, 1.0]}},
                "bounds": {"min": [0.4, 0.0, 0.6], "max": [1.6, 0.75, 1.4]}, "props": {"seats": 4}}},
            {"op": "removeEntity", "entityId": "old-lamp"},
            {"op": "createAnchor", "anchor": {"anchorId": "t1", "kind": "table", "box": [8, 0, 12, 32, 15, 28],
                "label": "1 号桌", "visibility": "public"}},
            {"op": "moveAnchor", "anchorId": "t1", "position": [1.0, 0.75, 1.0]},
            {"op": "updateAnchor", "anchorId": "t1", "visibility": "internal"},
            {"op": "removeAnchor", "anchorId": "t0"}
        ],
        "changedChunks": [{"layer": "ext", "cx": 0, "cy": 0, "cz": 0, "hash": hex('d')}],
        "changedEntities": [{"id": "table-01", "hash": hex('e')}, {"id": "old-lamp", "hash": null}],
        "changedAnchors": [{"id": "t1", "hash": hex('a')}, {"id": "t0", "hash": null}],
        "paletteHash": hex('b'),
        "draftId": "d-1",
        "keyframe": hex('f')
    }));
    // 操作存成资源时只放 opsRef。
    round_trip::<Commit>(json!({
        "_id": "c-8", "spaceId": "restaurant", "owner": {"kind": "person", "id": "alice"},
        "seq": 8, "at": "2026-11-09T01:02:04.000Z",
        "actor": {"sub": "alice", "nyxServiceId": "svc", "scope": "physical", "kind": "physical"},
        "message": "从上传应用操作", "opsRef": hex('9'),
        "changedChunks": [], "changedEntities": [], "changedAnchors": [], "regionsHash": hex('8')
    }));
}

/// 各种任务：处理服务下线前的种类、上传核对、从上传应用操作。
#[test]
fn job_documents() {
    let base = |kind: &str| {
        json!({
            "_id": format!("job-{kind}"), "spaceId": "chronoai-lobby", "owner": owner(),
            "kind": kind, "params": {}, "status": "queued", "attempt": 0, "maxAttempts": 3,
            "createdAt": "2026-11-08T12:00:00.000Z"
        })
    };
    for kind in [
        "upload_verify",
        "scan_import",
        "align",
        "rebuild",
        "voxelize",
        "web_model",
        "model_import",
        "ops_from_upload",
    ] {
        round_trip::<Job>(base(kind));
    }
    round_trip::<Job>(json!({
        "_id": "6730a1b2c3d4e5f6a7b8c9d0", "spaceId": "chronoai-lobby", "owner": owner(),
        "kind": "scan_import",
        "params": {"scanId": hex('1'), "rebuild": true, "voxelize": false,
                   "hints": {"objects": [{"center": [6.7, 0.6, 5.6], "label": "前台", "kind": "counter"}]},
                   "authoredAsset": hex('2')},
        "status": "failed", "leaseOwner": "worker-1", "leaseUntil": "2026-11-08T12:03:00.000Z",
        "attempt": 3, "maxAttempts": 3, "lastError": "下载失败：403",
        "createdAt": "2026-11-08T12:00:00.000Z",
        "actor": {"sub": "system:demo-seed", "nyxServiceId": ""},
        "scope": "physical",
        "result": {"needsAlignment": false, "errorCm": 0.8},
        "startedAt": "2026-11-08T12:00:01.000Z", "finishedAt": "2026-11-08T12:01:02.000Z"
    }));
    round_trip::<Job>(json!({
        "_id": "job-ops", "spaceId": "restaurant", "owner": {"kind": "person", "id": "alice"},
        "kind": "ops_from_upload", "params": {"draftId": "d-1", "assetHash": hex('9')},
        "status": "done", "attempt": 1, "maxAttempts": 1, "resultCommitId": "c-8",
        "createdAt": "2026-11-09T01:00:00.000Z", "scope": "plot:p1",
        "progress": {"opsApplied": 1200, "opsTotal": 1200}
    }));
}

/// 草稿：旧的碰过的键没有 `scan`、`rebuiltLayer`。
#[test]
fn draft_document() {
    round_trip::<Draft>(json!({
        "_id": "d-1", "spaceId": "restaurant", "owner": {"kind": "person", "id": "alice"},
        "scope": "plot:p1", "baseSeq": 6, "rev": 3, "createdBy": {"sub": "bob"},
        "ops": [{"op": "fill", "box": [0, 0, 0, 1, 1, 1], "block": 2},
                {"op": "removeEntity", "entityId": "x"}],
        "touched": {"chunks": [{"layer": "ext", "cx": 0, "cy": 0, "cz": 0}], "entities": ["x"],
                    "anchors": [], "regions": false, "plots": false, "palette": false},
        "resultChunks": [{"layer": "ext", "cx": 0, "cy": 0, "cz": 0, "hash": hex('d')}],
        "expiresAt": "2026-12-09T01:00:00.000Z"
    }));
}

/// 上传会话：旧的实体区扫描、AI 物件集的上传记录照样能读。
#[test]
fn upload_documents() {
    for (purpose, format) in [("scan", "zip"), ("authored", "json"), ("model", "glb")] {
        round_trip::<Upload>(json!({
            "_id": format!("up-{purpose}"), "spaceId": "chronoai-lobby", "owner": owner(),
            "scope": "physical", "purpose": purpose, "declaredFormat": format,
            "status": "done", "size": 5901234, "sha256": hex('5'),
            "partSize": 8388608, "partCount": 1,
            "parts": {"0": {"size": 5901234, "sha256": hex('6')}},
            "headerChecked": true,
            "actor": {"sub": "system:demo-seed", "nyxServiceId": ""},
            "createdAt": "2026-11-08T12:00:00.000Z", "updatedAt": "2026-11-08T12:00:05.000Z",
            "completedAt": "2026-11-08T12:00:04.000Z", "jobId": "job-verify",
            "assetHash": hex('5'), "format": format, "contentType": "application/octet-stream",
            "verifiedAt": "2026-11-08T12:00:05.000Z", "verifiedSha256": hex('5')
        }));
    }
}
