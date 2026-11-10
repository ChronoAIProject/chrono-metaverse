//! 扫描 zip 的核对（docs/design/server-slim.md 4.4）。服务端不解压成员。
//!
//! 1. 先读文件末尾（≤ 1 MiB 的中央目录 + 结束记录和注释），解析中央目录：不收 zip64、不收分卷，
//!    ≤ 64 个成员，名称不重复；
//! 2. 成员名不能是绝对路径、不能含 `..` 段；`__MACOSX/` 下的成员、`.DS_Store` 和目录项忽略（仍查
//!    路径安全）；其余必须正好一个网格成员（glb、drc、obj），别的只能是 jpg、png、mtl；
//! 3. 流式读取经过各成员的本地头时核对：签名、文件名与中央目录一致，压缩方式只能是存储或 deflate，
//!    没有加密标志，大小与中央目录一致（带数据描述符时本地头可以写 0），各成员的数据区间都在文件内、
//!    互不重叠、都在中央目录之前。

use std::collections::BTreeSet;

use metaverse_core::check::ZipCheck;
use metaverse_core::limits::{ZIP_MAX_CENTRAL_DIRECTORY_BYTES, ZIP_MAX_MEMBERS};

use super::Reject;

/// 结束记录的固定长度。
const EOCD_BYTES: u64 = 22;
/// 结束记录后面注释的最大长度。
const MAX_COMMENT: u64 = 65_535;

/// 核对 zip 需要先读的文件末尾长度。
pub fn tail_length(total: u64) -> u64 {
    total.min(ZIP_MAX_CENTRAL_DIRECTORY_BYTES + EOCD_BYTES + MAX_COMMENT)
}

fn reject(code: &'static str, message: impl Into<String>) -> Reject {
    Reject::new(code, message)
}

fn u16_at(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

/// 中央目录里的一个成员。
#[derive(Debug, Clone)]
struct Member {
    name: String,
    offset: u64,
    flags: u16,
    method: u16,
    crc: u32,
    compressed: u64,
    uncompressed: u64,
}

/// 成员的类别。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Role {
    Mesh,
    Other,
    Ignored,
}

/// 名称的路径安全：不是绝对路径、没有盘符、没有 `..` 段、不含 NUL 和反斜杠以外的控制字符。
fn check_path(name: &str) -> Result<(), Reject> {
    let bad = name.is_empty()
        || name.starts_with('/')
        || name.starts_with('\\')
        || name.chars().any(|c| c == '\0' || c.is_control())
        || name.as_bytes().get(1) == Some(&b':')
        || name.split(['/', '\\']).any(|segment| segment == "..");
    if bad {
        return Err(reject(
            "zip_path",
            format!("zip 成员名不安全（绝对路径、盘符或 ..）：{name}"),
        ));
    }
    Ok(())
}

fn role_of(name: &str) -> Result<Role, Reject> {
    check_path(name)?;
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    if name.starts_with("__MACOSX/") || base == ".DS_Store" || name.ends_with('/') {
        return Ok(Role::Ignored);
    }
    let lower = base.to_ascii_lowercase();
    let extension = lower.rsplit_once('.').map(|(_, ext)| ext).unwrap_or("");
    match extension {
        "glb" | "drc" | "obj" => Ok(Role::Mesh),
        "jpg" | "jpeg" | "png" | "mtl" => Ok(Role::Other),
        _ => Err(reject(
            "zip_members",
            format!(
                "扫描 zip 里只能有一个网格（glb、drc、obj）和贴图、材质（jpg、png、mtl）：{name}"
            ),
        )),
    }
}

/// 解析末尾、确定要核对的本地头以后，流式核对。
#[derive(Debug)]
pub struct ZipStream {
    total: u64,
    cd_offset: u64,
    /// 按本地头偏移排好序。
    members: Vec<Member>,
    mesh: String,
    /// 下一个要核对的成员。
    next: usize,
    /// 正在收集的本地头（30 字节 + 名称）。
    header: Vec<u8>,
    /// 已喂入的字节数（= 当前块在文件里的起点）。
    position: u64,
    /// 上一个成员数据结束的位置。
    previous_end: u64,
}

impl ZipStream {
    /// `tail` 是文件最后 `tail.len()` 个字节（长度见 [`tail_length`]），`total` 是文件大小。
    pub fn from_tail(tail: &[u8], total: u64) -> Result<Self, Reject> {
        let tail_start = total - tail.len() as u64;
        // 结束记录：从后往前找签名，要求注释长度正好到文件末尾。
        let mut found = None;
        if tail.len() as u64 >= EOCD_BYTES {
            let mut at = tail.len() - EOCD_BYTES as usize;
            loop {
                if u32_at(tail, at) == 0x0605_4b50
                    && at as u64 + EOCD_BYTES + u64::from(u16_at(tail, at + 20))
                        == tail.len() as u64
                {
                    found = Some(at);
                    break;
                }
                if at == 0 || tail.len() - at > (EOCD_BYTES + MAX_COMMENT) as usize {
                    break;
                }
                at -= 1;
            }
        }
        let eocd = found.ok_or_else(|| reject("zip_structure", "找不到 zip 的结束记录"))?;
        if eocd >= 20 && u32_at(tail, eocd - 20) == 0x0706_4b50 {
            return Err(reject("zip_zip64", "不接受 zip64"));
        }
        let disk = u16_at(tail, eocd + 4);
        let cd_disk = u16_at(tail, eocd + 6);
        let entries_here = u16_at(tail, eocd + 8);
        let entries = u16_at(tail, eocd + 10);
        let cd_size = u32_at(tail, eocd + 12);
        let cd_offset = u32_at(tail, eocd + 16);
        if entries == 0xffff || cd_size == 0xffff_ffff || cd_offset == 0xffff_ffff {
            return Err(reject("zip_zip64", "不接受 zip64"));
        }
        if disk != 0 || cd_disk != 0 || entries_here != entries {
            return Err(reject("zip_structure", "不接受分卷 zip"));
        }
        if usize::from(entries) > ZIP_MAX_MEMBERS {
            return Err(reject(
                "zip_members",
                format!("zip 最多 {ZIP_MAX_MEMBERS} 个成员"),
            ));
        }
        let (cd_size, cd_offset) = (u64::from(cd_size), u64::from(cd_offset));
        if cd_size > ZIP_MAX_CENTRAL_DIRECTORY_BYTES {
            return Err(reject("zip_structure", "zip 的中央目录超过 1 MiB"));
        }
        let eocd_position = tail_start + eocd as u64;
        if cd_offset + cd_size != eocd_position || cd_offset < tail_start {
            return Err(reject("zip_structure", "zip 的中央目录位置不对"));
        }
        let mut directory = &tail[(cd_offset - tail_start) as usize..eocd];
        let mut members = Vec::with_capacity(usize::from(entries));
        let mut names = BTreeSet::new();
        let mut mesh = None;
        for _ in 0..entries {
            if directory.len() < 46 || u32_at(directory, 0) != 0x0201_4b50 {
                return Err(reject("zip_structure", "zip 的中央目录记录不对"));
            }
            let flags = u16_at(directory, 8);
            let method = u16_at(directory, 10);
            let crc = u32_at(directory, 16);
            let compressed = u32_at(directory, 20);
            let uncompressed = u32_at(directory, 24);
            let name_len = usize::from(u16_at(directory, 28));
            let extra_len = usize::from(u16_at(directory, 30));
            let comment_len = usize::from(u16_at(directory, 32));
            let disk_start = u16_at(directory, 34);
            let offset = u32_at(directory, 42);
            let record = 46 + name_len + extra_len + comment_len;
            if directory.len() < record {
                return Err(reject("zip_structure", "zip 的中央目录记录被截断"));
            }
            if compressed == 0xffff_ffff || uncompressed == 0xffff_ffff || offset == 0xffff_ffff {
                return Err(reject("zip_zip64", "不接受 zip64"));
            }
            let extra = &directory[46 + name_len..46 + name_len + extra_len];
            let mut cursor = extra;
            while cursor.len() >= 4 {
                let id = u16_at(cursor, 0);
                let size = usize::from(u16_at(cursor, 2));
                if id == 0x0001 {
                    return Err(reject("zip_zip64", "不接受 zip64"));
                }
                cursor = &cursor[(4 + size).min(cursor.len())..];
            }
            if disk_start != 0 {
                return Err(reject("zip_structure", "不接受分卷 zip"));
            }
            let name = std::str::from_utf8(&directory[46..46 + name_len])
                .map_err(|_| reject("zip_path", "zip 成员名不是 UTF-8"))?
                .to_owned();
            if flags & 0x0041 != 0 {
                return Err(reject("zip_encrypted", format!("zip 成员加密了：{name}")));
            }
            if method != 0 && method != 8 {
                return Err(reject(
                    "zip_method",
                    format!("zip 成员的压缩方式只能是存储或 deflate：{name}"),
                ));
            }
            match role_of(&name)? {
                Role::Mesh if mesh.is_some() => {
                    return Err(reject(
                        "zip_members",
                        "扫描 zip 里只能有一个网格成员（glb、drc、obj）",
                    ))
                }
                Role::Mesh => mesh = Some(name.clone()),
                Role::Other | Role::Ignored => {}
            }
            if !names.insert(name.clone()) {
                return Err(reject("zip_structure", format!("zip 成员重名：{name}")));
            }
            members.push(Member {
                name,
                offset: u64::from(offset),
                flags,
                method,
                crc,
                compressed: u64::from(compressed),
                uncompressed: u64::from(uncompressed),
            });
            directory = &directory[record..];
        }
        if !directory.is_empty() {
            return Err(reject("zip_structure", "zip 的中央目录长度与记录数不符"));
        }
        let mesh =
            mesh.ok_or_else(|| reject("zip_members", "扫描 zip 里没有网格成员（glb、drc、obj）"))?;
        members.sort_by_key(|member| member.offset);
        Ok(Self {
            total,
            cd_offset,
            members,
            mesh,
            next: 0,
            header: Vec::new(),
            position: 0,
            previous_end: 0,
        })
    }

    pub fn feed(&mut self, data: &[u8]) -> Result<(), Reject> {
        let start = self.position;
        let end = start + data.len() as u64;
        self.position = end;
        while let Some(member) = self.members.get(self.next) {
            let need = 30 + member.name.len() as u64;
            let header_end = member.offset + need;
            if member.offset >= end {
                return Ok(());
            }
            // 这一块里属于本地头的部分。
            let from = member.offset.max(start);
            let to = header_end.min(end);
            if from < to {
                self.header
                    .extend_from_slice(&data[(from - start) as usize..(to - start) as usize]);
            }
            if header_end > end {
                return Ok(());
            }
            self.check_local_header()?;
            self.header.clear();
            self.next += 1;
        }
        Ok(())
    }

    fn check_local_header(&mut self) -> Result<(), Reject> {
        let member = &self.members[self.next];
        let header = &self.header;
        let name = &member.name;
        let mismatch = |what: &str| {
            reject(
                "zip_local_header",
                format!("zip 成员 {name} 的本地头{what}"),
            )
        };
        if member.offset < self.previous_end {
            return Err(reject(
                "zip_structure",
                format!("zip 成员 {name} 与前一个成员的数据重叠"),
            ));
        }
        if u32_at(header, 0) != 0x0403_4b50 {
            return Err(mismatch("签名不对"));
        }
        let flags = u16_at(header, 6);
        let method = u16_at(header, 8);
        let crc = u32_at(header, 14);
        let compressed = u64::from(u32_at(header, 18));
        let uncompressed = u64::from(u32_at(header, 22));
        let name_len = usize::from(u16_at(header, 26));
        let extra_len = u64::from(u16_at(header, 28));
        if flags & 0x0041 != 0 {
            return Err(reject("zip_encrypted", format!("zip 成员加密了：{name}")));
        }
        if method != member.method {
            return Err(mismatch("与中央目录的压缩方式不一致"));
        }
        if name_len != name.len() || &header[30..] != name.as_bytes() {
            return Err(mismatch("与中央目录的文件名不一致"));
        }
        let descriptor = flags & 0x0008 != 0;
        let same = |local: u64, central: u64| local == central || (descriptor && local == 0);
        if !same(compressed, member.compressed)
            || !same(uncompressed, member.uncompressed)
            || !same(u64::from(crc), u64::from(member.crc))
            || (descriptor != (member.flags & 0x0008 != 0))
        {
            return Err(mismatch("与中央目录的大小或校验值不一致"));
        }
        let data_start = member.offset + 30 + name_len as u64 + extra_len;
        // 带数据描述符时，数据后面至少还有 12 个字节。
        let data_end = data_start + member.compressed + if descriptor { 12 } else { 0 };
        let limit = self
            .members
            .get(self.next + 1)
            .map_or(self.cd_offset, |next| next.offset);
        if data_end > limit || data_end > self.total {
            return Err(reject(
                "zip_structure",
                format!("zip 成员 {name} 的数据超出了文件或与下一个成员重叠"),
            ));
        }
        self.previous_end = data_end;
        Ok(())
    }

    pub fn finish(self) -> Result<ZipCheck, Reject> {
        if self.next != self.members.len() {
            return Err(reject("zip_structure", "zip 不完整，有成员的本地头没读到"));
        }
        Ok(ZipCheck {
            mesh: self.mesh,
            members: self.members.len() as u32,
        })
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// 测试用的 zip 成员。
    pub struct Entry<'a> {
        pub name: &'a str,
        pub data: &'a [u8],
        pub flags: u16,
    }

    /// 按存储方式打包（与 `demo_seed/pack.rs` 相同的布局），给测试造各种 zip。
    pub fn build(entries: &[Entry<'_>]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut central = Vec::new();
        for entry in entries {
            let offset = out.len() as u32;
            let crc = crc32(entry.data);
            let size = entry.data.len() as u32;
            let mut local = Vec::new();
            local.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
            local.extend_from_slice(&20u16.to_le_bytes());
            local.extend_from_slice(&entry.flags.to_le_bytes());
            local.extend_from_slice(&0u16.to_le_bytes());
            local.extend_from_slice(&[0, 0, 0x21, 0]);
            local.extend_from_slice(&crc.to_le_bytes());
            local.extend_from_slice(&size.to_le_bytes());
            local.extend_from_slice(&size.to_le_bytes());
            local.extend_from_slice(&(entry.name.len() as u16).to_le_bytes());
            local.extend_from_slice(&0u16.to_le_bytes());
            local.extend_from_slice(entry.name.as_bytes());
            out.extend_from_slice(&local);
            out.extend_from_slice(entry.data);
            central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
            central.extend_from_slice(&20u16.to_le_bytes());
            central.extend_from_slice(&20u16.to_le_bytes());
            central.extend_from_slice(&entry.flags.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&[0, 0, 0x21, 0]);
            central.extend_from_slice(&crc.to_le_bytes());
            central.extend_from_slice(&size.to_le_bytes());
            central.extend_from_slice(&size.to_le_bytes());
            central.extend_from_slice(&(entry.name.len() as u16).to_le_bytes());
            central.extend_from_slice(&[0; 12]);
            central.extend_from_slice(&offset.to_le_bytes());
            central.extend_from_slice(entry.name.as_bytes());
        }
        let cd_offset = out.len() as u32;
        out.extend_from_slice(&central);
        out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        out.extend_from_slice(&[0; 4]);
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        out.extend_from_slice(&(central.len() as u32).to_le_bytes());
        out.extend_from_slice(&cd_offset.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out
    }

    pub fn crc32(data: &[u8]) -> u32 {
        let mut crc = 0xffff_ffffu32;
        for byte in data {
            crc ^= u32::from(*byte);
            for _ in 0..8 {
                crc = if crc & 1 != 0 {
                    (crc >> 1) ^ 0xedb8_8320
                } else {
                    crc >> 1
                };
            }
        }
        !crc
    }

    pub fn inspect(bytes: &[u8], step: usize) -> Result<ZipCheck, Reject> {
        let total = bytes.len() as u64;
        let tail = &bytes[(total - tail_length(total)) as usize..];
        let mut stream = ZipStream::from_tail(tail, total)?;
        for part in bytes.chunks(step) {
            stream.feed(part)?;
        }
        stream.finish()
    }

    fn entry<'a>(name: &'a str, data: &'a [u8]) -> Entry<'a> {
        Entry {
            name,
            data,
            flags: 0,
        }
    }

    #[test]
    fn scan_layouts() {
        let good = build(&[entry("mesh.drc", b"DRACO..."), entry("tex.jpg", b"jpg")]);
        for step in [1, 7, 30, 1 << 20] {
            let check = inspect(&good, step).unwrap();
            assert_eq!(check.mesh, "mesh.drc");
            assert_eq!(check.members, 2);
        }
        // macOS 的附加成员忽略。
        let mac = build(&[
            entry("scan/", b""),
            entry("scan/mesh.obj", b"v 0 0 0"),
            entry("__MACOSX/scan/._mesh.obj", b"apple"),
            entry("scan/.DS_Store", b"ds"),
        ]);
        assert_eq!(inspect(&mac, 9).unwrap().mesh, "scan/mesh.obj");
    }

    #[test]
    fn rejections() {
        let code = |entries: &[Entry<'_>]| inspect(&build(entries), 13).unwrap_err().code;
        assert_eq!(code(&[entry("../mesh.drc", b"d")]), "zip_path");
        assert_eq!(code(&[entry("/mesh.drc", b"d")]), "zip_path");
        assert_eq!(code(&[entry("C:/mesh.drc", b"d")]), "zip_path");
        assert_eq!(
            code(&[entry("a.drc", b"d"), entry("b.glb", b"g")]),
            "zip_members"
        );
        assert_eq!(code(&[entry("tex.jpg", b"j")]), "zip_members");
        assert_eq!(
            code(&[entry("a.drc", b"d"), entry("run.sh", b"x")]),
            "zip_members"
        );
        assert_eq!(
            code(&[Entry {
                name: "a.drc",
                data: b"d",
                flags: 1
            }]),
            "zip_encrypted"
        );
        // 本地头的名称与中央目录不符。
        let mut renamed = build(&[entry("a.drc", b"d")]);
        renamed[30] = b'b';
        assert_eq!(inspect(&renamed, 5).unwrap_err().code, "zip_local_header");
    }
}
