//! 上传文件的格式核对（设计 6.1）：收到第 0 片时按声明的格式检查文件头。
//!
//! 只做便宜的文件头检查（魔数、glb 头里的总长度、图片宽高），完整解析由处理服务在
//! 子进程里做（设计 6.4"解析前检查"）。图片宽高读不出来时放行，留给处理服务检查。

use metaverse_core::model::UploadFormat;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FormatError {
    #[error("文件头与声明的格式 {0} 不符")]
    Mismatch(&'static str),
    #[error("glb 头里的总长度 {declared} 与声明的总大小 {total} 不一致")]
    GlbLength { declared: u64, total: u64 },
    #[error("图片 {width}×{height} 超过单边上限 {max} 像素")]
    TextureTooLarge { width: u64, height: u64, max: u64 },
}

/// 检查第 0 片（`head`）。`total_size` 是声明的总大小。
pub fn check_header(
    format: UploadFormat,
    head: &[u8],
    total_size: u64,
    max_side: u64,
) -> Result<(), FormatError> {
    let mismatch = || FormatError::Mismatch(format.name());
    match format {
        UploadFormat::Glb => {
            if head.len() < 12 || &head[..4] != b"glTF" {
                return Err(mismatch());
            }
            let version = u32::from_le_bytes([head[4], head[5], head[6], head[7]]);
            if version != 2 {
                return Err(mismatch());
            }
            let declared = u64::from(u32::from_le_bytes([head[8], head[9], head[10], head[11]]));
            if declared != total_size {
                return Err(FormatError::GlbLength {
                    declared,
                    total: total_size,
                });
            }
        }
        UploadFormat::Drc => {
            if !head.starts_with(b"DRACO") {
                return Err(mismatch());
            }
        }
        UploadFormat::Obj => {
            if !looks_like_obj(head) {
                return Err(mismatch());
            }
        }
        UploadFormat::Zip => {
            if !head.starts_with(b"PK\x03\x04") {
                return Err(mismatch());
            }
        }
        UploadFormat::Png | UploadFormat::Jpeg | UploadFormat::Webp => {
            let size = match format {
                UploadFormat::Png => png_size(head),
                UploadFormat::Jpeg => jpeg_size(head),
                _ => webp_size(head),
            }
            .ok_or_else(mismatch)?;
            if let Some((width, height)) = size {
                if width > max_side || height > max_side {
                    return Err(FormatError::TextureTooLarge {
                        width,
                        height,
                        max: max_side,
                    });
                }
            }
        }
        UploadFormat::Ndjson => {
            let first = head.iter().find(|b| !b.is_ascii_whitespace());
            if first != Some(&b'{') || !is_text(head) {
                return Err(mismatch());
            }
        }
        UploadFormat::Gzip => {
            if !head.starts_with(&[0x1f, 0x8b, 0x08]) {
                return Err(mismatch());
            }
        }
        UploadFormat::Text => {
            if !is_text(head) {
                return Err(mismatch());
            }
        }
        UploadFormat::Json => {
            let first = head.iter().find(|b| !b.is_ascii_whitespace());
            if first != Some(&b'{') || !is_text(head) {
                return Err(mismatch());
            }
        }
    }
    Ok(())
}

/// UTF-8 文本、不含 NUL。片尾可能截断在一个多字节字符中间，允许最多 3 个字节不完整。
fn is_text(bytes: &[u8]) -> bool {
    if bytes.contains(&0) {
        return false;
    }
    match std::str::from_utf8(bytes) {
        Ok(_) => true,
        Err(error) => error.error_len().is_none() && bytes.len() - error.valid_up_to() <= 3,
    }
}

/// OBJ：文本，第一个非空、非注释行以常见关键字开头。
fn looks_like_obj(head: &[u8]) -> bool {
    if !is_text(head) {
        return false;
    }
    let text = String::from_utf8_lossy(head);
    for line in text.lines().map(str::trim) {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let keyword = line.split_whitespace().next().unwrap_or_default();
        return matches!(
            keyword,
            "v" | "vt" | "vn" | "vp" | "f" | "l" | "p" | "o" | "g" | "s" | "mtllib" | "usemtl"
        );
    }
    // 第 0 片全是注释（不太可能）：放行，留给处理服务。
    true
}

/// PNG：签名 + IHDR 宽高。`None` 表示不是 PNG；`Some(None)` 表示是但读不出宽高。
fn png_size(head: &[u8]) -> Option<Option<(u64, u64)>> {
    if !head.starts_with(b"\x89PNG\r\n\x1a\n") {
        return None;
    }
    if head.len() >= 24 && &head[12..16] == b"IHDR" {
        let width = u32::from_be_bytes([head[16], head[17], head[18], head[19]]);
        let height = u32::from_be_bytes([head[20], head[21], head[22], head[23]]);
        return Some(Some((u64::from(width), u64::from(height))));
    }
    Some(None)
}

/// JPEG：SOI，然后逐段找 SOFn（C0–CF，除去 C4、C8、CC）。
fn jpeg_size(head: &[u8]) -> Option<Option<(u64, u64)>> {
    if !head.starts_with(&[0xff, 0xd8, 0xff]) {
        return None;
    }
    let mut i = 2;
    while i + 4 <= head.len() {
        if head[i] != 0xff {
            return Some(None);
        }
        let marker = head[i + 1];
        if marker == 0xff {
            i += 1;
            continue;
        }
        // 没有长度的标记。
        if marker == 0xd8 || marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
            i += 2;
            continue;
        }
        let length = usize::from(u16::from_be_bytes([head[i + 2], head[i + 3]]));
        let is_sof = (0xc0..=0xcf).contains(&marker) && ![0xc4, 0xc8, 0xcc].contains(&marker);
        if is_sof {
            if i + 9 > head.len() {
                return Some(None);
            }
            let height = u16::from_be_bytes([head[i + 5], head[i + 6]]);
            let width = u16::from_be_bytes([head[i + 7], head[i + 8]]);
            return Some(Some((u64::from(width), u64::from(height))));
        }
        if marker == 0xda || length < 2 {
            return Some(None);
        }
        i += 2 + length;
    }
    Some(None)
}

/// WebP：RIFF....WEBP，再按 VP8 / VP8L / VP8X 读宽高。
fn webp_size(head: &[u8]) -> Option<Option<(u64, u64)>> {
    if head.len() < 12 || &head[..4] != b"RIFF" || &head[8..12] != b"WEBP" {
        return None;
    }
    if head.len() < 30 {
        return Some(None);
    }
    let chunk = &head[12..16];
    let size = match chunk {
        b"VP8X" => {
            let width = 1 + u64::from(u32::from_le_bytes([head[24], head[25], head[26], 0]));
            let height = 1 + u64::from(u32::from_le_bytes([head[27], head[28], head[29], 0]));
            Some((width, height))
        }
        b"VP8L" => {
            let bits = u32::from_le_bytes([head[21], head[22], head[23], head[24]]);
            let width = 1 + u64::from(bits & 0x3fff);
            let height = 1 + u64::from((bits >> 14) & 0x3fff);
            Some((width, height))
        }
        b"VP8 " => {
            let width = u64::from(u16::from_le_bytes([head[26], head[27]]) & 0x3fff);
            let height = u64::from(u16::from_le_bytes([head[28], head[29]]) & 0x3fff);
            Some((width, height))
        }
        _ => None,
    };
    Some(size)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAX: u64 = 8192;

    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&[8, 2, 0, 0, 0]);
        bytes
    }

    fn jpeg(width: u16, height: u16) -> Vec<u8> {
        let mut bytes = vec![0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46];
        bytes.extend_from_slice(&[0xff, 0xc0, 0x00, 0x11, 0x08]);
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&[3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
        bytes
    }

    #[test]
    fn glb_header_and_length() {
        let mut glb = b"glTF".to_vec();
        glb.extend_from_slice(&2u32.to_le_bytes());
        glb.extend_from_slice(&100u32.to_le_bytes());
        assert!(check_header(UploadFormat::Glb, &glb, 100, MAX).is_ok());
        assert!(matches!(
            check_header(UploadFormat::Glb, &glb, 101, MAX),
            Err(FormatError::GlbLength { .. })
        ));
        assert!(check_header(UploadFormat::Glb, b"DRACO...", 100, MAX).is_err());
        assert!(check_header(UploadFormat::Drc, b"DRACO\x02\x02", 10, MAX).is_ok());
        assert!(check_header(UploadFormat::Zip, b"PK\x03\x04rest", 10, MAX).is_ok());
        assert!(check_header(UploadFormat::Zip, b"DRACO", 10, MAX).is_err());
    }

    #[test]
    fn image_sizes() {
        assert!(check_header(UploadFormat::Png, &png(8192, 8192), 1, MAX).is_ok());
        assert!(matches!(
            check_header(UploadFormat::Png, &png(8193, 8192), 1, MAX),
            Err(FormatError::TextureTooLarge { .. })
        ));
        assert_eq!(jpeg_size(&jpeg(640, 480)), Some(Some((640, 480))));
        assert!(check_header(UploadFormat::Jpeg, &jpeg(16384, 8192), 1, MAX).is_err());
        assert!(check_header(UploadFormat::Jpeg, &png(1, 1), 1, MAX).is_err());
        let mut webp = b"RIFF\0\0\0\0WEBPVP8X\x0a\0\0\0\0\0\0\0".to_vec();
        webp.extend_from_slice(&[0xff, 0x0f, 0x00, 0xff, 0x0f, 0x00]);
        assert_eq!(webp_size(&webp), Some(Some((4096, 4096))));
    }

    #[test]
    fn text_formats() {
        assert!(check_header(UploadFormat::Ndjson, b"\n{\"op\":\"fill\"}\n", 1, MAX).is_ok());
        assert!(check_header(UploadFormat::Ndjson, b"[1,2]", 1, MAX).is_err());
        assert!(check_header(UploadFormat::Gzip, &[0x1f, 0x8b, 0x08, 0], 1, MAX).is_ok());
        assert!(check_header(UploadFormat::Text, "建造脚本\n".as_bytes(), 1, MAX).is_ok());
        // 片尾截断在多字节字符中间。
        let cut = &"建".as_bytes()[..2];
        assert!(check_header(UploadFormat::Text, cut, 1, MAX).is_ok());
        assert!(check_header(UploadFormat::Text, b"a\0b", 1, MAX).is_err());
        assert!(check_header(UploadFormat::Json, b" {\"version\": 1}", 1, MAX).is_ok());
        assert!(check_header(UploadFormat::Json, b"[1]", 1, MAX).is_err());
        assert!(check_header(UploadFormat::Json, b"{\0}", 1, MAX).is_err());
        assert!(check_header(UploadFormat::Obj, b"# scan\nv 0 0 0\n", 1, MAX).is_ok());
        assert!(check_header(UploadFormat::Obj, b"<html>", 1, MAX).is_err());
    }
}
