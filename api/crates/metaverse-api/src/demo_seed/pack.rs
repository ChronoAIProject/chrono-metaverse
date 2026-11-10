//! 按来源表的 `zip` 打包扫描（docs/design/server-slim.md 7.1、7.2）：成员按数组顺序，存储不压缩，
//! 时间固定为 1980-01-01 00:00，同样的成员总是得到同样的字节——线上第 1–3 版的扫描 zip 就是这样打的，
//! 来源表指向同样的两个 Scaniverse 文件、同样的顺序，打包结果字节相同、哈希相同。本地工具的
//! `metaverse-recon scan-zip` 按同样的规则打包（跨语言向量 `tests/vectors/demo_seed_zip.json`）。
//!
//! zip 写得最简单：每个成员一个本地文件头（大小和 CRC-32 直接写在头里，不用数据描述符）、中央目录、
//! 目录结束记录。不支持 zip64：总大小必须小于 4GiB（扫描上限默认 1GiB）。
//!
//! 种子导入时**逐个成员**写进上传会话的数据块：先下载一个成员（整个在内存里，≤ 128 MiB）、核对哈希
//! 和大小、算 CRC，写出 [`local_header`] 和成员数据，然后释放；全部成员写完再写 [`central_directory`]。
//! 同一时刻只有一个成员在内存里，整个 zip 不在内存里。

/// 一个已经写出的成员：名字、CRC-32、大小、本地头的偏移。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Written {
    pub name: String,
    pub crc: u32,
    pub size: u32,
    pub offset: u32,
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
/// 本地文件头、中央目录项、目录结束记录的固定长度。
const LOCAL_FIXED: u64 = 30;
const CENTRAL_FIXED: u64 = 46;
const END_FIXED: u64 = 22;

pub fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = flate2::Crc::new();
    crc.update(bytes);
    crc.sum()
}

fn too_large() -> String {
    "zip 超过 4GiB（不支持 zip64）".to_owned()
}

/// 按成员（名字、大小）算出打包后的总长度。
pub fn zip_size(members: &[(&str, u64)]) -> u64 {
    members
        .iter()
        .map(|(name, size)| LOCAL_FIXED + CENTRAL_FIXED + 2 * name.len() as u64 + size)
        .sum::<u64>()
        + END_FIXED
}

fn check_name(name: &str) -> Result<u16, String> {
    if !name.is_ascii() || name.is_empty() {
        return Err(format!("zip 成员名必须是 ASCII：{name:?}"));
    }
    u16::try_from(name.len()).map_err(|_| too_large())
}

/// 一个成员的本地文件头（紧接着写成员数据）。
pub fn local_header(name: &str, crc: u32, size: u32) -> Result<Vec<u8>, String> {
    let name_len = check_name(name)?;
    let mut out = Vec::with_capacity(LOCAL_FIXED as usize + name.len());
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
    Ok(out)
}

/// 中央目录和目录结束记录。`offset` 是中央目录在文件里的位置（= 全部本地头和数据的长度）。
pub fn central_directory(entries: &[Written], offset: u64) -> Result<Vec<u8>, String> {
    if entries.len() > usize::from(u16::MAX) {
        return Err("zip 成员太多".into());
    }
    let mut central = Vec::new();
    for entry in entries {
        let name_len = check_name(&entry.name)?;
        central.extend_from_slice(&CENTRAL_HEADER.to_le_bytes());
        central.extend_from_slice(&VERSION_MADE_BY.to_le_bytes());
        central.extend_from_slice(&VERSION_NEEDED.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes()); // 标志
        central.extend_from_slice(&0u16.to_le_bytes()); // stored
        central.extend_from_slice(&DOS_TIME.to_le_bytes());
        central.extend_from_slice(&DOS_DATE.to_le_bytes());
        central.extend_from_slice(&entry.crc.to_le_bytes());
        central.extend_from_slice(&entry.size.to_le_bytes());
        central.extend_from_slice(&entry.size.to_le_bytes());
        central.extend_from_slice(&name_len.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes()); // 扩展字段长度
        central.extend_from_slice(&0u16.to_le_bytes()); // 注释长度
        central.extend_from_slice(&0u16.to_le_bytes()); // 起始分卷
        central.extend_from_slice(&0u16.to_le_bytes()); // 内部属性
        central.extend_from_slice(&0u32.to_le_bytes()); // 外部属性
        central.extend_from_slice(&entry.offset.to_le_bytes());
        central.extend_from_slice(entry.name.as_bytes());
    }
    let directory_offset = u32::try_from(offset).map_err(|_| too_large())?;
    let directory_size = u32::try_from(central.len()).map_err(|_| too_large())?;
    u32::try_from(offset + central.len() as u64 + END_FIXED).map_err(|_| too_large())?;
    let count = entries.len() as u16;
    central.extend_from_slice(&END_OF_DIRECTORY.to_le_bytes());
    central.extend_from_slice(&0u16.to_le_bytes()); // 本分卷号
    central.extend_from_slice(&0u16.to_le_bytes()); // 目录所在分卷
    central.extend_from_slice(&count.to_le_bytes());
    central.extend_from_slice(&count.to_le_bytes());
    central.extend_from_slice(&directory_size.to_le_bytes());
    central.extend_from_slice(&directory_offset.to_le_bytes());
    central.extend_from_slice(&0u16.to_le_bytes()); // 注释长度
    Ok(central)
}

/// 增量打包：每个成员写出本地头和数据，最后写中央目录。种子导入和测试共用。
#[derive(Debug, Default)]
pub struct ZipBuilder {
    written: Vec<Written>,
    offset: u64,
}

impl ZipBuilder {
    /// 一个成员要写出的本地头（调用方接着写 `data`）。
    pub fn member(&mut self, name: &str, data: &[u8]) -> Result<Vec<u8>, String> {
        self.member_with_crc(name, crc32(data), data.len() as u64)
    }

    /// 同 [`ZipBuilder::member`]，CRC-32 由调用方算好（大成员在阻塞线程池里算）。
    pub fn member_with_crc(&mut self, name: &str, crc: u32, len: u64) -> Result<Vec<u8>, String> {
        let size = u32::try_from(len).map_err(|_| too_large())?;
        let header = local_header(name, crc, size)?;
        let offset = u32::try_from(self.offset).map_err(|_| too_large())?;
        self.written.push(Written {
            name: name.to_owned(),
            crc,
            size,
            offset,
        });
        self.offset += header.len() as u64 + len;
        Ok(header)
    }

    /// 中央目录和目录结束记录。
    pub fn finish(self) -> Result<Vec<u8>, String> {
        central_directory(&self.written, self.offset)
    }
}

/// 整个打包进内存（测试和跨语言向量用；种子导入逐个成员写，见 [`ZipBuilder`]）。
pub fn stored_zip(entries: &[(&str, &[u8])]) -> Result<Vec<u8>, String> {
    let mut builder = ZipBuilder::default();
    let mut out = Vec::new();
    for (name, data) in entries {
        out.extend(builder.member(name, data)?);
        out.extend_from_slice(data);
    }
    out.extend(builder.finish()?);
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
        assert_eq!(
            zip.len() as u64,
            zip_size(&[
                ("mesh.drc", mesh.len() as u64),
                ("tex.jpg", texture.len() as u64)
            ])
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
}
