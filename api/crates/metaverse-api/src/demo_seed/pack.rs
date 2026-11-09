//! 把下载好的文件变成一份扫描资源：单个 glb / drc / obj / zip 直接用；网格加贴图时打包成 zip
//! （stored，不压缩），布局与 Scaniverse 导出的 zip 相同——处理服务 `processing/sniff.py` 的
//! `inspect_zip` 从里面找出网格（glb > drc > obj）和最大的那张图当贴图。
//!
//! zip 写得最简单：每个成员一个本地文件头（大小和 CRC-32 直接写在头里，不用数据描述符）、
//! 中央目录、目录结束记录；时间固定为 1980-01-01 00:00，同样的文件总是得到同样的字节（内容哈希
//! 稳定，重复导入时复用同一个资源）。不支持 zip64：总大小必须小于 4GiB（扫描上限默认 1GiB）。

use metaverse_core::model::UploadFormat;

use super::config::{FileRole, SeedFile};
use crate::ingest::formats::check_header;

/// 一份扫描资源。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScanAsset {
    pub bytes: Vec<u8>,
    pub format: UploadFormat,
}

impl ScanAsset {
    /// 登记资源时 `metadata.format` 的写法（处理服务 `processing/sniff.py` 的叫法：drc 写成 `draco`）。
    pub fn worker_format(&self) -> &'static str {
        match self.format {
            UploadFormat::Drc => "draco",
            other => other.name(),
        }
    }
}

/// 核对下载的文件头与扩展名声明的格式相符（与上传时第 0 片的检查相同）。
pub fn check_file(file: &SeedFile, bytes: &[u8], max_texture_side: u64) -> Result<(), String> {
    check_header(file.format, bytes, bytes.len() as u64, max_texture_side)
        .map_err(|error| format!("文件 {} 的内容与扩展名不符：{error}", file.name))
}

/// 按文件组成扫描资源。`files` 与 `contents` 一一对应，都已核对过哈希和文件头。
pub fn scan_asset(
    files: &[SeedFile],
    contents: Vec<Vec<u8>>,
    max_total_bytes: u64,
) -> Result<ScanAsset, String> {
    if files.len() != contents.len() || files.is_empty() {
        return Err("文件与内容的数量不一致".into());
    }
    if files.len() == 1 {
        let file = &files[0];
        if !matches!(file.role, FileRole::Mesh | FileRole::Archive) {
            return Err(format!(
                "单独一个文件只能是 glb、drc、obj 或 zip：{}",
                file.name
            ));
        }
        let bytes = contents.into_iter().next().unwrap_or_default();
        return Ok(ScanAsset {
            bytes,
            format: file.format,
        });
    }
    let entries: Vec<(&str, &[u8])> = files
        .iter()
        .zip(&contents)
        .map(|(file, bytes)| (file.name.as_str(), bytes.as_slice()))
        .collect();
    let bytes = stored_zip(&entries)?;
    if bytes.len() as u64 > max_total_bytes {
        return Err(format!(
            "打包后的 zip {} 字节超过上限 {max_total_bytes}",
            bytes.len()
        ));
    }
    Ok(ScanAsset {
        bytes,
        format: UploadFormat::Zip,
    })
}

const LOCAL_HEADER: u32 = 0x0403_4b50;
const CENTRAL_HEADER: u32 = 0x0201_4b50;
const END_OF_DIRECTORY: u32 = 0x0605_4b50;
/// 解压需要的版本 1.0（stored）；生成者版本 2.0、主机 MS-DOS。
const VERSION_NEEDED: u16 = 10;
const VERSION_MADE_BY: u16 = 20;
/// 1980-01-01（DOS 日期：年份从 1980 起算 << 9 | 月 << 5 | 日），00:00:00。
const DOS_DATE: u16 = (1 << 5) | 1;
const DOS_TIME: u16 = 0;

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = flate2::Crc::new();
    crc.update(bytes);
    crc.sum()
}

/// 不压缩的 zip。成员名必须是 ASCII（种子配置已经限制）。
pub fn stored_zip(entries: &[(&str, &[u8])]) -> Result<Vec<u8>, String> {
    let too_large = || "zip 超过 4GiB（不支持 zip64）".to_owned();
    let to_u32 = |value: usize| u32::try_from(value).map_err(|_| too_large());
    if entries.len() > usize::from(u16::MAX) {
        return Err("zip 成员太多".into());
    }
    let total: usize = entries
        .iter()
        .map(|(name, data)| 30 + 46 + 2 * name.len() + data.len())
        .sum::<usize>()
        + 22;
    to_u32(total)?;
    let mut out = Vec::with_capacity(total);
    let mut central = Vec::new();
    for (name, data) in entries {
        if !name.is_ascii() || name.is_empty() {
            return Err(format!("zip 成员名必须是 ASCII：{name:?}"));
        }
        let offset = to_u32(out.len())?;
        let crc = crc32(data);
        let size = to_u32(data.len())?;
        let name_len = u16::try_from(name.len()).map_err(|_| too_large())?;
        // 本地文件头
        out.extend_from_slice(&LOCAL_HEADER.to_le_bytes());
        out.extend_from_slice(&VERSION_NEEDED.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // 标志
        out.extend_from_slice(&0u16.to_le_bytes()); // stored
        out.extend_from_slice(&DOS_TIME.to_le_bytes());
        out.extend_from_slice(&DOS_DATE.to_le_bytes());
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&size.to_le_bytes()); // 压缩后大小
        out.extend_from_slice(&size.to_le_bytes()); // 原始大小
        out.extend_from_slice(&name_len.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // 扩展字段长度
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(data);
        // 中央目录项
        central.extend_from_slice(&CENTRAL_HEADER.to_le_bytes());
        central.extend_from_slice(&VERSION_MADE_BY.to_le_bytes());
        central.extend_from_slice(&VERSION_NEEDED.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes()); // 标志
        central.extend_from_slice(&0u16.to_le_bytes()); // stored
        central.extend_from_slice(&DOS_TIME.to_le_bytes());
        central.extend_from_slice(&DOS_DATE.to_le_bytes());
        central.extend_from_slice(&crc.to_le_bytes());
        central.extend_from_slice(&size.to_le_bytes());
        central.extend_from_slice(&size.to_le_bytes());
        central.extend_from_slice(&name_len.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes()); // 扩展字段长度
        central.extend_from_slice(&0u16.to_le_bytes()); // 注释长度
        central.extend_from_slice(&0u16.to_le_bytes()); // 起始分卷
        central.extend_from_slice(&0u16.to_le_bytes()); // 内部属性
        central.extend_from_slice(&0u32.to_le_bytes()); // 外部属性
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(name.as_bytes());
    }
    let directory_offset = to_u32(out.len())?;
    let directory_size = to_u32(central.len())?;
    let count = entries.len() as u16;
    out.extend_from_slice(&central);
    out.extend_from_slice(&END_OF_DIRECTORY.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // 本分卷号
    out.extend_from_slice(&0u16.to_le_bytes()); // 目录所在分卷
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&directory_size.to_le_bytes());
    out.extend_from_slice(&directory_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // 注释长度
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u16_at(bytes: &[u8], at: usize) -> u16 {
        u16::from_le_bytes([bytes[at], bytes[at + 1]])
    }

    fn u32_at(bytes: &[u8], at: usize) -> u32 {
        u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
    }

    /// 按中央目录读回全部成员（与 Python zipfile 的读法相同：先找目录结束记录，再按目录项找本地头）。
    fn read_back(zip: &[u8]) -> Vec<(String, Vec<u8>)> {
        let end = zip.len() - 22;
        assert_eq!(u32_at(zip, end), END_OF_DIRECTORY);
        let count = u16_at(zip, end + 10) as usize;
        let size = u32_at(zip, end + 12) as usize;
        let mut at = u32_at(zip, end + 16) as usize;
        assert_eq!(at + size, end, "目录紧挨着目录结束记录");
        let mut out = Vec::new();
        for _ in 0..count {
            assert_eq!(u32_at(zip, at), CENTRAL_HEADER);
            assert_eq!(u16_at(zip, at + 10), 0, "stored");
            let crc = u32_at(zip, at + 16);
            let compressed = u32_at(zip, at + 20) as usize;
            let name_len = u16_at(zip, at + 28) as usize;
            let local = u32_at(zip, at + 42) as usize;
            let name = String::from_utf8(zip[at + 46..at + 46 + name_len].to_vec()).unwrap();
            assert_eq!(u32_at(zip, local), LOCAL_HEADER);
            assert_eq!(u32_at(zip, local + 14), crc, "本地头和目录的 CRC 一致");
            let local_name_len = u16_at(zip, local + 26) as usize;
            let extra = u16_at(zip, local + 28) as usize;
            assert_eq!(
                &zip[local + 30..local + 30 + local_name_len],
                name.as_bytes()
            );
            let start = local + 30 + local_name_len + extra;
            let data = zip[start..start + compressed].to_vec();
            assert_eq!(crc32(&data), crc);
            out.push((name, data));
            at += 46 + name_len;
        }
        out
    }

    #[test]
    fn stored_zip_round_trips_and_is_deterministic() {
        let mesh = b"DRACO\x02\x02\x01\x01\x00\x00".repeat(1000);
        let texture = [b"\xff\xd8\xff\xe0".as_slice(), &[7u8; 5000]].concat();
        let entries: [(&str, &[u8]); 2] = [("mesh.drc", &mesh), ("tex.jpg", &texture)];
        let zip = stored_zip(&entries).unwrap();
        assert!(zip.starts_with(b"PK\x03\x04"));
        let back = read_back(&zip);
        assert_eq!(back.len(), 2);
        assert_eq!(back[0], ("mesh.drc".to_owned(), mesh.clone()));
        assert_eq!(back[1], ("tex.jpg".to_owned(), texture.clone()));
        assert_eq!(
            stored_zip(&entries).unwrap(),
            zip,
            "同样的输入得到同样的字节"
        );
        // 已知向量：空文件的 CRC 是 0，一个成员的 zip 长度 = 30 + 46 + 2×名称 + 数据 + 22。
        let empty = stored_zip(&[("a.txt", b"")]).unwrap();
        assert_eq!(empty.len(), 30 + 46 + 2 * 5 + 22);
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    }

    #[test]
    fn names_must_be_ascii() {
        assert!(stored_zip(&[("贴图.jpg", b"x")]).is_err());
        assert!(stored_zip(&[("", b"x")]).is_err());
    }

    fn file(name: &str, role: FileRole, format: UploadFormat) -> SeedFile {
        SeedFile {
            url: url::Url::parse("https://x.example/f").unwrap(),
            name: name.into(),
            sha256: "a".repeat(64),
            size: 1,
            role,
            format,
        }
    }

    #[test]
    fn single_file_is_used_directly_and_several_are_zipped() {
        let mesh = file("scan.glb", FileRole::Mesh, UploadFormat::Glb);
        let single =
            scan_asset(std::slice::from_ref(&mesh), vec![b"glb".to_vec()], 1 << 20).unwrap();
        assert_eq!(single.bytes, b"glb");
        assert_eq!(single.worker_format(), "glb");
        let drc = file("mesh.drc", FileRole::Mesh, UploadFormat::Drc);
        let tex = file("tex.jpg", FileRole::Texture, UploadFormat::Jpeg);
        let zipped = scan_asset(
            &[drc.clone(), tex.clone()],
            vec![b"DRACO".to_vec(), b"\xff\xd8".to_vec()],
            1 << 20,
        )
        .unwrap();
        assert_eq!(zipped.format, UploadFormat::Zip);
        assert_eq!(zipped.worker_format(), "zip");
        assert_eq!(read_back(&zipped.bytes).len(), 2);
        let alone =
            scan_asset(std::slice::from_ref(&drc), vec![b"DRACO".to_vec()], 1 << 20).unwrap();
        assert_eq!(alone.worker_format(), "draco");
        // 打包后超过上限。
        assert!(scan_asset(&[drc, tex.clone()], vec![vec![0; 100], vec![0; 100]], 150).is_err());
        // 单独一张贴图不是扫描。
        assert!(scan_asset(&[tex], vec![b"\xff\xd8".to_vec()], 1 << 20).is_err());
    }

    #[test]
    fn file_header_must_match_extension() {
        let drc = file("mesh.drc", FileRole::Mesh, UploadFormat::Drc);
        assert!(check_file(&drc, b"DRACO\x02\x02", 8192).is_ok());
        let error = check_file(&drc, b"<html>not found</html>", 8192).unwrap_err();
        assert!(error.contains("mesh.drc"), "{error}");
        let jpg = file("tex.jpg", FileRole::Texture, UploadFormat::Jpeg);
        assert!(check_file(&jpg, b"\x89PNG\r\n\x1a\n", 8192).is_err());
    }
}
