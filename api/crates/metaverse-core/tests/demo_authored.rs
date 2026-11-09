//! 演示空间的前厅 AI 物件集（`infra/chrono-cd/demo/lobby-authored.json`）要能原样通过接口服务的浅层校验。
//!
//! 部署配置种子下载物件集后先做 `check_authored`，不通过就不建导入任务；浅层规则改了而物件集没跟上，
//! 线上导入就会失败。处理服务的完整校验见 `worker/tests/test_demo_authored.py`。

use std::fs;
use std::path::Path;

use metaverse_core::authored::{check_authored, MAX_AUTHORED_BYTES};
use serde_json::Value;

#[test]
fn lobby_authored_set_passes_the_shallow_checks() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../infra/chrono-cd/demo/lobby-authored.json");
    let bytes =
        fs::read(&path).unwrap_or_else(|error| panic!("读不到 {}：{error}", path.display()));
    assert!(bytes.len() as u64 <= MAX_AUTHORED_BYTES);
    let value: Value = serde_json::from_slice(&bytes).expect("物件集是 JSON");
    let summary = check_authored(&value).expect("物件集通过浅层校验");
    assert_eq!(
        (summary.entities, summary.templates, summary.models),
        (52, 1, 10)
    );
    assert!(summary.bytes as u64 <= MAX_AUTHORED_BYTES);
    assert_eq!(value["structure"], "replace");
}
