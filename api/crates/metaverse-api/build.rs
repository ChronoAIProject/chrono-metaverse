use std::process::Command;

fn main() {
    println!("cargo:rerun-if-env-changed=CHRONO_BUILD_SHA");
    // 工作树的 .git 可能是文件，使用 Git 解析实际的引用位置。
    let branch = Command::new("git")
        .args(["symbolic-ref", "-q", "HEAD"])
        .output()
        .map(|r| String::from_utf8_lossy(&r.stdout).trim().to_owned())
        .unwrap_or_default();
    for name in ["HEAD", branch.as_str()] {
        if name.is_empty() {
            continue;
        }
        if let Ok(result) = Command::new("git")
            .args(["rev-parse", "--git-path", name])
            .output()
        {
            if result.status.success() {
                println!(
                    "cargo:rerun-if-changed={}",
                    String::from_utf8_lossy(&result.stdout).trim()
                );
            }
        }
    }
    let source = std::env::var("CHRONO_BUILD_SHA").unwrap_or_else(|_| {
        let output = Command::new("git")
            .args(["rev-parse", "HEAD"])
            .output()
            .expect("本地构建需要 Git；镜像构建须提供 CHRONO_BUILD_SHA");
        assert!(output.status.success(), "无法确定工具源码版本");
        String::from_utf8(output.stdout).expect("Git 提交编号必须是 UTF-8")
    });
    let source = source.trim();
    assert!(
        source.len() == 40 && source.bytes().all(|b| b.is_ascii_hexdigit()),
        "工具源码版本必须是完整提交哈希"
    );
    println!("cargo:rustc-env=CHRONO_TOOL_SOURCE_REF={source}");
}
