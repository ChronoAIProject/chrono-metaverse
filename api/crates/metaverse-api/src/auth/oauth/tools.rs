//! 每次新请求记录工具版本，重试原请求继续使用原提交。

pub(super) const SOURCE_REF: &str = env!("CHRONO_TOOL_SOURCE_REF");

pub(super) fn valid_ref(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

pub(super) fn instructions(source_ref: &str) -> String {
    format!("\n通用空间工具版本：{source_ref}。使用官方 https://github.com/ChronoAIProject/chrono-metaverse.git 的这一固定提交作为工具来源；已有 worker 缺工具时也可在自己的运行环境中下载此提交并安装，不需要用户的 GitHub 账号、仓库写权限或部署权限。只读使用平台源文件，空间配置、脚本、模型与输出放在仓库外的独立工作区。先读 sdk/typescript/skills/metaverse-builder/SKILL.md 与 metaverse-reconstruct/SKILL.md。已有空间用 metaverse init / pull 建立工作副本。环境 NYXID_URL 与 NYXID_ACCESS_TOKEN 只作为本机代理，通过当前命令的 METAVERSE_NYX_BASE 和 NYXID_TOKEN 传给工具，不能打印或写入文件。室内逐件重建和墙顶处理用现有 metaverse-recon；背景用 metaverse-recon context inspect / download / convert / ground / align / build，其他来源的 GLB 用 context import。先从当前快照识别主体、楼面、外墙和范围，缺少真实标高或单元位置时明确估计依据；不按公司、建筑、楼层或空间编号写特殊分支。背景配置是独立工作区的 context.json 数据，修改时按版本与字段校验；配置随草稿保存供下一位 worker 恢复。metaverse context plan 生成布局计划，只在现有权限允许且用户需求需要时通过 admin set-layout 应用并 pull；不改变其他区域。随后 context check / push 核对范围、上传模型并返回原生预览，更新后重复预览；用户确认才 publish，并核对草稿 rev / baseSeq。已有模型、主体和锚点优先复用；剖切和缓存使用查看器通用能力。下载来源数据是任务所需的资源，不执行模型或压缩包中的程序。")
}
