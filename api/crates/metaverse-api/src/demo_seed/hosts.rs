//! 部署配置种子允许下载的主机（`METAVERSE_DEMO_SEED_HOSTS`，docs/design/server-slim.md 7.1）。
//!
//! 写法与本地工具的主机列表相同：逗号分隔；`主机名` 精确匹配且只许 443 端口；以点开头的 `.后缀`
//! 匹配它的子域名（同样只许 443）；`主机:端口` 只匹配那个端口。只用 https；本机测试可以用
//! `http://127.0.0.1:<端口>` 这类本机地址，这时列表里要写出带端口的本机主机。地址不能带用户名、
//! 密码和片段。清单、来源表和来源表里的每个地址，以及下载时的每一跳重定向，都按同一个列表检查。

use url::{Host, Url};

use crate::config::ConfigError;

/// 主机列表的环境变量。
pub const HOSTS_ENV: &str = "METAVERSE_DEMO_SEED_HOSTS";

/// 一项：精确主机（可带端口），或以点开头的后缀。
#[derive(Debug, Clone, PartialEq, Eq)]
enum Entry {
    Host { name: String, port: Option<u16> },
    Suffix(String),
}

/// 允许下载的主机。空列表什么都不允许。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HostList(Vec<Entry>);

/// 本机地址（测试和本地开发可用明文 http）。
fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(name)) => name.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(ip)) => ip.is_loopback(),
        Some(Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

impl HostList {
    /// 解析逗号分隔的列表。空白项忽略；格式不对的项报错（写进错误信息的只有那一项）。
    pub fn parse(text: &str) -> Result<Self, String> {
        let mut entries = Vec::new();
        for item in text.split(',') {
            let raw = item.trim().to_ascii_lowercase();
            if raw.is_empty() {
                continue;
            }
            let bad = || format!("{raw:?} 不是合法的主机名（写主机名、.后缀 或 主机:端口）");
            let suffix = raw.starts_with('.');
            let name = raw.trim_start_matches('.');
            let (host, port) = match name.split_once(':') {
                Some((host, port)) => {
                    let port: u16 = port.parse().ok().filter(|p| *p > 0).ok_or_else(bad)?;
                    (host, Some(port))
                }
                None => (name, None),
            };
            let valid_host = !host.is_empty()
                && host.len() <= 253
                && host
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.')
                && !host.starts_with('.')
                && !host.ends_with('.');
            if !valid_host || (suffix && (port.is_some() || !host.contains('.'))) {
                return Err(bad());
            }
            let entry = if suffix {
                Entry::Suffix(format!(".{host}"))
            } else {
                Entry::Host {
                    name: host.to_owned(),
                    port,
                }
            };
            if !entries.contains(&entry) {
                entries.push(entry);
            }
        }
        Ok(Self(entries))
    }

    /// 从环境变量读（没设或为空时是空列表）。
    pub fn from_lookup(lookup: &dyn Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        match lookup(HOSTS_ENV) {
            None => Ok(Self::default()),
            Some(text) => {
                Self::parse(&text).map_err(|reason| ConfigError::Invalid(HOSTS_ENV, reason))
            }
        }
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// 这个地址能不能下载：https（或本机的 http），不带用户名、密码和片段，主机和端口在列表里。
    pub fn allows(&self, url: &Url) -> bool {
        let https = url.scheme() == "https";
        let scheme_ok = https || (url.scheme() == "http" && is_loopback(url));
        if !scheme_ok
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            return false;
        }
        let Some(host) = url.host_str() else {
            return false;
        };
        let host = host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .trim_end_matches('.')
            .to_ascii_lowercase();
        let port = url.port_or_known_default();
        self.0.iter().any(|entry| match entry {
            Entry::Suffix(suffix) => {
                https && port == Some(443) && host.len() > suffix.len() && host.ends_with(suffix)
            }
            Entry::Host { name, port: want } => {
                *name == host
                    && match want {
                        Some(want) => port == Some(*want),
                        None => https && port == Some(443),
                    }
            }
        })
    }

    /// 能不能从 `previous` 跟随重定向到 `next`：新地址本身要在列表里，而且只要之前经过 https，
    /// 就只能继续 https（本机明文 http 只给一开始就是本机地址的测试用）。
    pub fn redirect_allowed(&self, previous: &[Url], next: &Url) -> bool {
        self.allows(next)
            && (next.scheme() == "https" || previous.iter().all(|url| url.scheme() == "http"))
    }
}

/// 错误信息里写的地址：只写主机（重定向后的地址可能带签名）。
pub fn host_of(url: &Url) -> String {
    url.host_str().unwrap_or("?").to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap()
    }

    #[test]
    fn host_rules_follow_the_local_tool() {
        let hosts = HostList::parse(
            " raw.githubusercontent.com, .githubusercontent.com,scaniverse.com,127.0.0.1:9000 ,",
        )
        .unwrap();
        for (text, ok) in [
            ("https://raw.githubusercontent.com/o/r/abc/x.json", true),
            ("https://RAW.githubusercontent.com./o/r/abc/x.json", true),
            ("https://raw.githubusercontent.com:443/x", true),
            ("https://raw.githubusercontent.com:8443/x", false),
            ("https://objects.githubusercontent.com/x", true),
            ("https://githubusercontent.com/x", false),
            ("https://scaniverse.com/api/media/x/mesh.drc", true),
            ("https://cdn.scaniverse.com/x", false),
            ("http://scaniverse.com/x", false),
            ("http://127.0.0.1:9000/files/x", true),
            ("http://127.0.0.1:9001/files/x", false),
            ("https://user:pw@scaniverse.com/x", false),
            ("https://scaniverse.com/x#frag", false),
            ("ftp://scaniverse.com/x", false),
            ("https://evil.example/x", false),
        ] {
            assert_eq!(hosts.allows(&url(text)), ok, "{text}");
        }
        assert!(!HostList::default().allows(&url("https://scaniverse.com/x")));
        for bad in [
            "https://x.example",
            "a/b",
            "*.x.com",
            ".com",
            ".x.com:443",
            "x:0",
            "x:abc",
            "[::1]:80",
        ] {
            assert!(HostList::parse(bad).is_err(), "{bad}");
        }
        assert!(HostList::parse("").unwrap().is_empty());
    }

    #[test]
    fn redirects_never_downgrade_to_http() {
        let hosts = HostList::parse("scaniverse.com,cdn.example,127.0.0.1:9000").unwrap();
        let https = url("https://scaniverse.com/api/media/x/mesh.drc");
        let local = url("http://127.0.0.1:9000/files/mesh.drc");
        assert!(hosts.redirect_allowed(std::slice::from_ref(&https), &url("https://cdn.example/x")));
        assert!(hosts.redirect_allowed(std::slice::from_ref(&local), &local));
        assert!(!hosts.redirect_allowed(std::slice::from_ref(&https), &local));
        assert!(!hosts.redirect_allowed(
            std::slice::from_ref(&https),
            &url("https://elsewhere.example/x")
        ));
        assert_eq!(
            host_of(&url("https://cdn.example/x?sig=secret")),
            "cdn.example"
        );
    }
}
