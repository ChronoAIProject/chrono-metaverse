//! 图片头（docs/design/server-slim.md 4.4、4.5 第 5 步）：不解码图片，只读宽高。
//!
//! - PNG：签名后第一个块必须是 `IHDR`，读宽高；
//! - JPEG：从 `SOI` 起按段长度逐段跳过（EXIF、ICC、XMP 段多长都行，跨数据块接着走），直到
//!   `SOF0`–`SOF2` 拿宽高；先遇到扫描数据（`SOS`）、图片结束（`EOI`）或别的编码方式（无损、算术编码）
//!   就拒绝，走完这张图的范围还没找到也拒绝；
//! - WebP：`RIFF....WEBP` 之后读 `VP8 `、`VP8L`、`VP8X` 的头。
//!
//! [`ImageProbe`] 是流式的：按顺序喂入这张图的字节，宽高确定以后其余字节直接跳过，所以 glb 里的
//! 图片和单独上传的贴图用同一个解析器，内存只有几十个字节。第 0 片的文件头检查
//! （`ingest/formats.rs`）也用它：第 0 片里找不到宽高就留给后台核对。

use super::Reject;

/// 图片格式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageKind {
    Png,
    Jpeg,
    Webp,
}

impl ImageKind {
    pub fn mime(self) -> &'static str {
        match self {
            ImageKind::Png => "image/png",
            ImageKind::Jpeg => "image/jpeg",
            ImageKind::Webp => "image/webp",
        }
    }

    pub fn from_mime(mime: &str) -> Option<Self> {
        match mime {
            "image/png" => Some(ImageKind::Png),
            "image/jpeg" => Some(ImageKind::Jpeg),
            "image/webp" => Some(ImageKind::Webp),
            _ => None,
        }
    }
}

/// 读出的宽高。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImageInfo {
    pub kind: ImageKind,
    pub width: u32,
    pub height: u32,
}

/// 按魔数判断格式（至少要 12 个字节；不认识时为空）。
pub fn sniff(head: &[u8]) -> Option<ImageKind> {
    if head.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(ImageKind::Png)
    } else if head.starts_with(&[0xff, 0xd8, 0xff]) {
        Some(ImageKind::Jpeg)
    } else if head.len() >= 12 && &head[..4] == b"RIFF" && &head[8..12] == b"WEBP" {
        Some(ImageKind::Webp)
    } else {
        None
    }
}

/// JPEG 逐段走的状态。
#[derive(Debug, Clone, Copy)]
enum Jpeg {
    /// 等下一个标记的 `0xFF`。
    Marker,
    /// 已读到 `0xFF`，等标记字节（连续的 `0xFF` 是填充）。
    MarkerByte,
    /// 读段长度（2 字节，含长度本身）。
    Length {
        marker: u8,
        high: Option<u8>,
    },
    /// 跳过段的其余字节。
    Skip(u64),
    /// SOF 段：长度 2 + 精度 1 + 高 2 + 宽 2，收齐 7 个字节。
    Sof {
        buffer: [u8; 7],
        filled: usize,
    },
    Done,
}

/// 流式的图片头解析器。
#[derive(Debug, Clone)]
pub struct ImageProbe {
    /// 期望的格式（glb 里按 `mimeType`、贴图上传按声明的格式）；为空时按魔数判断。
    expected: Option<ImageKind>,
    head: Vec<u8>,
    kind: Option<ImageKind>,
    jpeg: Jpeg,
    /// 已喂入的字节数。
    seen: u64,
    info: Option<ImageInfo>,
}

/// 收集文件头的长度：PNG 要 24 字节、WebP 要 30 字节。
const HEAD_BYTES: usize = 32;

fn reject(code: &'static str, message: impl Into<String>) -> Reject {
    Reject::new(code, message)
}

impl ImageProbe {
    pub fn new(expected: Option<ImageKind>) -> Self {
        Self {
            expected,
            head: Vec::with_capacity(HEAD_BYTES),
            kind: None,
            jpeg: Jpeg::Marker,
            seen: 0,
            info: None,
        }
    }

    /// 宽高已经确定（其余字节不用再看）。
    pub fn is_done(&self) -> bool {
        self.info.is_some()
    }

    pub fn info(&self) -> Option<ImageInfo> {
        self.info
    }

    /// 按顺序喂入这张图的字节。
    pub fn feed(&mut self, mut data: &[u8]) -> Result<(), Reject> {
        if self.info.is_some() || data.is_empty() {
            self.seen += data.len() as u64;
            return Ok(());
        }
        // 文件头：先凑够判断格式和读 PNG、WebP 宽高需要的字节。
        if self.kind.is_none() || self.kind != Some(ImageKind::Jpeg) {
            let room = HEAD_BYTES.saturating_sub(self.head.len());
            let take = room.min(data.len());
            self.head.extend_from_slice(&data[..take]);
            self.seen += take as u64;
            data = &data[take..];
            if self.kind.is_none() && self.head.len() >= 12 {
                self.identify()?;
            }
            match self.kind {
                Some(ImageKind::Png) if self.head.len() >= 24 => self.png()?,
                Some(ImageKind::Webp) if self.head.len() >= 30 => self.webp()?,
                Some(ImageKind::Jpeg) => {
                    // 头里已经收的字节（跳过 SOI）也要按段走一遍。
                    let head = std::mem::take(&mut self.head);
                    self.jpeg_walk(&head[2..])?;
                }
                _ => {}
            }
            if self.info.is_some() {
                self.seen += data.len() as u64;
                return Ok(());
            }
        }
        if self.kind == Some(ImageKind::Jpeg) && !data.is_empty() {
            self.seen += data.len() as u64;
            self.jpeg_walk(data)?;
        }
        Ok(())
    }

    /// 这张图的字节都喂完了。宽高还没确定就拒绝。
    pub fn finish(mut self) -> Result<ImageInfo, Reject> {
        if self.info.is_none() && self.kind.is_none() && self.head.len() >= 3 {
            // 不到 12 个字节的文件：只能按前几个字节判断。
            self.identify()?;
        }
        if let Some(info) = self.info {
            return Ok(info);
        }
        Err(match self.kind {
            Some(ImageKind::Jpeg) => reject(
                "jpeg_no_sof",
                "JPEG 里找不到宽高（SOF0–SOF2 段），或者文件不完整",
            ),
            Some(_) => reject("image_header", "图片头不完整，读不出宽高"),
            None => reject("image_header", "不是 PNG、JPEG 或 WebP 图片"),
        })
    }

    /// 只看第 0 片的结果：`Ok(Some)` 读出了宽高，`Ok(None)` 格式对但宽高在后面（留给后台核对）。
    pub fn partial(&self) -> Option<ImageInfo> {
        self.info
    }

    fn identify(&mut self) -> Result<(), Reject> {
        let kind = sniff(&self.head)
            .ok_or_else(|| reject("image_header", "不是 PNG、JPEG 或 WebP 图片"))?;
        if let Some(expected) = self.expected {
            if expected != kind {
                return Err(reject(
                    "image_mime_mismatch",
                    format!(
                        "图片的实际格式是 {}，与声明的 {} 不符",
                        kind.mime(),
                        expected.mime()
                    ),
                ));
            }
        }
        self.kind = Some(kind);
        Ok(())
    }

    fn png(&mut self) -> Result<(), Reject> {
        let head = &self.head;
        if &head[12..16] != b"IHDR" || head[8..12] != [0, 0, 0, 13] {
            return Err(reject("image_header", "PNG 的第一个块不是 IHDR"));
        }
        let width = u32::from_be_bytes([head[16], head[17], head[18], head[19]]);
        let height = u32::from_be_bytes([head[20], head[21], head[22], head[23]]);
        self.done(ImageKind::Png, width, height)
    }

    fn webp(&mut self) -> Result<(), Reject> {
        let head = &self.head;
        let (width, height) = match &head[12..16] {
            b"VP8X" => (
                1 + u32::from_le_bytes([head[24], head[25], head[26], 0]),
                1 + u32::from_le_bytes([head[27], head[28], head[29], 0]),
            ),
            b"VP8L" => {
                if head[20] != 0x2f {
                    return Err(reject("image_header", "WebP 无损格式的签名不对"));
                }
                let bits = u32::from_le_bytes([head[21], head[22], head[23], head[24]]);
                (1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff))
            }
            b"VP8 " => {
                if head[23..26] != [0x9d, 0x01, 0x2a] {
                    return Err(reject("image_header", "WebP 有损格式的起始码不对"));
                }
                (
                    u32::from(u16::from_le_bytes([head[26], head[27]]) & 0x3fff),
                    u32::from(u16::from_le_bytes([head[28], head[29]]) & 0x3fff),
                )
            }
            _ => return Err(reject("image_header", "WebP 里没有 VP8、VP8L 或 VP8X 块")),
        };
        self.done(ImageKind::Webp, width, height)
    }

    fn done(&mut self, kind: ImageKind, width: u32, height: u32) -> Result<(), Reject> {
        if width == 0 || height == 0 {
            return Err(reject("image_header", "图片的宽或高是 0"));
        }
        self.info = Some(ImageInfo {
            kind,
            width,
            height,
        });
        Ok(())
    }

    /// JPEG：按段走（`data` 接在已经走过的字节之后；第一次调用时已去掉 `SOI`）。
    fn jpeg_walk(&mut self, mut data: &[u8]) -> Result<(), Reject> {
        while !data.is_empty() {
            match self.jpeg {
                Jpeg::Done => return Ok(()),
                Jpeg::Skip(left) => {
                    let step = left.min(data.len() as u64);
                    data = &data[step as usize..];
                    self.jpeg = if left == step {
                        Jpeg::Marker
                    } else {
                        Jpeg::Skip(left - step)
                    };
                }
                Jpeg::Marker => {
                    if data[0] != 0xff {
                        return Err(reject("image_header", "JPEG 的段之间不是标记"));
                    }
                    data = &data[1..];
                    self.jpeg = Jpeg::MarkerByte;
                }
                Jpeg::MarkerByte => {
                    let marker = data[0];
                    data = &data[1..];
                    self.jpeg = match marker {
                        // 填充。
                        0xff => Jpeg::MarkerByte,
                        // 没有长度的标记。
                        0x01 | 0xd0..=0xd7 => Jpeg::Marker,
                        0xd8 => return Err(reject("image_header", "JPEG 里出现了第二个 SOI")),
                        0xd9 | 0xda => {
                            return Err(reject(
                                "jpeg_no_sof",
                                "JPEG 在宽高（SOF 段）之前就开始了图像数据或结束了",
                            ))
                        }
                        0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf => {
                            return Err(reject(
                                "jpeg_unsupported",
                                "JPEG 用了浏览器普遍不支持的编码（无损、分层或算术编码）",
                            ))
                        }
                        0xc0..=0xc2 => Jpeg::Sof {
                            buffer: [0; 7],
                            filled: 0,
                        },
                        _ => Jpeg::Length { marker, high: None },
                    };
                }
                Jpeg::Length { marker, high } => {
                    let byte = data[0];
                    data = &data[1..];
                    match high {
                        None => {
                            self.jpeg = Jpeg::Length {
                                marker,
                                high: Some(byte),
                            }
                        }
                        Some(high) => {
                            let length = u16::from_be_bytes([high, byte]);
                            if length < 2 {
                                return Err(reject("image_header", "JPEG 段长度不对"));
                            }
                            self.jpeg = if length == 2 {
                                Jpeg::Marker
                            } else {
                                Jpeg::Skip(u64::from(length) - 2)
                            };
                        }
                    }
                }
                Jpeg::Sof {
                    mut buffer,
                    mut filled,
                } => {
                    let take = (7 - filled).min(data.len());
                    buffer[filled..filled + take].copy_from_slice(&data[..take]);
                    filled += take;
                    data = &data[take..];
                    if filled < 7 {
                        self.jpeg = Jpeg::Sof { buffer, filled };
                        continue;
                    }
                    let length = u16::from_be_bytes([buffer[0], buffer[1]]);
                    if length < 8 {
                        return Err(reject("image_header", "JPEG 的 SOF 段长度不对"));
                    }
                    let height = u32::from(u16::from_be_bytes([buffer[3], buffer[4]]));
                    let width = u32::from(u16::from_be_bytes([buffer[5], buffer[6]]));
                    self.jpeg = Jpeg::Done;
                    self.done(ImageKind::Jpeg, width, height)?;
                    return Ok(());
                }
            }
        }
        Ok(())
    }

    /// 已喂入的字节数。
    pub fn seen(&self) -> u64 {
        self.seen
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&[8, 2, 0, 0, 0, 0, 0, 0, 0]);
        bytes
    }

    fn jpeg(width: u16, height: u16, app_len: usize) -> Vec<u8> {
        let mut bytes = vec![0xff, 0xd8];
        // APP1（EXIF）段：长度字段最多 65535，长段拆成几个。
        let mut left = app_len;
        while left > 0 {
            let body = left.min(65533);
            bytes.extend_from_slice(&[0xff, 0xe1]);
            bytes.extend_from_slice(&((body + 2) as u16).to_be_bytes());
            bytes.extend(std::iter::repeat_n(0xab, body));
            left -= body;
        }
        bytes.extend_from_slice(&[0xff, 0xc0, 0x00, 0x11, 0x08]);
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&[3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
        bytes.extend_from_slice(&[0xff, 0xda, 0x00, 0x02, 1, 2, 3, 0xff, 0xd9]);
        bytes
    }

    fn probe(bytes: &[u8], step: usize, expected: Option<ImageKind>) -> Result<ImageInfo, Reject> {
        let mut probe = ImageProbe::new(expected);
        for part in bytes.chunks(step) {
            probe.feed(part)?;
        }
        probe.finish()
    }

    #[test]
    fn sizes_across_any_split() {
        for step in [1, 3, 7, 64, 1 << 20] {
            assert_eq!(
                probe(&png(640, 480), step, None).unwrap(),
                ImageInfo {
                    kind: ImageKind::Png,
                    width: 640,
                    height: 480
                }
            );
            let info = probe(&jpeg(4000, 3000, 70_000), step, Some(ImageKind::Jpeg)).unwrap();
            assert_eq!((info.width, info.height), (4000, 3000));
        }
    }

    #[test]
    fn jpeg_rejections() {
        // 没有 SOF：先遇到了 SOS。
        let mut no_sof = vec![0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 1, 2];
        no_sof.extend_from_slice(&[0xff, 0xda, 0x00, 0x02]);
        assert_eq!(probe(&no_sof, 5, None).unwrap_err().code, "jpeg_no_sof");
        // 文件在 EXIF 段中间就结束了。
        let cut = jpeg(10, 10, 5000);
        assert_eq!(
            probe(&cut[..3000], 64, None).unwrap_err().code,
            "jpeg_no_sof"
        );
        // 无损编码。
        let mut lossless = jpeg(10, 10, 0);
        lossless[3] = 0xc3;
        assert_eq!(
            probe(&lossless, 64, None).unwrap_err().code,
            "jpeg_unsupported"
        );
        // 魔数与声明不符。
        assert_eq!(
            probe(&png(1, 1), 64, Some(ImageKind::Jpeg))
                .unwrap_err()
                .code,
            "image_mime_mismatch"
        );
    }

    #[test]
    fn webp_headers() {
        let mut vp8x = b"RIFF\0\0\0\0WEBPVP8X\x0a\0\0\0\0\0\0\0".to_vec();
        vp8x.extend_from_slice(&[0xff, 0x0f, 0x00, 0xff, 0x07, 0x00]);
        let info = probe(&vp8x, 4, None).unwrap();
        assert_eq!((info.width, info.height), (4096, 2048));
        assert!(probe(
            b"RIFF\0\0\0\0WEBPXXXX\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0",
            4,
            None
        )
        .is_err());
    }
}
