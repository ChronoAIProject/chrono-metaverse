//! 事件数据的 JSON Schema 校验（设计 5.3、5.4），用 `boon`（纯 Rust，正则是线性时间的
//! `regex`，没有回溯爆炸）。
//!
//! - 默认按 draft 2020-12；schema 里可以用 `$schema` 指定 draft-04/06/07/2019-09；
//! - **不加载任何外部资源**：`$ref` 只能指向 schema 自身（`#/$defs/...`），指向文件或网络的
//!   一律编译失败（boon 默认会读本地文件，这里换成一律拒绝的加载器）；
//! - schema 自身最多 16KB（规范化 JSON）。
//!
//! boon 的编译器不是 `Send`，所以编译和校验都放在同步函数里，不跨 `await`。

use std::error::Error;

use boon::{Compiler, Draft, SchemaIndex, Schemas, UrlLoader};
use serde_json::Value;

/// schema 规范化后的最大字节数。
pub const MAX_SCHEMA_BYTES: usize = 16 * 1024;
const SCHEMA_URL: &str = "urn:chrono-metaverse:event-schema";

struct NoExternalResources;

impl UrlLoader for NoExternalResources {
    fn load(&self, url: &str) -> Result<Value, Box<dyn Error>> {
        Err(format!("不允许引用外部资源：{url}").into())
    }
}

/// 编译好的一个 schema。
pub struct CompiledSchema {
    schemas: Schemas,
    index: SchemaIndex,
}

impl CompiledSchema {
    pub fn compile(schema: &Value) -> Result<Self, String> {
        let canonical = metaverse_core::canonical::canonical_json(schema)
            .map_err(|error| format!("schema 不是合法的 JSON：{error}"))?;
        if canonical.len() > MAX_SCHEMA_BYTES {
            return Err(format!("schema 超过 {MAX_SCHEMA_BYTES} 字节"));
        }
        if !matches!(schema, Value::Object(_) | Value::Bool(_)) {
            return Err("schema 必须是对象或布尔值".into());
        }
        let mut compiler = Compiler::new();
        compiler.set_default_draft(Draft::V2020_12);
        compiler.use_loader(Box::new(NoExternalResources));
        compiler
            .add_resource(SCHEMA_URL, schema.clone())
            .map_err(|error| format!("schema 不可用：{error}"))?;
        let mut schemas = Schemas::new();
        let index = compiler
            .compile(SCHEMA_URL, &mut schemas)
            .map_err(|error| format!("schema 编译失败：{error}"))?;
        Ok(Self { schemas, index })
    }

    /// 校验一份数据；失败时返回简短的原因（最多 300 个字符）。
    pub fn validate(&self, value: &Value) -> Result<(), String> {
        self.schemas.validate(value, self.index).map_err(|error| {
            let text = format!("{error}");
            text.chars().take(300).collect()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validates_by_draft_2020_12() {
        let schema = CompiledSchema::compile(&json!({
            "type": "object",
            "properties": {"guests": {"type": "integer", "minimum": 0}},
            "required": ["guests"],
            "additionalProperties": false
        }))
        .unwrap();
        assert!(schema.validate(&json!({"guests": 2})).is_ok());
        assert!(schema.validate(&json!({"guests": -1})).is_err());
        assert!(schema.validate(&json!({"guests": 2, "x": 1})).is_err());
        assert!(schema.validate(&json!({})).is_err());
    }

    #[test]
    fn local_refs_work_but_external_ones_are_refused() {
        let local = CompiledSchema::compile(&json!({
            "$defs": {"n": {"type": "number"}},
            "type": "object",
            "properties": {"a": {"$ref": "#/$defs/n"}}
        }))
        .unwrap();
        assert!(local.validate(&json!({"a": 1})).is_ok());
        assert!(local.validate(&json!({"a": "x"})).is_err());
        for target in [
            "file:///etc/passwd",
            "https://example.com/schema.json",
            "other.json",
        ] {
            assert!(
                CompiledSchema::compile(&json!({"$ref": target})).is_err(),
                "{target}"
            );
        }
    }

    #[test]
    fn rejects_bad_schemas() {
        assert!(CompiledSchema::compile(&json!({"type": "nonsense"})).is_err());
        assert!(CompiledSchema::compile(&json!([1, 2])).is_err());
        let huge = json!({"description": "x".repeat(MAX_SCHEMA_BYTES)});
        assert!(CompiledSchema::compile(&huge).is_err());
        assert!(CompiledSchema::compile(&json!(true)).is_ok());
    }
}
