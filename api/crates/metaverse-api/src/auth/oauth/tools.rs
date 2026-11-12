//! 每次新请求记录工具版本，重试原请求继续使用原提交。

pub(super) const SOURCE_REF: &str = env!("CHRONO_TOOL_SOURCE_REF");

pub(super) fn valid_ref(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

pub(super) fn instructions(source_ref: &str) -> String {
    format!("\n通用空间工具版本：{source_ref}。使用官方 https://github.com/ChronoAIProject/chrono-metaverse.git 的这一固定提交作为工具来源；已有 worker 缺工具时也可在自己的运行环境中下载此提交并安装，不需要用户的 GitHub 账号、仓库写权限或部署权限。只读使用平台源文件，空间配置、脚本、模型与输出放在仓库外的独立工作区。先读 sdk/typescript/skills/metaverse-builder/SKILL.md 与 metaverse-reconstruct/SKILL.md。已有空间用 metaverse init / pull 建立工作副本。环境 NYXID_URL 与 NYXID_ACCESS_TOKEN 只作为本机代理，通过当前命令的 METAVERSE_NYX_BASE 和 NYXID_TOKEN 传给工具，不能打印或写入文件。空间操作以现有标准协议为核心：放置或更新物件、删除物件、调整锚点与方块，不按公司、建筑、楼层或空间编号写特殊分支。先 metaverse edit inspect 读取当前物件和版本，生成只包含标准 ops、可选资源列表与 baseSeq 的 JSON 编辑计划；用 metaverse edit check / push 核对范围、上传资源并返回原生预览，不需要用户编写脚本。家具、装饰、建筑、参数形状都走同一流程；background、距离显示与返回标记只是可选属性。普通 GLB 用 metaverse-recon content import，按需求设置位置、朝向与缩放；不强制背景身份、特定前缀或新地块。地图下载和楼内配准是可选内容提供工具，context 清单在入口转为同一标准编辑计划；只有真实需要地图时才读取重建技能的 context 参考。新范围可用 edit plan 生成布局计划，在已有管理权限且需求需要时应用并 pull。扫描重建与受保护重建层仍用现有重建包路径及相应权限。继续编辑从当前空间快照读取，不依赖旧 worker 或场景脚本。每次修改后更新预览，用户确认才 publish，并携带用户已确认的 rev；冲突时重新预览。已有资源按哈希复用，剖切与缓存沿用查看器通用能力。下载来源数据是任务所需的资源，不执行模型或压缩包中的程序。")
}
