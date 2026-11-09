"""重建工作台：给"AI 模型师"用的眼睛（views）、尺子（measure）和对照（compare）。

    python tools/wb.py views   --object counter-01 --out out/views
    python tools/wb.py measure --object counter-01 --out out/measure.json
    python tools/wb.py compare --object counter-01 --model my_counter.json --out out/compare

详细参数见 tools/README.md 或 `python tools/wb.py <命令> -h`。
"""

from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import wbcore as wc


def common(p: argparse.ArgumentParser, margin: float) -> None:
    g = p.add_argument_group("范围与数据")
    g.add_argument("--object", help="物体编号（从 --objects 里取 bounds 作为包围盒，如 counter-01）")
    g.add_argument("--box", help="包围盒（空间坐标，米）：x0,y0,z0,x1,y1,z1；给了就不用 --object 的 bounds")
    g.add_argument("--margin", type=float, default=margin, help=f"包围盒外扩边距，米（默认 {margin}）")
    g.add_argument("--scan", default=os.path.join(wc.BASE, "scan.glb"), help="扫描 glb（默认 base/scan.glb）")
    g.add_argument(
        "--objects",
        default=os.path.join(wc.BASE, "objects.json"),
        help="现有算法结果（默认 base/objects.json）",
    )
    g.add_argument("--floor", type=float, help="地面高度（不给就从扫描里估计）")
    g.add_argument("--floor-keep", type=float, default=0.03, help="渲染时地面以下保留的厚度，米（默认 0.03）")


def main() -> None:
    ap = argparse.ArgumentParser(prog="wb.py", description="重建工作台：views / measure / compare")
    sub = ap.add_subparsers(dest="cmd", required=True)

    v = sub.add_parser("views", help="只渲染包围盒范围内的扫描，出带米制刻度的多角度图")
    common(v, 0.3)
    v.add_argument("--out", required=True, help="输出目录")
    v.add_argument("--front", type=float, default=0.0,
                   help="物体正面朝向的方位角（度，SHAPES 的 yaw 约定：0 = 正面朝 +Z，90 = 朝 +X）")  # fmt: skip
    v.add_argument("--only", help="只出这些视图，逗号分隔：front,back,left,right,top,oblique,oblique-back")
    v.add_argument(
        "--cam",
        action="append",
        help="追加任意相机：名字:方位角,仰角[,ortho|persp]（空间方位角，0 = 相机在 +Z 侧）；可重复",
    )
    v.add_argument("--cut", type=float, help="剖切高度：去掉 y 大于此值的部分（配合 --only top 看水平截面）")
    v.add_argument("--size", default="900x700", help="图片尺寸（默认 900x700）")
    v.add_argument("--max-bytes", type=int, default=200_000, help="每张 JPEG 的字节上限（默认 200000）")
    v.add_argument("--prefix", default="", help="输出文件名前缀")
    v.add_argument("--no-grid", action="store_true", help="正交图不画整幅淡网格（刻度尺仍保留）")
    v.add_argument("--no-near-clip", action="store_true", help="不裁掉视线近侧包围盒外 2 厘米以外的东西")

    m = sub.add_parser("measure", help="在范围内对扫描表面采样，输出尺寸、截面、剖面、圆拟合、颜色")
    common(m, 0.02)
    m.add_argument("--out", required=True, help="输出 JSON 路径（占用图 PNG 写在同一目录）")
    m.add_argument(
        "--density", type=float, default=6000, help="采样密度，点/平方米（默认 6000，约 1.3 厘米间距）"
    )
    m.add_argument(
        "--floor-gap", type=float, default=0.02, help="去掉地面以上这个高度以内的点，米（默认 0.02）"
    )
    m.add_argument("--frame", help="局部坐标系 x,y,z,yaw：所有输入位置和输出坐标都换成 Ry(-yaw)·(p - 原点)")
    m.add_argument("--hslice", help="水平截面高度，逗号分隔（默认按物体高度取 20%%,50%%,80%%,97%%）")
    m.add_argument("--vslice", action="append",
                   help="竖直截面：x=7.0（垂直于 X 轴）、z=5.9，或 p=x,z@yaw（过点、法线方位角 yaw 的竖直面）；可重复")  # fmt: skip
    m.add_argument(
        "--band", type=float, default=0.0, help="截面在网格上精确求交；>0 时改用这么厚的采样点带（米）"
    )
    m.add_argument("--tol", type=float, default=0.005, help="截面折线简化容差，米（默认 0.005）")
    m.add_argument("--close", type=float, default=0.02, help="截面填充轮廓的闭合半径，米（默认 0.02）")
    m.add_argument("--step", type=float, default=0.05, help="按高度剖面表的层厚，米（默认 0.05）")
    m.add_argument("--occ", action="append", help="俯视占用图的高度区间 y0:y1（默认整个高度）；可重复")
    m.add_argument(
        "--circle",
        action="append",
        help="圆拟合：y0:y1 或 y0:y1@x0,z0,x1,z1（只取这个水平矩形里的点）；可重复",
    )
    m.add_argument("--color", action="append", help="颜色中位数子区域：名字=x0,y0,z0,x1,y1,z1；可重复")

    c = sub.add_parser("compare", help="把模型师写的物件记录和扫描、现有算法并排渲染并算偏差")
    common(c, 0.3)
    c.add_argument(
        "--model", required=True, help="模型师写的物件记录 JSON（单个 body、列表或 {entityId: body}）"
    )
    c.add_argument("--out", required=True, help="输出目录")
    c.add_argument("--base-id", help="现有算法里对应物体的 entityId（默认同 --object 或记录里的 entityId）")
    c.add_argument("--front", type=float, default=0.0, help="正面方位角（同 views）")
    c.add_argument("--angles", default="oblique,front,top",
                   help="3 个角度：视图名或 方位角,仰角[,ortho] 用 ; 分隔（默认 oblique,front,top）")  # fmt: skip
    c.add_argument("--cut", type=float, help="剖切高度（三列都剖）")
    c.add_argument(
        "--fit-margin", type=float, default=0.02, help="算偏差的扫描点范围：包围盒外扩，米（默认 0.02）"
    )
    c.add_argument(
        "--floor-gap", type=float, default=0.02, help="算偏差时去掉地面以上这个高度以内的扫描点（默认 0.02）"
    )
    c.add_argument("--density", type=float, default=3000, help="算偏差的扫描采样密度，点/平方米（默认 3000）")
    c.add_argument("--cell", default="600x460", help="并排图每格尺寸（默认 600x460）")

    args = ap.parse_args()
    if args.cmd == "views":
        from wbviews import cmd_views

        cmd_views(args)
    elif args.cmd == "measure":
        from wbmeasure import cmd_measure

        cmd_measure(args)
    else:
        from wbcompare import cmd_compare

        cmd_compare(args)


if __name__ == "__main__":
    main()
