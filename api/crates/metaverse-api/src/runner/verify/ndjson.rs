//! 操作文件（NDJSON，可 gzip）的流式读取（docs/design/server-slim.md 4.4、4.10）。
//!
//! 按数据块顺序喂入原始字节：gzip 的边解压边分行，不留压缩原文，也不留解压后的全文；每行
//! ≤ 64 KiB、UTF-8，解压后合计 ≤ 256 MiB。每一行交给调用方的回调：上传核对只看"去掉空白后以
//! `{` 开头"（完整解析在追加时做），`ops_from_upload` 在回调里逐行解析成操作。空行跳过。
//!
//! gzip 只认一个成员，成员结束后还有数据就拒绝（追加时的解析也只读第一个成员，二者一致）。

use std::io::Write;

use flate2::write::GzDecoder;
use metaverse_core::limits::{MAX_OPS_INFLATED_BYTES, MAX_RECORD_BYTES};

use super::Reject;

/// 每一行交给谁：参数是行号（从 1 开始）和去掉首尾空白后的内容（不为空）。
pub trait LineSink {
    fn line(&mut self, number: usize, text: &str) -> Result<(), Reject>;
}

impl<F: FnMut(usize, &str) -> Result<(), Reject>> LineSink for F {
    fn line(&mut self, number: usize, text: &str) -> Result<(), Reject> {
        self(number, text)
    }
}

/// 上传核对用：每行去掉空白后以 `{` 开头（完整解析在追加时做）。
#[derive(Debug, Default, Clone, Copy)]
pub struct CheckLines;

impl LineSink for CheckLines {
    fn line(&mut self, number: usize, text: &str) -> Result<(), Reject> {
        check_line(number, text)
    }
}

/// 分行、计数的那一层。
struct Lines<F> {
    on_line: F,
    line: Vec<u8>,
    number: usize,
    total: u64,
    max_total: u64,
    /// 回调或上限报的错（gzip 那一层只能传回 `io::Error`，原因存在这里）。
    error: Option<Reject>,
}

impl<F: LineSink> Lines<F> {
    fn push(&mut self, data: &[u8]) -> Result<(), Reject> {
        self.total += data.len() as u64;
        if self.total > self.max_total {
            return Err(Reject::new(
                "ndjson_too_large",
                format!("操作文件解压后超过 {} 字节", self.max_total),
            ));
        }
        let mut rest = data;
        while let Some(end) = rest.iter().position(|b| *b == b'\n') {
            self.extend(&rest[..end])?;
            self.emit()?;
            rest = &rest[end + 1..];
        }
        self.extend(rest)
    }

    fn extend(&mut self, part: &[u8]) -> Result<(), Reject> {
        if self.line.len() + part.len() > MAX_RECORD_BYTES {
            return Err(Reject::new(
                "ndjson_line",
                format!("第 {} 行超过 {MAX_RECORD_BYTES} 字节", self.number + 1),
            ));
        }
        self.line.extend_from_slice(part);
        Ok(())
    }

    fn emit(&mut self) -> Result<(), Reject> {
        self.number += 1;
        let number = self.number;
        let text = std::str::from_utf8(&self.line)
            .map_err(|_| Reject::new("ndjson_line", format!("第 {number} 行不是合法的 UTF-8")))?;
        let text = text.trim();
        if !text.is_empty() {
            self.on_line.line(number, text)?;
        }
        self.line.clear();
        Ok(())
    }

    fn finish(&mut self) -> Result<(), Reject> {
        if !self.line.is_empty() {
            self.emit()?;
        }
        Ok(())
    }
}

/// 把 [`Lines`] 包成 `Write`，给 gzip 解压器用。
struct Sink<F>(Lines<F>);

impl<F: LineSink> Write for Sink<F> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if self.0.error.is_some() {
            return Err(std::io::Error::other("已经出错"));
        }
        match self.0.push(buf) {
            Ok(()) => Ok(buf.len()),
            Err(reject) => {
                self.0.error = Some(reject);
                Err(std::io::Error::other("行不合格"))
            }
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

enum Inner<F: LineSink> {
    /// 还没看到前两个字节，不知道是不是 gzip。
    Pending(Option<Lines<F>>, Vec<u8>),
    Plain(Lines<F>),
    Gzip(Box<GzDecoder<Sink<F>>>),
}

/// 流式的 NDJSON 读取。
pub struct NdjsonStream<F: LineSink> {
    inner: Inner<F>,
    /// 声明的格式是不是 gzip（为空时按魔数判断，例如追加时读已登记的文件）。
    expect_gzip: Option<bool>,
}

fn gzip_error<F>(sink: &mut Sink<F>) -> Reject {
    sink.0
        .error
        .take()
        .unwrap_or_else(|| Reject::new("gzip", "gzip 数据无法解压"))
}

impl<F: LineSink> NdjsonStream<F> {
    /// `expect_gzip`：上传时声明的格式（`gzip` 或 `ndjson`），与魔数不符就拒绝；为空时按魔数判断。
    pub fn new(expect_gzip: Option<bool>, on_line: F) -> Self {
        Self::with_limit(expect_gzip, MAX_OPS_INFLATED_BYTES, on_line)
    }

    pub fn with_limit(expect_gzip: Option<bool>, max_total: u64, on_line: F) -> Self {
        Self {
            inner: Inner::Pending(
                Some(Lines {
                    on_line,
                    line: Vec::new(),
                    number: 0,
                    total: 0,
                    max_total,
                    error: None,
                }),
                Vec::new(),
            ),
            expect_gzip,
        }
    }

    pub fn feed(&mut self, data: &[u8]) -> Result<(), Reject> {
        if let Inner::Pending(lines, head) = &mut self.inner {
            head.extend_from_slice(data);
            if head.len() < 2 {
                return Ok(());
            }
            let gzip = head.starts_with(&[0x1f, 0x8b]);
            if let Some(expected) = self.expect_gzip {
                if expected != gzip {
                    return Err(Reject::new(
                        "format_mismatch",
                        if expected {
                            "声明的是 gzip，文件却没有 gzip 头"
                        } else {
                            "声明的是 ndjson，文件却是 gzip 压缩的"
                        },
                    ));
                }
            }
            let lines = lines.take().expect("待定状态总有分行器");
            let head = std::mem::take(head);
            self.inner = if gzip {
                Inner::Gzip(Box::new(GzDecoder::new(Sink(lines))))
            } else {
                Inner::Plain(lines)
            };
            return self.feed_inner(&head);
        }
        self.feed_inner(data)
    }

    fn feed_inner(&mut self, data: &[u8]) -> Result<(), Reject> {
        match &mut self.inner {
            Inner::Pending(..) => unreachable!("已经确定了格式"),
            Inner::Plain(lines) => lines.push(data),
            Inner::Gzip(decoder) => {
                let mut rest = data;
                while !rest.is_empty() {
                    match decoder.write(rest) {
                        Ok(0) => {
                            return Err(Reject::new(
                                "gzip",
                                "gzip 数据结束之后还有多余的字节（只接受一个 gzip 成员）",
                            ))
                        }
                        Ok(n) => rest = &rest[n..],
                        Err(_) => return Err(gzip_error(decoder.get_mut())),
                    }
                }
                Ok(())
            }
        }
    }

    /// 接收行的那一方（边读边取走已经解析出的内容）。
    pub fn sink_mut(&mut self) -> &mut F {
        match &mut self.inner {
            Inner::Pending(lines, _) => &mut lines.as_mut().expect("待定状态总有分行器").on_line,
            Inner::Plain(lines) => &mut lines.on_line,
            Inner::Gzip(decoder) => &mut decoder.get_mut().0.on_line,
        }
    }

    /// 全部字节都喂完了：处理最后一行（可以没有换行），返回接收行的那一方。
    pub fn finish(self) -> Result<F, Reject> {
        let expect_gzip = self.expect_gzip;
        match self.inner {
            Inner::Pending(lines, head) => {
                // 不到 2 个字节的文件：只能是不压缩的。
                if expect_gzip == Some(true) {
                    return Err(Reject::new(
                        "format_mismatch",
                        "声明的是 gzip，文件却没有 gzip 头",
                    ));
                }
                let mut lines = lines.expect("待定状态总有分行器");
                lines.push(&head)?;
                lines.finish()?;
                Ok(lines.on_line)
            }
            Inner::Plain(mut lines) => {
                lines.finish()?;
                Ok(lines.on_line)
            }
            Inner::Gzip(mut decoder) => {
                // 解压器要看到完整的结尾（CRC 和长度）才算结束。
                if decoder.try_finish().is_err() {
                    return Err(gzip_error(decoder.get_mut()));
                }
                match decoder.finish() {
                    Ok(Sink(mut lines)) => {
                        lines.finish()?;
                        Ok(lines.on_line)
                    }
                    Err(_) => Err(Reject::new("gzip", "gzip 数据不完整")),
                }
            }
        }
    }
}

/// 上传核对用：每行去掉空白后以 `{` 开头。
pub fn check_line(number: usize, text: &str) -> Result<(), Reject> {
    if text.starts_with('{') {
        Ok(())
    } else {
        Err(Reject::new(
            "ndjson_line",
            format!("第 {number} 行不是 JSON 对象"),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::GzEncoder;

    fn gzip(bytes: &[u8]) -> Vec<u8> {
        let mut encoder = GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    }

    fn lines(bytes: &[u8], step: usize, gz: Option<bool>) -> Result<Vec<String>, Reject> {
        let mut seen = Vec::new();
        let mut stream = NdjsonStream::new(gz, |_n: usize, text: &str| -> Result<(), Reject> {
            check_line(0, text)?;
            seen.push(text.to_owned());
            Ok(())
        });
        for part in bytes.chunks(step) {
            stream.feed(part)?;
        }
        let _ = stream.finish()?;
        Ok(seen)
    }

    #[test]
    fn plain_and_gzip_across_splits() {
        let text = "{\"op\":\"a\"}\n\n  {\"op\":\"b\"}\r\n{\"op\":\"c\"}";
        for step in [1, 2, 5, 4096] {
            assert_eq!(lines(text.as_bytes(), step, Some(false)).unwrap().len(), 3);
            assert_eq!(
                lines(&gzip(text.as_bytes()), step, Some(true))
                    .unwrap()
                    .len(),
                3
            );
            assert_eq!(lines(&gzip(text.as_bytes()), step, None).unwrap().len(), 3);
        }
    }

    #[test]
    fn rejections() {
        assert_eq!(lines(b"[1]\n", 4, None).unwrap_err().code, "ndjson_line");
        let long = format!("{{\"x\":\"{}\"}}\n", "a".repeat(MAX_RECORD_BYTES));
        assert_eq!(
            lines(long.as_bytes(), 4096, None).unwrap_err().code,
            "ndjson_line"
        );
        assert_eq!(
            lines(&gzip(b"{}\n"), 3, Some(false)).unwrap_err().code,
            "format_mismatch"
        );
        assert_eq!(
            lines(b"{}\n", 3, Some(true)).unwrap_err().code,
            "format_mismatch"
        );
        // gzip 被截断、成员后面还有数据。
        let packed = gzip(b"{}\n{}\n");
        assert_eq!(
            lines(&packed[..packed.len() - 4], 3, None)
                .unwrap_err()
                .code,
            "gzip"
        );
        let mut doubled = packed.clone();
        doubled.extend_from_slice(&packed);
        assert_eq!(lines(&doubled, 7, None).unwrap_err().code, "gzip");
        // 解压后的上限。
        let mut stream =
            NdjsonStream::with_limit(None, 8, |_n: usize, _t: &str| -> Result<(), Reject> {
                Ok(())
            });
        assert_eq!(
            stream.feed(b"{\"a\":1}\n{}").unwrap_err().code,
            "ndjson_too_large"
        );
    }
}
