//! 文本类和小格式的检查（docs/design/server-slim.md 4.4）：
//!
//! - `script`：流式 UTF-8 校验（跨数据块的多字节字符要接上），不含 NUL；
//! - `obj`（扫描）：不含 NUL，第一个非空、非注释行以常见关键字开头；
//! - `drc`（扫描）：`DRACO` 魔数、版本、编码类型是三角网格；
//! - `bundle`（重建包清单）：整份读入（≤ 16 MiB），外层带类型解析，`format`、`version` 对得上、
//!   `files` 是数组；完整校验在交包时做。

use metaverse_core::bundle::{BUNDLE_FORMAT, BUNDLE_VERSION};
use serde::de::IgnoredAny;
use serde::Deserialize;

use super::Reject;

/// 流式 UTF-8 校验。
#[derive(Debug, Default)]
pub struct Utf8Stream {
    /// 上一块末尾不完整的多字节字符（最多 3 个字节）。
    carry: Vec<u8>,
    /// 已经校验过的字节数（出错时报位置）。
    offset: u64,
}

impl Utf8Stream {
    pub fn feed(&mut self, data: &[u8]) -> Result<(), Reject> {
        if data.contains(&0) {
            return Err(Reject::new("text_encoding", "文本里有 NUL 字符"));
        }
        let mut data = data;
        if !self.carry.is_empty() {
            // 先把上一块剩下的字符接完整（最多再要 3 个字节）。
            while !self.carry.is_empty() && !data.is_empty() {
                self.carry.push(data[0]);
                data = &data[1..];
                match std::str::from_utf8(&self.carry) {
                    Ok(_) => {
                        self.offset += self.carry.len() as u64;
                        self.carry.clear();
                    }
                    Err(error) if error.error_len().is_none() && self.carry.len() < 4 => {}
                    Err(_) => return Err(self.invalid()),
                }
            }
        }
        match std::str::from_utf8(data) {
            Ok(_) => self.offset += data.len() as u64,
            Err(error) if error.error_len().is_none() => {
                let valid = error.valid_up_to();
                self.offset += valid as u64;
                self.carry.extend_from_slice(&data[valid..]);
            }
            Err(error) => {
                self.offset += error.valid_up_to() as u64;
                return Err(self.invalid());
            }
        }
        Ok(())
    }

    pub fn finish(self) -> Result<(), Reject> {
        if self.carry.is_empty() {
            Ok(())
        } else {
            Err(self.invalid())
        }
    }

    fn invalid(&self) -> Reject {
        Reject::new(
            "text_encoding",
            format!("第 {} 个字节附近不是合法的 UTF-8", self.offset),
        )
    }
}

/// OBJ 的第一个关键字最多在前面多少字节里找。
const OBJ_KEYWORD_WINDOW: usize = 1 << 20;

/// OBJ：不含 NUL；第一个非空、非注释行以常见关键字开头。
#[derive(Debug, Default)]
pub struct ObjStream {
    line: Vec<u8>,
    scanned: usize,
    found: bool,
}

impl ObjStream {
    pub fn feed(&mut self, data: &[u8]) -> Result<(), Reject> {
        if data.contains(&0) {
            return Err(Reject::new("obj_header", "OBJ 文件里有 NUL 字符"));
        }
        if self.found {
            return Ok(());
        }
        for &byte in data {
            self.scanned += 1;
            if self.scanned > OBJ_KEYWORD_WINDOW {
                return Err(Reject::new(
                    "obj_header",
                    "OBJ 文件开头 1 MiB 里没有几何数据",
                ));
            }
            if byte == b'\n' || byte == b'\r' {
                if self.check_line()? {
                    self.found = true;
                    return Ok(());
                }
                self.line.clear();
            } else if self.line.len() < 256 {
                self.line.push(byte);
            }
        }
        Ok(())
    }

    /// 一行看完：`Ok(true)` 找到了关键字。
    fn check_line(&self) -> Result<bool, Reject> {
        let text = String::from_utf8_lossy(&self.line);
        let line = text.trim();
        if line.is_empty() || line.starts_with('#') {
            return Ok(false);
        }
        let keyword = line.split_whitespace().next().unwrap_or_default();
        if matches!(
            keyword,
            "v" | "vt" | "vn" | "vp" | "f" | "l" | "p" | "o" | "g" | "s" | "mtllib" | "usemtl"
        ) {
            Ok(true)
        } else {
            Err(Reject::new(
                "obj_header",
                "OBJ 文件的第一行数据不是几何关键字",
            ))
        }
    }

    pub fn finish(self) -> Result<(), Reject> {
        if self.found || self.check_line()? {
            Ok(())
        } else {
            Err(Reject::new("obj_header", "OBJ 文件里没有几何数据"))
        }
    }
}

/// Draco：`DRACO` + 主版本 + 次版本 + 编码类型（1 = 三角网格）+ 编码方法 + 标志。
#[derive(Debug, Default)]
pub struct DrcStream {
    head: Vec<u8>,
}

impl DrcStream {
    pub fn feed(&mut self, data: &[u8]) -> Result<(), Reject> {
        let room = 11usize.saturating_sub(self.head.len());
        self.head.extend_from_slice(&data[..room.min(data.len())]);
        Ok(())
    }

    pub fn finish(self) -> Result<(), Reject> {
        let head = &self.head;
        if head.len() < 11 || &head[..5] != b"DRACO" {
            return Err(Reject::new(
                "drc_header",
                "不是 Draco 文件（缺少 DRACO 魔数）",
            ));
        }
        let (major, minor) = (head[5], head[6]);
        if !(1..=2).contains(&major) {
            return Err(Reject::new(
                "drc_header",
                format!("不支持的 Draco 版本 {major}.{minor}"),
            ));
        }
        if head[7] != 1 {
            return Err(Reject::new(
                "drc_header",
                "Draco 文件不是三角网格（可能是点云）",
            ));
        }
        Ok(())
    }
}

/// 重建包清单的外层：只认三个字段，其余跳过（完整校验在交包时做）。
#[derive(Deserialize)]
struct Outer {
    format: String,
    version: u64,
    files: Vec<IgnoredAny>,
}

/// 重建包清单：整份收齐（调用方已按用途上限限制大小），完成时外层带类型解析。
#[derive(Debug)]
pub struct JsonStream {
    bytes: Vec<u8>,
    limit: u64,
}

impl JsonStream {
    pub fn new(size: u64) -> Self {
        Self {
            bytes: Vec::with_capacity(size.min(16 << 20) as usize),
            limit: size,
        }
    }

    pub fn feed(&mut self, data: &[u8]) -> Result<(), Reject> {
        if self.bytes.len() as u64 + data.len() as u64 > self.limit {
            return Err(Reject::new("json_structure", "清单比声明的大小长"));
        }
        self.bytes.extend_from_slice(data);
        Ok(())
    }

    pub fn finish(self) -> Result<(), Reject> {
        let outer: Outer = serde_json::from_slice(&self.bytes).map_err(|error| {
            Reject::new(
                "json_structure",
                format!("清单不是合法的 JSON 对象：{error}"),
            )
        })?;
        if outer.format != BUNDLE_FORMAT || outer.version != BUNDLE_VERSION {
            return Err(Reject::new(
                "json_structure",
                format!("清单的 format、version 必须是 {BUNDLE_FORMAT} 和 {BUNDLE_VERSION}"),
            ));
        }
        let _ = outer.files.len();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utf8(bytes: &[u8], step: usize) -> Result<(), Reject> {
        let mut stream = Utf8Stream::default();
        for part in bytes.chunks(step) {
            stream.feed(part)?;
        }
        stream.finish()
    }

    #[test]
    fn utf8_across_splits() {
        let text = "建造记录：前台 🪑 椅子\n".repeat(50);
        for step in [1, 2, 3, 5, 1000] {
            assert!(utf8(text.as_bytes(), step).is_ok(), "{step}");
        }
        // 截断在多字节字符中间结束。
        let cut = &text.as_bytes()[..text.len() - 2];
        assert!(utf8(cut, 7).is_err());
        assert!(utf8(b"ok\xffbad", 2).is_err());
        assert!(utf8(b"a\0b", 1).is_err());
    }

    #[test]
    fn obj_and_drc() {
        let mut obj = ObjStream::default();
        obj.feed(b"# exported\n\nmtllib a.mtl\nv 0 0 0\n").unwrap();
        assert!(obj.finish().is_ok());
        let mut html = ObjStream::default();
        assert!(html.feed(b"<html>\n").is_err());
        let mut drc = DrcStream::default();
        drc.feed(b"DRACO\x02\x02\x01\x01\x00\x00rest").unwrap();
        assert!(drc.finish().is_ok());
        let mut cloud = DrcStream::default();
        cloud.feed(b"DRACO\x02\x02\x00\x01\x00\x00").unwrap();
        assert_eq!(cloud.finish().unwrap_err().code, "drc_header");
    }

    #[test]
    fn bundle_outer() {
        let good = format!(
            r#"{{"format":"{BUNDLE_FORMAT}","version":1,"files":[{{"path":"a"}}],"note":"x"}}"#
        );
        let mut stream = JsonStream::new(good.len() as u64);
        stream.feed(good.as_bytes()).unwrap();
        assert!(stream.finish().is_ok());
        for bad in [
            r#"{"format":"other","version":1,"files":[]}"#.to_owned(),
            format!(r#"{{"format":"{BUNDLE_FORMAT}","version":2,"files":[]}}"#),
            format!(r#"{{"format":"{BUNDLE_FORMAT}","version":1,"files":{{}}}}"#),
            "[1]".to_owned(),
        ] {
            let mut stream = JsonStream::new(bad.len() as u64);
            stream.feed(bad.as_bytes()).unwrap();
            assert!(stream.finish().is_err(), "{bad}");
        }
    }
}
