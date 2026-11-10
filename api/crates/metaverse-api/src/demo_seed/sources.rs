//! 来源表（docs/design/server-slim.md 7.1）：说明重建包清单里的文件从哪里下载。清单与托管位置无关，
//! 地址只在这里，由种子配置按 sha256 固定。
//!
//! ```json
//! {"format": "chrono-metaverse-bundle-sources", "version": 1,
//!  "files": {"<sha256>": {"url": "https://…/<sha256>.glb"},
//!            "<扫描 zip 的 sha256>": {"zip": [
//!               {"name": "mesh.drc", "url": "https://…/mesh.drc", "sha256": "…", "size": 1003301},
//!               {"name": "tex.jpg",  "url": "https://…/tex.jpg",  "sha256": "…", "size": 4897711}]}}}
//! ```
//!
//! - 键是清单 `files[]` 里的 sha256，不在清单里的键拒绝；目标空间已经有的文件可以不列；
//! - 值要么是 `url`，要么是 `zip`（1–32 个成员，按**数组顺序**用 [`super::pack`] 的规则打包：存储不
//!   压缩、时间固定）；`zip` 只用于 `scan` 用途、路径以 `.zip` 结尾的文件，打包后的长度必须等于清单
//!   写的大小；
//! - 每个地址都必须在主机列表里（[`super::hosts`]）；成员名 1–128 个字符，只用字母、数字、`.`、`_`、
//!   `-`，不以 `.` 开头，不重复（不分大小写）；成员 ≤ 128 MiB（下载时整个放在内存里）；
//! - 整个来源表 ≤ 1 MiB，不认识的字段一律拒绝。

use std::collections::BTreeMap;

use metaverse_core::bundle::{BundleFile, FilePurpose};
use metaverse_core::is_sha256_hex;
use serde::Deserialize;
use url::Url;

use super::hosts::{host_of, HostList};
use super::pack;

/// 来源表的 `format`。
pub const SOURCES_FORMAT: &str = "chrono-metaverse-bundle-sources";
/// 来源表的 `version`。
pub const SOURCES_VERSION: u64 = 1;
/// 来源表的大小上限。
pub const MAX_SOURCES_BYTES: u64 = 1 << 20;
/// 一个 zip 最多几个成员。
pub const MAX_ZIP_MEMBERS: usize = 32;
/// 一个成员的大小上限（下载时整个成员在内存里）。
pub const MAX_MEMBER_BYTES: u64 = 128 << 20;

/// zip 的一个成员。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZipMember {
    pub name: String,
    pub url: Url,
    pub sha256: String,
    pub size: u64,
}

/// 一个文件从哪里来。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    /// 整个文件从一个地址下载。
    Url(Url),
    /// 逐个下载成员，按数组顺序打包成 zip。
    Zip(Vec<ZipMember>),
}

/// 解析好的来源表：文件哈希 → 来源。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Sources {
    pub files: BTreeMap<String, Source>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawSources {
    format: String,
    version: u64,
    files: BTreeMap<String, RawSource>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawSource {
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    zip: Option<Vec<RawMember>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawMember {
    name: String,
    url: String,
    sha256: String,
    size: u64,
}

/// 成员名：1–128 个字符，字母、数字、`.`、`_`、`-`，不以 `.` 开头。
pub fn is_member_name(name: &str) -> bool {
    (1..=128).contains(&name.len())
        && !name.starts_with('.')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

fn checked_url(field: &str, text: &str, hosts: &HostList) -> Result<Url, String> {
    let url = Url::parse(text).map_err(|error| format!("{field} 不是合法地址：{error}"))?;
    if !hosts.allows(&url) {
        return Err(format!(
            "{field} 的主机 {} 不在允许下载的主机列表里（只用 https，不带用户名、密码和片段）",
            host_of(&url)
        ));
    }
    Ok(url)
}

impl Sources {
    /// 解析并校验来源表。`files` 是清单的 `files[]`。
    pub fn parse(bytes: &[u8], hosts: &HostList, files: &[BundleFile]) -> Result<Self, String> {
        if bytes.len() as u64 > MAX_SOURCES_BYTES {
            return Err(format!("来源表超过 {MAX_SOURCES_BYTES} 字节"));
        }
        let raw: RawSources =
            serde_json::from_slice(bytes).map_err(|error| format!("来源表格式不对：{error}"))?;
        if raw.format != SOURCES_FORMAT {
            return Err(format!("来源表的 format 必须是 {SOURCES_FORMAT}"));
        }
        if raw.version != SOURCES_VERSION {
            return Err("来源表只认版本 1".to_owned());
        }
        let mut out = BTreeMap::new();
        for (hash, source) in raw.files {
            let field = format!("files.{hash}");
            if !is_sha256_hex(&hash) {
                return Err(format!("{field}：键必须是 64 位小写十六进制的 sha256"));
            }
            let file = files
                .iter()
                .find(|file| file.sha256 == hash)
                .ok_or_else(|| format!("{field}：清单的 files 里没有这个哈希"))?;
            let parsed = match (source.url, source.zip) {
                (Some(url), None) => {
                    Source::Url(checked_url(&format!("{field}.url"), &url, hosts)?)
                }
                (None, Some(members)) => {
                    if file.purpose != FilePurpose::Scan || !file.path.ends_with(".zip") {
                        return Err(format!(
                            "{field}.zip：只有 scan 用途、路径以 .zip 结尾的文件可以按成员打包（{}）",
                            file.path
                        ));
                    }
                    Source::Zip(Self::members(&field, members, hosts, file)?)
                }
                _ => {
                    return Err(format!("{field}：url 和 zip 必须正好给一个"));
                }
            };
            out.insert(hash, parsed);
        }
        Ok(Self { files: out })
    }

    fn members(
        field: &str,
        members: Vec<RawMember>,
        hosts: &HostList,
        file: &BundleFile,
    ) -> Result<Vec<ZipMember>, String> {
        if members.is_empty() || members.len() > MAX_ZIP_MEMBERS {
            return Err(format!("{field}.zip 要有 1–{MAX_ZIP_MEMBERS} 个成员"));
        }
        let mut out: Vec<ZipMember> = Vec::with_capacity(members.len());
        for (index, member) in members.into_iter().enumerate() {
            let at = format!("{field}.zip[{index}]");
            if !is_member_name(&member.name) {
                return Err(format!(
                    "{at}.name 不合法：1–128 个字符，只用字母、数字、.、_、-，不以 . 开头"
                ));
            }
            if out
                .iter()
                .any(|other| other.name.eq_ignore_ascii_case(&member.name))
            {
                return Err(format!("{at}.name 重复：{}", member.name));
            }
            if !is_sha256_hex(&member.sha256) {
                return Err(format!("{at}.sha256 必须是 64 位小写十六进制"));
            }
            if member.size == 0 || member.size > MAX_MEMBER_BYTES {
                return Err(format!("{at}.size 必须在 1–{MAX_MEMBER_BYTES} 字节之间"));
            }
            let url = checked_url(&format!("{at}.url"), &member.url, hosts)?;
            out.push(ZipMember {
                name: member.name,
                url,
                sha256: member.sha256,
                size: member.size,
            });
        }
        let layout: Vec<(&str, u64)> = out
            .iter()
            .map(|member| (member.name.as_str(), member.size))
            .collect();
        let packed = pack::zip_size(&layout);
        if packed != file.size {
            return Err(format!(
                "{field}.zip：按成员打包后是 {packed} 字节，清单写的是 {} 字节（成员、顺序或大小对不上）",
                file.size
            ));
        }
        Ok(out)
    }

    pub fn get(&self, hash: &str) -> Option<&Source> {
        self.files.get(hash)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn hosts() -> HostList {
        HostList::parse("github.com,scaniverse.com").unwrap()
    }

    fn file(path: &str, purpose: FilePurpose, sha: char, size: u64) -> BundleFile {
        BundleFile {
            path: path.into(),
            purpose,
            sha256: sha.to_string().repeat(64),
            size,
        }
    }

    fn members() -> Value {
        json!([
            {"name": "mesh.drc", "url": "https://scaniverse.com/api/media/x/mesh.drc",
             "sha256": "c".repeat(64), "size": 1000},
            {"name": "tex.jpg", "url": "https://scaniverse.com/api/media/x/tex.jpg",
             "sha256": "d".repeat(64), "size": 2000}
        ])
    }

    fn manifest_files() -> Vec<BundleFile> {
        let zip = pack::zip_size(&[("mesh.drc", 1000), ("tex.jpg", 2000)]);
        vec![
            file("scan/scan.zip", FilePurpose::Scan, 'a', zip),
            file("web/scan-0.glb", FilePurpose::Webmodel, 'b', 100),
        ]
    }

    fn table() -> Value {
        json!({"format": SOURCES_FORMAT, "version": 1, "files": {
            "a".repeat(64): {"zip": members()},
            "b".repeat(64): {"url": format!("https://github.com/o/r/releases/download/demo-assets/{}.glb", "b".repeat(64))}
        }})
    }

    fn parse(value: &Value) -> Result<Sources, String> {
        Sources::parse(value.to_string().as_bytes(), &hosts(), &manifest_files())
    }

    #[test]
    fn parses_url_and_zip_sources() {
        let sources = parse(&table()).unwrap();
        match sources.get(&"a".repeat(64)).unwrap() {
            Source::Zip(members) => {
                assert_eq!(members.len(), 2);
                assert_eq!(members[0].name, "mesh.drc");
                assert_eq!(members[1].size, 2000);
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(sources.get(&"b".repeat(64)), Some(Source::Url(_))));
        // 空间里已有的文件可以不列。
        let mut partial = table();
        partial["files"]
            .as_object_mut()
            .unwrap()
            .remove(&"b".repeat(64));
        assert!(parse(&partial).unwrap().get(&"b".repeat(64)).is_none());
    }

    #[test]
    fn rejects_bad_tables() {
        type Edit = Box<dyn Fn(&mut Value)>;
        let a = "a".repeat(64);
        let b = "b".repeat(64);
        let cases: Vec<(&str, Edit)> = vec![
            ("format", Box::new(|v| v["format"] = json!("other"))),
            ("版本", Box::new(|v| v["version"] = json!(2))),
            ("格式不对", Box::new(|v| v["extra"] = json!(1))),
            (
                "没有这个哈希",
                Box::new(|v| v["files"]["e".repeat(64)] = json!({"url": "https://github.com/x"})),
            ),
            (
                "键必须是",
                Box::new(|v| v["files"]["E".repeat(64)] = json!({"url": "https://github.com/x"})),
            ),
            (
                "正好给一个",
                Box::new({
                    let b = b.clone();
                    move |v| v["files"][&b] = json!({})
                }),
            ),
            (
                "不在允许下载",
                Box::new({
                    let b = b.clone();
                    move |v| v["files"][&b] = json!({"url": "https://evil.example/x.glb"})
                }),
            ),
            (
                "只有 scan",
                Box::new({
                    let b = b.clone();
                    move |v| v["files"][&b] = json!({"zip": members()})
                }),
            ),
            (
                "name 不合法",
                Box::new({
                    let a = a.clone();
                    move |v| v["files"][&a]["zip"][0]["name"] = json!("../mesh.drc")
                }),
            ),
            (
                "重复",
                Box::new({
                    let a = a.clone();
                    move |v| v["files"][&a]["zip"][1]["name"] = json!("MESH.drc")
                }),
            ),
            (
                "打包后",
                Box::new({
                    let a = a.clone();
                    move |v| v["files"][&a]["zip"][1]["size"] = json!(2001)
                }),
            ),
            (
                "size",
                Box::new({
                    let a = a.clone();
                    move |v| v["files"][&a]["zip"][1]["size"] = json!(MAX_MEMBER_BYTES + 1)
                }),
            ),
            (
                "1–32",
                Box::new({
                    let a = a.clone();
                    move |v| v["files"][&a]["zip"] = json!([])
                }),
            ),
            (
                "格式不对",
                Box::new({
                    let a = a.clone();
                    move |v| v["files"][&a]["zip"][0]["extra"] = json!(1)
                }),
            ),
        ];
        for (expected, edit) in cases {
            let mut value = table();
            edit(&mut value);
            let error = parse(&value).unwrap_err();
            assert!(error.contains(expected), "{expected}: {error}");
        }
        assert!(
            Sources::parse(&vec![b' '; (MAX_SOURCES_BYTES + 1) as usize], &hosts(), &[])
                .unwrap_err()
                .contains("超过")
        );
    }
}
