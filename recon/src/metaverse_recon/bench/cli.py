"""`metaverse-recon`：本地重建工具（设计 8.3）。一切重建都在本地做，产出重建包，由命令行
`metaverse bundle push` 交给服务端；本工具只读写本地文件，不连接本服务，也不需要任何凭证。

工作台（给 AI 模型师——本地的 Claude Code / Codex 用）：大模型逐件重建一个空间，先去模型库搜一个看起来差不多的
现成模型摆进扫描里对照，搜不到或差太多（定制件）再自己手写参数形状。这里只做眼睛、尺子和裁判：

    metaverse-recon prepare  --scan mesh.drc --texture tex.jpg --hints hints.json --out base
    metaverse-recon views    --object sofa-01 --out out/sofa/views
    metaverse-recon measure  --object sofa-01 --out out/sofa/measure.json
    metaverse-recon search   --query "beige leather two-seat sofa" --category sofa --out out/sofa/search
    metaverse-recon fetch    --from out/sofa/search/candidates.json --pick 3
    metaverse-recon place    --object sofa-01 --candidate out/sofa/search/candidates.json#3 --out
    out/sofa/place
    metaverse-recon compare  --object counter-01 --model counter.json --out out/counter/compare
    metaverse-recon assemble --entities out/*/entity.json --out out/authored
    metaverse-recon reframe  --scan mesh.drc --from compute --to align --in model.json --out model2.json
    metaverse-recon refshot  --object table-01 --face top --out out/table/refshot
    metaverse-recon texture  --model table.json --part '$' --color tile.jpg --tile 1.3,1.0 --calibrate ...
    metaverse-recon texsearch --query "white marble" --out out/tex ；texfetch --from out/tex/candidates.json#2
    metaverse-recon doctor [--install]（检查渲染要用的 node、three、Playwright、Chromium、字体；装进缓存目录）

打包（在命令行工作区里时，扫描、变换、上限、基线、包目录都有默认值）：

    metaverse-recon align / webmodel / models / bake / fit / scan-zip
    metaverse-recon bundle --authored authored.json [--seed] [--webmodel scan-0.glb]
    metaverse-recon bundle --algorithm ；bundle --from-snapshot <工作区>

每个命令的参数见 `metaverse-recon <命令> -h`；完整教程见 docs/tutorials/reconstruct-with-ai.md。
"""

from __future__ import annotations

import argparse
import json
import sys

from .core import ReconError


def _common_base(p: argparse.ArgumentParser) -> None:
    p.add_argument(
        "--base",
        help="基线目录（prepare 的输出；默认 METAVERSE_RECON_BASE，工作区里是 out/recon，否则 ./base）",
    )
    p.add_argument("--scan", help="换一个对齐后的扫描 glb（默认 <基线>/scan.glb）")
    p.add_argument("--objects", help="换一个现有算法结果文件（默认 <基线>/objects.json）")


def _common_range(p: argparse.ArgumentParser, margin: float) -> None:
    g = p.add_argument_group("范围")
    g.add_argument("--object", help="物体编号（取基线里它的 bounds 作为包围盒，如 counter-01）")
    g.add_argument("--box", help="包围盒（空间坐标，米）：x0,y0,z0,x1,y1,z1；给了就不用 --object 的 bounds")
    g.add_argument("--margin", type=float, default=margin, help=f"包围盒外扩边距，米（默认 {margin}）")
    g.add_argument("--floor", type=float, help="地面高度（不给就从扫描里估计）")
    g.add_argument("--floor-keep", type=float, default=0.03, help="渲染时地面以下保留的厚度，米（默认 0.03）")
    _common_base(p)


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="metaverse-recon", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("source", help="Scaniverse 网格分享或本地 GLB/ZIP → 可重建的扫描来源")
    s.add_argument("source", help="Scaniverse 分享链接或本地 GLB/ZIP 路径")
    s.add_argument("--out", required=True, help="保存扫描与 source.json 的新目录")

    from ..context.workflow import add_parser

    add_parser(sub)

    from ..content import add_parser as add_content_parser

    add_content_parser(sub)

    # ---- prepare
    p = sub.add_parser("prepare", help="扫描 → 基线目录（对齐、结构、物体；与原处理服务首次导入的结果相同）")
    p.add_argument(
        "--scan", help="扫描：Scaniverse 式 zip、glb，或 drc（配 --texture）；工作区里默认 scan/scan.zip"
    )
    p.add_argument("--texture", help="drc 的贴图（打包成 zip 后按处理服务的方式读）")
    p.add_argument(
        "--transform",
        help="给定的变换（scan/transform.json 或 16 个数；已有空间重建时不重新对齐）；"
        "工作区里有 scan/transform.json 时默认用它",
    )
    p.add_argument("--auto-align", action="store_true", help="不用工作区的 scan/transform.json，重新自动对齐")
    p.add_argument("--hints", help="物体提示 JSON（空间坐标，格式与原处理服务导入扫描时的 hints 相同）")
    p.add_argument("--out", help="输出的基线目录（工作区里默认 out/recon）")
    p.add_argument("--max-texture", type=int, default=4096, help="scan.glb 贴图的最长边（默认 4096）")
    p.add_argument("--objects-target", help=argparse.SUPPRESS)

    # ---- views
    v = sub.add_parser("views", help="只渲染包围盒范围内的扫描，出带米制刻度的多角度图")
    _common_range(v, 0.3)
    v.add_argument("--out", required=True, help="输出目录")
    v.add_argument(
        "--front", type=float, default=0.0, help="物体正面朝向（度，SHAPES 偏航：0 = 正面朝 +Z，90 = 朝 +X）"
    )
    v.add_argument("--only", help="只出这些视图，逗号分隔：front,back,left,right,top,oblique,oblique-back")
    v.add_argument(
        "--cam", action="append", help="追加相机：名字:方位角,仰角[,ortho|persp]（空间方位角）；可重复"
    )
    v.add_argument("--cut", type=float, help="剖切高度：去掉 y 大于此值的部分（配合 --only top 看水平截面）")
    v.add_argument("--size", default="900x700", help="图片尺寸（默认 900x700）")
    v.add_argument("--max-bytes", type=int, default=200_000, help="每张 JPEG 的字节上限（默认 200000）")
    v.add_argument("--prefix", default="", help="输出文件名前缀")
    v.add_argument("--no-grid", action="store_true", help="正交图不画整幅淡网格（刻度尺仍保留）")
    v.add_argument("--no-near-clip", action="store_true", help="不裁掉视线近侧包围盒外 2 厘米以外的东西")

    # ---- measure
    m = sub.add_parser("measure", help="在范围内对扫描表面采样：尺寸、截面、剖面、平面、高度图、圆、颜色")
    _common_range(m, 0.02)
    m.add_argument("--out", required=True, help="输出 JSON 路径（图片写在同一目录）")
    m.add_argument(
        "--density", type=float, default=6000, help="采样密度，点/平方米（默认 6000，约 1.3 厘米间距）"
    )
    m.add_argument(
        "--floor-gap", type=float, default=0.02, help="去掉地面以上这个高度以内的点，米（默认 0.02）"
    )
    m.add_argument(
        "--exclude", action="append", help="不算这个框里的点：x0,y0,z0,x1,y1,z1（相邻物体）；可重复"
    )
    m.add_argument("--frame", help="局部坐标系 x,y,z,yaw：所有输入位置和输出坐标都换成 Ry(-yaw)·(p - 原点)")
    m.add_argument("--hslice", help="水平截面高度，逗号分隔（默认按物体高度取 20%%,50%%,80%%,97%%）")
    m.add_argument(
        "--vslice",
        action="append",
        help="竖直截面：x=7.0、z=5.9，或 p=x,z@yaw（过点、法线方位角 yaw 的竖直面）；可重复",
    )
    m.add_argument(
        "--band", type=float, default=0.0, help="截面在网格上精确求交；>0 时改用这么厚的采样点带（米）"
    )
    m.add_argument("--tol", type=float, default=0.005, help="截面折线简化容差，米（默认 0.005）")
    m.add_argument("--close", type=float, default=0.02, help="截面填充轮廓的闭合半径，米（默认 0.02）")
    m.add_argument("--step", type=float, default=0.05, help="按高度剖面表的层厚，米（默认 0.05）")
    m.add_argument("--occ", action="append", help="俯视占用图的高度区间 y0:y1（默认整个高度）；可重复")
    m.add_argument("--circle", action="append", help="圆拟合：y0:y1 或 y0:y1@x0,z0,x1,z1；可重复")
    m.add_argument("--color", action="append", help="颜色中位数子区域：名字=x0,y0,z0,x1,y1,z1；可重复")
    m.add_argument(
        "--plane",
        action="append",
        help="平面拟合（斜面朝向）：名字=x0,y0,z0,x1,y1,z1，框里的点拟合平面，给法向、坡度、方位、残差；可重复",
    )
    m.add_argument(
        "--heightmap",
        action="append",
        help="高度图数字表：y0:y1 或 y0:y1@x0,z0,x1,z1，每格的最高（或最低）点高度；可重复",
    )
    m.add_argument(
        "--hm-cell", type=float, default=0.05, help="高度图格子，米（默认 0.05；格子太多时自动放大）"
    )
    m.add_argument(
        "--hm-stat", choices=("top", "bottom"), default="top", help="高度图取最高点还是最低点（默认 top）"
    )

    # ---- compare
    c = sub.add_parser("compare", help="物件记录（形状或外部模型）与扫描、现有算法并排渲染并算偏差")
    _common_range(c, 0.3)
    c.add_argument(
        "--model", required=True, nargs="+", help="物件记录 JSON（单个 body、列表、AI 物件集……）；可给多个"
    )
    c.add_argument("--out", required=True, help="输出目录")
    c.add_argument(
        "--scene", action="store_true", help="多物件 / 整房对比：范围取全部物件的包围盒，逐个给偏差"
    )
    c.add_argument("--base-id", help="现有算法里对应物体的编号（默认同 --object 或记录里的 entityId）")
    c.add_argument("--front", type=float, default=0.0, help="正面方位角（同 views）")
    c.add_argument(
        "--angles",
        help="3 个角度：视图名逗号分隔（默认 oblique,front,top），或 方位角,仰角[,ortho] 用 ; 分隔",
    )
    c.add_argument("--columns", help="只出这些列：scan,base,new（默认三列）")
    c.add_argument("--cut", type=float, help="剖切高度（所有列都剖）")
    c.add_argument("--exclude", action="append", help="算偏差时不算这个框里的扫描点（相邻物体）；可重复")
    c.add_argument("--color-parts", action="store_true", help="新模型按部件着色（序号见输出的部件表）")
    c.add_argument("--no-structure", action="store_true", help="偏差计算不把墙和玻璃当背景")
    c.add_argument(
        "--models-dir", action="append", help="另外到这个目录找外部模型文件（默认只找 fetch 的缓存）"
    )
    c.add_argument(
        "--fit-margin", type=float, default=0.02, help="算偏差的扫描点范围：包围盒外扩，米（默认 0.02）"
    )
    c.add_argument("--floor-gap", type=float, default=0.02, help="算偏差时去掉地面以上这个高度以内的扫描点")
    c.add_argument("--density", type=float, default=3000, help="算偏差的扫描采样密度，点/平方米（默认 3000）")
    c.add_argument("--cell", default="600x460", help="并排图每格尺寸（默认 600x460）")
    c.add_argument(
        "--no-render", action="store_true", help="只算数字和偏差图，不出并排图（没有 Chromium 时自动跳过）"
    )

    _library_parsers(sub)
    _assemble_parsers(sub)
    _pipeline_parsers(sub)
    _texture_parsers(sub)

    d = sub.add_parser("doctor", help="检查渲染要用的 node、three、Playwright、Chromium、字体和缓存目录")
    d.add_argument(
        "--install",
        action="store_true",
        help="把 three 和 Playwright（含 Chromium）装进缓存目录（不在平台仓库里时用；要 node 和 npm）",
    )
    return ap


def _limits_arg(p) -> None:
    p.add_argument(
        "--limits", help="上传上限 limits.json（metaverse pull 写的；工作区里默认 limits.json，没有用默认值）"
    )


def _pipeline_parsers(sub) -> None:
    a = sub.add_parser("align", help="只算对齐：首次自动对齐，或重扫配准到参考扫描；写 transform.json")
    a.add_argument("--scan", help="扫描（工作区里默认 scan/scan.zip）")
    a.add_argument("--reference", help="参考扫描（重扫配准时）")
    a.add_argument("--reference-transform", help="参考扫描的变换（transform.json 或 16 个数）")
    a.add_argument(
        "--max-error-cm", type=float, default=3.0, help="配准误差超过它（厘米）时退出码非 0（默认 3）"
    )
    a.add_argument(
        "--out",
        help="输出（工作区里默认 scan/transform.json；误差超限时不写它，结果写到旁边的 *.candidate.json）",
    )
    a.add_argument(
        "--force",
        action="store_true",
        help="输出文件是 metaverse pull 写的线上变换时也覆盖（已有空间一般不要重新对齐）",
    )

    w = sub.add_parser("webmodel", help="生成网页用模型（两档 glb，保持扫描原坐标）")
    w.add_argument("--scan", help="扫描（工作区里默认 scan/scan.zip）")
    w.add_argument("--out", help="输出目录（scan-0.glb、scan-1.glb；工作区里默认 web/）")
    _limits_arg(w)

    m = sub.add_parser("models", help="外部模型：找本地文件或下载、核对，按物件模型的上限导出 glb")
    m.add_argument("--authored", required=True, help="AI 物件集（authored.json）")
    m.add_argument("--out", required=True, help="输出目录（<哈希前 12 位>.glb、models.json）")
    m.add_argument(
        "--models-dir", action="append", help="另外到这个目录找模型文件（fetch 的旁注 model.json）"
    )
    m.add_argument("--only", help="只导出这些物件，逗号分隔")
    m.add_argument("--offline", action="store_true", help="不下载，本地没有就报错")
    m.add_argument("--render", action="store_true", help="每个导出的文件出一张对照图（导出后 | 原文件）")
    _limits_arg(m)

    b = sub.add_parser("bake", help="烘焙：物件集里带 bake 的部件从扫描取色写成贴图，输出新的物件集")
    b.add_argument("--authored", required=True, help="AI 物件集")
    b.add_argument("--out", required=True, help="输出目录（authored.json、textures/）")
    _common_base(b)

    f = sub.add_parser("fit", help="逐件偏差（与 compare、打包写进记录的 fit 同一个函数）")
    f.add_argument("--authored", required=True, help="物件集或物件文件")
    f.add_argument("--out", help="输出 JSON")
    f.add_argument("--models-dir", action="append", help="另外到这个目录找外部模型文件")
    _common_base(f)

    z = sub.add_parser("scan-zip", help="把扫描成员按接口服务部署种子的规则打成 zip（哈希与线上相同）")
    z.add_argument("--sources", help="来源表 sources.json（按 --hash 或唯一的 zip 条目下载成员）")
    z.add_argument("--hash", help="期望的 zip 哈希（来源表的键）；打出来不同就报错")
    z.add_argument("--member", action="append", help="成员名=本地文件（按给出的顺序）；可重复")
    z.add_argument("--out", help="输出（工作区里默认 scan/scan.zip）")

    k = sub.add_parser("bundle", help="打包：物件集或算法结果 → 重建包目录（manifest.json + 文件）")
    k.add_argument("--authored", help="AI 物件集")
    k.add_argument("--algorithm", action="store_true", help="不用物件集，直接用算法的结构和物体")
    k.add_argument("--from-snapshot", help="用拉下来的快照（工作区目录）生成整体替换的包，不读扫描、不重建")
    k.add_argument("--scan", help="扫描（工作区里默认 scan/scan.zip）")
    k.add_argument("--transform", help="变换（工作区里默认 scan/transform.json）")
    k.add_argument(
        "--webmodel", action="append", help="用已有的网页用模型（第一个是默认档，可再给低细节档）；不给就生成"
    )
    k.add_argument("--hints", help="物体提示 JSON（--algorithm 时）")
    k.add_argument(
        "--anchors",
        action="store_true",
        help="--algorithm 时把按类别建议的锚点也放进包（默认只列出建议，不建：锚点公开、只增不删）",
    )
    k.add_argument("--out", help="包目录（工作区里默认 out/bundle）")
    k.add_argument("--note", help="清单的说明（发布时的默认提交说明）")
    k.add_argument("--notes", help="建模记录（Markdown，作为提交的 scriptRef；默认用物件集的 notes）")
    k.add_argument("--observed-at", help="扫描的拍摄时间（RFC 3339；不给时服务端沿用上一次）")
    k.add_argument(
        "--seed", action="store_true", help="种子用的包：去掉内部级锚点和建模记录，report 只留偏差统计"
    )
    k.add_argument("--no-base", action="store_true", help="清单不写 base（推送时要 --base latest）")
    k.add_argument("--no-check", action="store_true", help="不调用 metaverse bundle check")
    k.add_argument("--models-dir", action="append", help="另外到这个目录找外部模型文件")
    k.add_argument("--textures-dir", action="append", help="另外到这个目录按哈希找贴图（<哈希>.<扩展名>）")
    _limits_arg(k)
    k.add_argument("--base", help="基线目录（按哈希找基线算出的贴图；工作区里默认 out/recon）")


def _texture_parsers(sub) -> None:
    r = sub.add_parser(
        "refshot", help="从扫描对物件的一个面做正交展开：参考图 + 每像素米数、中位色、建议平铺"
    )
    _common_range(r, 0.0)
    r.add_argument(
        "--face", default="top", help="面：top、bottom、front、back、left、right（物件朝向用 --front）"
    )
    r.add_argument("--front", type=float, default=0.0, help="物件正面方位角（度，同 views）")
    r.add_argument("--depth", type=float, default=0.03, help="面前后取多厚的扫描表面，米（默认 0.03）")
    r.add_argument("--px", type=float, default=0.003, help="每像素米数（默认 0.003）")
    r.add_argument("--texture", help="扫描的原始贴图（更清楚；贴图坐标与基线 scan.glb 相同）")
    r.add_argument("--out", required=True, help="输出目录（refshot.png、refshot.json）")

    x = sub.add_parser(
        "texture", help="把颜色、法线、粗糙度贴图写进物件的工作副本（{file} 引用），可标定、出对比图"
    )
    x.add_argument("--model", required=True, help="物件文件（会写回这个文件，旧的存成 .bak）")
    x.add_argument("--entity", help="物件编号（文件里有几个时）")
    x.add_argument("--part", default="$", help="部件路径（$ 是整个形状，$.children[2] 是第三个子形状）")
    x.add_argument("--color", help="颜色贴图（png/jpg/webp）")
    x.add_argument("--normal", help="法线贴图（OpenGL 约定）")
    x.add_argument("--roughness", help="粗糙度贴图（灰度，白 = 粗糙）")
    x.add_argument("--uv", default="planar", help="贴图坐标：box、planar、cylindrical、mesh（默认 planar）")
    x.add_argument("--tile", help="每重复一次的尺寸，米：u,v")
    x.add_argument("--offset", help="贴图坐标平移，米：u,v")
    x.add_argument("--rotate", type=float, help="贴图逆时针转的角度")
    x.add_argument("--shading", choices=("albedo", "baked"), default="albedo", help="着色方式（默认 albedo）")
    x.add_argument("--refshot", help="refshot.json：--calibrate 用它的中位色")
    x.add_argument("--calibrate", action="store_true", help="在网站光照下标定整体增益，烘进贴图副本")
    x.add_argument("--preview", help="对比图输出（扫描 | 之前 | 之后），给了就出图并算色差")
    x.add_argument(
        "--textures-dir", default="textures", help="贴图副本放在物件文件旁边的这个目录（默认 textures）"
    )
    _common_base(x)

    s = sub.add_parser("texsearch", help="在材质库（Poly Haven、ambientCG，只要 CC0）里找贴图")
    s.add_argument("--query", required=True, help="描述（英文，如 'white marble'）")
    s.add_argument("--library", action="append", choices=("polyhaven", "ambientcg"), help="材质库，可重复")
    s.add_argument("--limit", type=int, default=12, help="候选数（默认 12）")
    s.add_argument("--out", required=True, help="输出目录（candidates.json、sheet.jpg）")

    f = sub.add_parser("texfetch", help="下载材质：颜色、法线（转 OpenGL 约定）、粗糙度，记录实际尺寸和许可")
    f.add_argument("--from", dest="source", help="texsearch 的 candidates.json#编号")
    f.add_argument("--library", choices=("polyhaven", "ambientcg"), help="不用候选清单时：材质库")
    f.add_argument("--id", help="不用候选清单时：材质编号")
    f.add_argument("--resolution", default="1k", help="分辨率（默认 1k）")
    f.add_argument("--out", help="输出目录（默认 <缓存>/textures/<库>/<编号>）")


def _library_parsers(sub) -> None:
    from .library.search import LIBRARIES

    s = sub.add_parser("search", help="在模型库里检索（只要 CC0 / CC-BY），输出候选清单和带编号的缩略图拼图")
    s.add_argument("--query", required=True, help="描述（英文效果最好，如 'beige leather two-seat sofa'）")
    s.add_argument(
        "--library",
        action="append",
        choices=LIBRARIES,
        help="模型库，可重复（默认 polyhaven + objaverse；sketchfab 要设 SKETCHFAB_TOKEN）",
    )
    s.add_argument("--category", help="类别（如 sofa、chair、table），Objaverse 按 LVIS 类别优先")
    s.add_argument("--max-faces", type=int, default=300_000, help="三角形数上限（默认 300000）")
    s.add_argument("--limit", type=int, default=12, help="候选数（默认 12）")
    s.add_argument("--size", help="扫描量出的尺寸 宽,高,深（米），按比例相近的优先（有尺寸数据的库）")
    s.add_argument("--out", required=True, help="输出目录（candidates.json、sheet.jpg）")
    s.add_argument(
        "--max-new-shards",
        type=int,
        default=48,
        help="Objaverse：这次最多新下载多少个元数据分片（每个约 3.6 MB；默认 48）",
    )
    s.add_argument("--offline", action="store_true", help="只用本地缓存，不联网")

    i = sub.add_parser("index", help="预先下载 Objaverse 元数据、建本地检索索引")
    i.add_argument("--category", action="append", help="优先下载这些 LVIS 类别所在的分片；可重复")
    i.add_argument("--shards", type=int, default=16, help="这次新下载的分片数（默认 16）")
    i.add_argument("--all", action="store_true", help="下载全部 160 个分片（约 580 MB）")

    f = sub.add_parser(
        "fetch", help="下载候选模型（glb；Poly Haven 的 glTF 打包成 glb），记录哈希、大小、署名"
    )
    f.add_argument("--from", dest="source", help="search 输出的 candidates.json")
    f.add_argument("--pick", help="候选编号（拼图上的数字），逗号分隔")
    f.add_argument("--library", choices=LIBRARIES, help="不用候选清单时：模型库")
    f.add_argument("--id", help="不用候选清单时：模型编号")
    f.add_argument("--resolution", default="1k", help="Poly Haven 贴图分辨率（默认 1k）")
    f.add_argument(
        "--max-bytes", type=int, default=50 << 20, help="单个模型的大小上限（默认 50 MB，与处理服务相同）"
    )
    f.add_argument("--out", help="把下载结果清单写到这个文件")

    p = sub.add_parser("place", help="把候选模型摆到扫描里的某个物体上：向上轴、缩放、偏航 + 平移细化、落地")
    p.add_argument(
        "--candidate",
        required=True,
        help="候选：candidates.json#编号、fetch 写的 model.json，或 库:编号（如 objaverse:<uid>）",
    )
    _common_range(p, 0.3)
    p.add_argument("--out", required=True, help="输出目录（entity.json、place.jpg、place.json）")
    p.add_argument("--entity-id", help="物件编号（默认同 --object）")
    p.add_argument("--label", help="标签（默认取现有算法物体的标签）")
    p.add_argument("--up", default="auto", help="模型的向上轴：auto（默认）、+y、+z、-z、+x、-x、-y")
    p.add_argument(
        "--scale",
        choices=("uniform", "axis", "none"),
        default="uniform",
        help="缩放：uniform 等比（默认）；axis 逐轴（限 ±15%%）；none 保持原尺寸",
    )
    p.add_argument("--axis-limit", type=float, default=0.15, help="逐轴缩放相对等比的上限（默认 0.15）")
    p.add_argument("--yaw", type=float, help="只试这个偏航附近（±--yaw-range 度）")
    p.add_argument("--yaw-range", type=float, default=20.0, help="配合 --yaw（默认 ±20 度）")
    p.add_argument("--yaw-steps", type=int, default=24, help="偏航粗搜的角度数（默认 24，即每 15 度）")
    p.add_argument("--exclude", action="append", help="不算这个框里的扫描点（相邻物体）；可重复")
    p.add_argument(
        "--no-snap", action="store_true", help="不把偏航落到墙或物体外接矩形的方向（默认相差 10° 以内会试）"
    )
    p.add_argument("--front", type=float, help="对比图的正面方位角（默认看扫描水平外接矩形的长边）")
    p.add_argument("--tint", action="store_true", help="把按扫描颜色算出的 tint 写进记录（默认只给建议）")
    p.add_argument("--floor-gap", type=float, default=0.02, help="去掉离局部地面这么高以内的扫描点")
    p.add_argument("--density", type=float, default=3000, help="扫描采样密度，点/平方米（默认 3000）")
    p.add_argument("--cell", default="600x460", help="对比图每格尺寸")
    p.add_argument("--no-render", action="store_true", help="不出对比图（没有 Chromium 时自动跳过）")


def _assemble_parsers(sub) -> None:
    a = sub.add_parser(
        "assemble", help="合并物件文件成 AI 物件集（authored.json），出整房预览、对比图、偏差表、漏建清单"
    )
    _common_base(a)
    a.add_argument(
        "--entities", required=True, nargs="+", help="物件文件或目录（目录里找 entity.json / *.json）"
    )
    a.add_argument("--out", required=True, help="输出目录")
    a.add_argument(
        "--structure",
        choices=("keep", "replace"),
        default="keep",
        help="keep：结构沿用算法结果（默认）；replace：用物件里 kind=structure 的",
    )
    a.add_argument("--notes", help="建模过程记录（Markdown 文件，≤ 64KB）")
    a.add_argument("--models-dir", action="append", help="另外到这个目录找外部模型文件")
    a.add_argument("--cut", type=float, help="对比图的剖切高度（默认按结构自动去掉天花板）")
    a.add_argument("--density", type=float, default=600, help="偏差的扫描采样密度，点/平方米（默认 600）")
    a.add_argument("--cell", default="560x420", help="对比图每格尺寸")
    a.add_argument("--no-render", action="store_true", help="不出对比图（整房预览 glb 和偏差表照出）")

    r = sub.add_parser("reframe", help="把物件在两个对齐坐标系之间换算（compute ↔ align 或任意变换）")
    r.add_argument("--scan", required=True, help="两种对齐都基于的原始扫描（drc / glb / zip）")
    r.add_argument("--texture", help="drc 的贴图（不影响对齐）")
    r.add_argument(
        "--from",
        dest="src",
        default="compute",
        help="原坐标系：compute（reconstruct_lobby.py 的 compute_alignment）、"
        "align（自动对齐；旧名 scan_import）、或变换文件",
    )
    r.add_argument("--to", dest="dst", default="align", help="目标坐标系（同上；默认 align）")
    r.add_argument("--in", dest="inp", required=True, nargs="+", help="物件文件（任意 compare 能读的格式）")
    r.add_argument("--out", required=True, help="输出文件（一个输入时）或目录（多个输入时）")
    r.add_argument(
        "--max-tilt",
        type=float,
        default=0.5,
        help="两个坐标系的倾斜差不超过这个角度（度）时只改偏航和位置，否则套一层 group（默认 0.5）",
    )


PIPELINE = {
    "align": "cmd_align",
    "webmodel": "cmd_webmodel",
    "models": "cmd_models",
    "bake": "cmd_bake",
    "fit": "cmd_fit",
    "scan-zip": "cmd_scan_zip",
    "bundle": "cmd_bundle",
}


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.cmd == "content":
            from ..content import cmd_content

            print(json.dumps(cmd_content(args), ensure_ascii=False, indent=2))
        elif args.cmd == "context":
            from ..context.workflow import cmd_context

            print(json.dumps(cmd_context(args), ensure_ascii=False, indent=2))
        elif args.cmd == "source":
            from .source import cmd_source

            cmd_source(args)
        elif args.cmd == "prepare":
            from .prepare import cmd_prepare

            cmd_prepare(args)
        elif args.cmd == "views":
            from .views import cmd_views

            cmd_views(args)
        elif args.cmd == "measure":
            from .measure import cmd_measure

            cmd_measure(args)
        elif args.cmd == "compare":
            from .compare import cmd_compare

            cmd_compare(args)
        elif args.cmd == "search":
            from .library.search import cmd_search

            cmd_search(args)
        elif args.cmd == "index":
            from .library.objaverse import cmd_index

            cmd_index(args)
        elif args.cmd == "fetch":
            from .library.fetch import cmd_fetch

            cmd_fetch(args)
        elif args.cmd == "place":
            from .library.place import cmd_place

            cmd_place(args)
        elif args.cmd == "assemble":
            from .assemble import cmd_assemble

            cmd_assemble(args)
        elif args.cmd == "reframe":
            from .reframe import cmd_reframe

            cmd_reframe(args)
        elif args.cmd in PIPELINE:
            from . import commands

            getattr(commands, PIPELINE[args.cmd])(args)
        elif args.cmd in ("refshot", "texture"):
            from . import texwork

            getattr(texwork, f"cmd_{args.cmd}")(args)
        elif args.cmd in ("texsearch", "texfetch"):
            from .library import textures

            getattr(textures, f"cmd_{args.cmd}")(args)
        elif args.cmd == "doctor":
            from .env import describe, install

            if args.install:
                install()
            print(json.dumps(describe(), ensure_ascii=False, indent=1))
    except ReconError as e:
        print(f"错误：{e.message}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        return 130
    return 0


if __name__ == "__main__":
    sys.exit(main())
