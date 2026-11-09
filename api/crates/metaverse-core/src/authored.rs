//! AI 物件集（authored）的浅层校验（设计 6.3）。
//!
//! 本地的 AI 逐件完成物件（先去模型库找现成的，找不到再手写参数形状），整套交给 `scan_import` /
//! `rebuild` 任务写进重建层：
//!
//! ```json
//! { "version": 1,
//!   "templates": [ 模板物件 body（kind "template"）... ],
//!   "entities":  [ 物件 body ... ],
//!   "notes": "建模过程记录（可选，≤ 64KB）",
//!   "structure": "keep" | "replace" }
//! ```
//!
//! 接口服务收到时只同步做便宜的检查：结构和字段类型、数量（≤ 2000 个物件、≤ 200 个模板）、规范化后
//! 的大小（≤ 4MB）、地址必须是 https、烘焙指令 `bake` 只能出现在没有 `texture` 的材质里。形状、记录、
//! 模板引用、署名许可、下载和哈希核对等深层校验由处理服务做（`worker/src/metaverse_worker/authored.py`），
//! 不合格时任务失败。

use serde_json::{Map, Value};

use crate::canonical::canonical_json;
use crate::is_sha256_hex;

/// 格式版本。
pub const AUTHORED_VERSION: u64 = 1;
/// 物件集规范化后的大小上限（字节），也是 authored 用途上传的大小上限。
pub const MAX_AUTHORED_BYTES: u64 = 4 << 20;
/// 物件数上限。
pub const MAX_AUTHORED_ENTITIES: usize = 2000;
/// 模板数上限。
pub const MAX_AUTHORED_TEMPLATES: usize = 200;
/// `notes` 的 UTF-8 字节数上限。
pub const MAX_AUTHORED_NOTES_BYTES: usize = 64 << 10;
/// 烘焙指令的投影方式。
pub const BAKE_MODES: [&str; 3] = ["planar", "box", "cylindrical"];
/// 外部模型的格式。
pub const MODEL_FORMATS: [&str; 3] = ["glb", "gltf-zip", "gltf"];

const TOP_KEYS: [&str; 5] = ["version", "templates", "entities", "notes", "structure"];
const MAX_URL: usize = 2048;

/// 浅层校验不通过。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct AuthoredError(pub String);

fn invalid<T>(message: impl Into<String>) -> Result<T, AuthoredError> {
    Err(AuthoredError(message.into()))
}

/// 浅层校验通过后的统计。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AuthoredSummary {
    pub entities: usize,
    pub templates: usize,
    /// 外部模型物件（带 `model` 的）个数。
    pub models: usize,
    /// 规范化后的字节数。
    pub bytes: usize,
}

/// `https://主机/...`：不含空白和控制字符，没有用户名密码。
pub fn is_https_url(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("https://") else {
        return false;
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
    value.len() <= MAX_URL
        && !host.is_empty()
        && !host.contains('@')
        && !host.starts_with(':')
        && value.chars().all(|c| c > ' ' && c != '\u{7f}')
}

fn object<'a>(value: &'a Value, what: &str) -> Result<&'a Map<String, Value>, AuthoredError> {
    value
        .as_object()
        .ok_or_else(|| AuthoredError(format!("{what} 必须是 JSON 对象")))
}

fn entity_id<'a>(item: &'a Map<String, Value>, what: &str) -> Result<&'a str, AuthoredError> {
    match item.get("entityId").and_then(Value::as_str) {
        Some(id) if !id.is_empty() && id.len() <= 128 => Ok(id),
        _ => invalid(format!("{what} 的 entityId 必须是 1–128 个字符的字符串")),
    }
}

fn check_download(value: &Value, what: &str) -> Result<(), AuthoredError> {
    let item = object(value, what)?;
    if !item
        .get("url")
        .and_then(Value::as_str)
        .is_some_and(is_https_url)
    {
        return invalid(format!("{what}.url 必须是 https 地址"));
    }
    if !item
        .get("sha256")
        .and_then(Value::as_str)
        .is_some_and(is_sha256_hex)
    {
        return invalid(format!("{what}.sha256 必须是 64 位小写十六进制"));
    }
    if !item
        .get("size")
        .and_then(Value::as_u64)
        .is_some_and(|size| size > 0)
    {
        return invalid(format!("{what}.size 必须是正整数（字节）"));
    }
    Ok(())
}

fn check_model(value: &Value, what: &str) -> Result<(), AuthoredError> {
    check_download(value, what)?;
    let model = object(value, what)?;
    let format = model.get("format").and_then(Value::as_str);
    if !format.is_some_and(|f| MODEL_FORMATS.contains(&f)) {
        return invalid(format!("{what}.format 必须是 glb、gltf-zip 或 gltf"));
    }
    match (format, model.get("files")) {
        (Some("gltf"), Some(Value::Object(files))) if !files.is_empty() && files.len() <= 64 => {
            for (path, file) in files {
                check_download(file, &format!("{what}.files[{path:?}]"))?;
            }
            Ok(())
        }
        (Some("gltf"), _) => invalid(format!(
            "{what}.files 必须是 1–64 个 {{相对路径: {{url, sha256, size}}}}"
        )),
        (_, None) => Ok(()),
        (_, Some(_)) => invalid(format!("{what}.files 只用于 format gltf")),
    }
}

/// 递归检查形状树里的材质：`bake` 只能是三种投影之一，且只能出现在没有 `texture`、`uv` 的材质里。
fn check_materials(value: &Value, what: &str) -> Result<(), AuthoredError> {
    match value {
        Value::Object(map) => {
            if let Some(Value::Object(material)) = map.get("material") {
                if let Some(bake) = material.get("bake") {
                    if !bake.as_str().is_some_and(|b| BAKE_MODES.contains(&b)) {
                        return invalid(format!(
                            "{what} 的 material.bake 必须是 planar、box 或 cylindrical"
                        ));
                    }
                    if material.contains_key("texture") || material.contains_key("uv") {
                        return invalid(format!(
                            "{what}：bake 只能出现在没有 texture、uv 的材质里"
                        ));
                    }
                }
            }
            map.values()
                .try_for_each(|child| check_materials(child, what))
        }
        Value::Array(items) => items
            .iter()
            .try_for_each(|child| check_materials(child, what)),
        _ => Ok(()),
    }
}

fn check_body(item: &Map<String, Value>, what: &str) -> Result<(), AuthoredError> {
    if let Some(shape) = item.get("shape") {
        check_materials(shape, what)?;
    }
    if let Some(page) = item
        .get("props")
        .and_then(|props| props.get("source"))
        .and_then(|source| source.get("page"))
    {
        if !page.as_str().is_some_and(is_https_url) {
            return invalid(format!("{what} 的 props.source.page 必须是 https 地址"));
        }
    }
    Ok(())
}

/// 浅层校验（见模块说明）。
pub fn check_authored(value: &Value) -> Result<AuthoredSummary, AuthoredError> {
    let doc = object(value, "authored")?;
    if let Some(key) = doc.keys().find(|key| !TOP_KEYS.contains(&key.as_str())) {
        return invalid(format!("authored 有不认识的字段 {key}"));
    }
    if doc.get("version").and_then(Value::as_u64) != Some(AUTHORED_VERSION) {
        return invalid("authored.version 必须是 1");
    }
    let bytes = canonical_json(value)
        .map_err(|error| AuthoredError(format!("authored 无法规范化：{error}")))?
        .len();
    if bytes as u64 > MAX_AUTHORED_BYTES {
        return invalid(format!(
            "authored 规范化后有 {bytes} 字节，超过上限 {MAX_AUTHORED_BYTES}"
        ));
    }
    match doc.get("structure") {
        None | Some(Value::Null) => {}
        Some(Value::String(mode)) if mode == "keep" || mode == "replace" => {}
        Some(_) => return invalid("authored.structure 必须是 keep 或 replace"),
    }
    match doc.get("notes") {
        None | Some(Value::Null) => {}
        Some(Value::String(notes)) if notes.len() <= MAX_AUTHORED_NOTES_BYTES => {}
        Some(_) => return invalid("authored.notes 必须是不超过 64KB 的字符串"),
    }
    let templates = match doc.get("templates") {
        None | Some(Value::Null) => &[][..],
        Some(Value::Array(items)) if items.len() <= MAX_AUTHORED_TEMPLATES => items.as_slice(),
        Some(_) => {
            return invalid(format!(
                "authored.templates 必须是不超过 {MAX_AUTHORED_TEMPLATES} 个模板的数组"
            ))
        }
    };
    let entities = match doc.get("entities") {
        Some(Value::Array(items)) if !items.is_empty() && items.len() <= MAX_AUTHORED_ENTITIES => {
            items.as_slice()
        }
        _ => {
            return invalid(format!(
                "authored.entities 必须是 1–{MAX_AUTHORED_ENTITIES} 个物件的数组"
            ))
        }
    };
    for (index, template) in templates.iter().enumerate() {
        let what = format!("authored.templates[{index}]");
        let item = object(template, &what)?;
        entity_id(item, &what)?;
        if item.get("kind").and_then(Value::as_str) != Some("template") {
            return invalid(format!("{what} 的 kind 必须是 template"));
        }
        if item.get("model").is_some() {
            return invalid(format!("{what} 不能带 model（模板只能是形状）"));
        }
        check_body(item, &what)?;
    }
    let mut models = 0;
    for (index, entity) in entities.iter().enumerate() {
        let what = format!("authored.entities[{index}]");
        let item = object(entity, &what)?;
        entity_id(item, &what)?;
        match item.get("kind").and_then(Value::as_str) {
            Some("object" | "structure") => {}
            _ => return invalid(format!("{what} 的 kind 必须是 object 或 structure")),
        }
        if let Some(model) = item.get("model") {
            if item.contains_key("shape") {
                return invalid(format!("{what} 不能同时有 shape 和 model"));
            }
            check_model(model, &format!("{what}.model"))?;
            models += 1;
        } else if !item.get("shape").is_some_and(Value::is_object) {
            return invalid(format!("{what} 必须有 shape（或外部模型 model）"));
        }
        check_body(item, &what)?;
    }
    Ok(AuthoredSummary {
        entities: entities.len(),
        templates: templates.len(),
        models,
        bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sha() -> String {
        "a".repeat(64)
    }

    fn doc() -> Value {
        json!({
            "version": 1,
            "templates": [{"entityId": "chair-a", "kind": "template",
                           "shape": {"type": "box", "size": [0.5, 0.9, 0.5]}}],
            "entities": [
                {"entityId": "panel-01", "kind": "object",
                 "shape": {"type": "group", "children": [
                    {"type": "box", "size": [1, 1, 0.02], "material": {"bake": "planar", "color": [1, 2, 3]}}]}},
                {"entityId": "chair-01", "kind": "object",
                 "model": {"url": "https://dl.polyhaven.org/a.gltf", "sha256": sha(), "size": 10, "format": "gltf",
                           "files": {"a.bin": {"url": "https://dl.polyhaven.org/a.bin", "sha256": sha(), "size": 3}}},
                 "transform": {"position": [1, 0, 1]},
                 "props": {"source": {"library": "polyhaven", "page": "https://polyhaven.com/a/x"}}},
                {"entityId": "wall-01", "kind": "structure", "shape": {"type": "box", "size": [1, 1, 1]}}
            ],
            "notes": "前台用了折板",
            "structure": "replace"
        })
    }

    #[test]
    fn accepts_a_valid_document() {
        let summary = check_authored(&doc()).unwrap();
        assert_eq!(
            (summary.entities, summary.templates, summary.models),
            (3, 1, 1)
        );
        assert!(summary.bytes > 100);
    }

    #[test]
    fn rejects_shallow_problems() {
        type Mutate = fn(&mut Value);
        let cases: Vec<(Mutate, &str)> = vec![
            (|d| d["version"] = json!(2), "version"),
            (|d| d["extra"] = json!(1), "不认识的字段"),
            (|d| d["structure"] = json!("merge"), "structure"),
            (|d| d["notes"] = json!("x".repeat(64 * 1024 + 1)), "notes"),
            (|d| d["entities"] = json!([]), "entities"),
            (|d| d["templates"][0]["kind"] = json!("object"), "template"),
            (
                |d| d["entities"][0]["kind"] = json!("template"),
                "object 或 structure",
            ),
            (|d| d["entities"][0]["entityId"] = json!(""), "entityId"),
            (
                |d| {
                    d["entities"][0]["shape"]["children"][0]["material"]["texture"] =
                        json!("a".repeat(64))
                },
                "没有 texture",
            ),
            (
                |d| d["entities"][0]["shape"]["children"][0]["material"]["bake"] = json!("sphere"),
                "planar",
            ),
            (|d| d["entities"][0]["shape"] = json!(null), "必须有 shape"),
            (
                |d| d["entities"][1]["model"]["url"] = json!("http://dl.polyhaven.org/a"),
                "https",
            ),
            (
                |d| d["entities"][1]["model"]["files"]["a.bin"]["url"] = json!("ftp://x/a"),
                "https",
            ),
            (
                |d| d["entities"][1]["model"]["sha256"] = json!("ABC"),
                "sha256",
            ),
            (|d| d["entities"][1]["model"]["size"] = json!(0), "size"),
            (
                |d| d["entities"][1]["model"]["format"] = json!("fbx"),
                "format",
            ),
            (|d| d["entities"][1]["model"]["files"] = json!({}), "files"),
            (
                |d| d["entities"][1]["shape"] = json!({"type": "box"}),
                "不能同时有",
            ),
            (
                |d| d["entities"][1]["props"]["source"]["page"] = json!("polyhaven.com"),
                "page",
            ),
            (|d| d["templates"][0]["model"] = json!({}), "不能带 model"),
        ];
        for (mutate, message) in cases {
            let mut d = doc();
            mutate(&mut d);
            let error = check_authored(&d).unwrap_err();
            assert!(error.0.contains(message), "{message}: {error}");
        }
        assert!(check_authored(&json!([1])).is_err());
    }

    #[test]
    fn size_and_count_limits() {
        let mut d = doc();
        d["entities"] = Value::Array(
            (0..=MAX_AUTHORED_ENTITIES)
                .map(|i| json!({"entityId": format!("b-{i}"), "kind": "object", "shape": {"type": "box"}}))
                .collect(),
        );
        assert!(check_authored(&d).unwrap_err().0.contains("entities"));
        let mut d = doc();
        d["entities"][0]["label"] = json!("长".repeat(1_500_000));
        assert!(check_authored(&d).unwrap_err().0.contains("超过上限"));
    }

    #[test]
    fn https_urls() {
        assert!(is_https_url("https://dl.polyhaven.org/a.glb"));
        assert!(is_https_url(
            "https://huggingface.co/datasets/x/resolve/main/a.glb?download=true"
        ));
        for bad in [
            "http://x.org/a",
            "https://",
            "https:///a",
            "https://user@x.org/a",
            "https://x.org/a b",
            "https://:443/a",
        ] {
            assert!(!is_https_url(bad), "{bad}");
        }
    }
}
