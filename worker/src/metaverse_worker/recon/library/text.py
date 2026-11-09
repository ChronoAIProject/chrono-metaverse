"""检索用的文本处理：分词、简单词形还原、常见中文家具词 → 英文，以及小规模文档集的 BM25。"""

from __future__ import annotations

import math
import re
from collections import Counter

# 模型库的名称和标签几乎都是英文；大模型写中文描述时按这张表补上英文词
ZH_EN = {
    "沙发": "sofa couch",
    "单人沙发": "armchair",
    "双人": "loveseat two seat",
    "三人": "three seat",
    "扶手椅": "armchair",
    "椅": "chair",
    "椅子": "chair",
    "会议椅": "conference chair office chair",
    "办公椅": "office chair",
    "转椅": "swivel chair office chair",
    "凳": "stool",
    "吧凳": "bar stool",
    "桌": "table",
    "桌子": "table",
    "会议桌": "conference table meeting table",
    "茶几": "coffee table",
    "书桌": "desk",
    "办公桌": "desk",
    "边几": "side table",
    "柜": "cabinet",
    "柜子": "cabinet",
    "书架": "bookshelf shelf",
    "架": "shelf",
    "灯": "lamp",
    "落地灯": "floor lamp",
    "台灯": "table lamp",
    "吊灯": "pendant lamp",
    "植物": "plant",
    "绿植": "potted plant",
    "盆栽": "potted plant",
    "花盆": "pot planter",
    "电视": "tv television",
    "显示器": "monitor",
    "屏幕": "screen",
    "垃圾桶": "trash bin",
    "地毯": "rug carpet",
    "皮": "leather",
    "皮革": "leather",
    "布": "fabric",
    "木": "wood wooden",
    "金属": "metal",
    "玻璃": "glass",
    "米色": "beige",
    "白色": "white",
    "黑色": "black",
    "灰色": "gray grey",
    "棕色": "brown",
    "蓝色": "blue",
    "红色": "red",
    "绿色": "green",
    "现代": "modern",
    "简约": "minimal modern",
    "办公": "office",
}

STOP = {
    "a",
    "an",
    "the",
    "and",
    "or",
    "of",
    "with",
    "for",
    "in",
    "on",
    "to",
    "model",
    "3d",
    "free",
    "low",
    "poly",
    "lowpoly",
    "high",
    "game",
    "ready",
    "asset",
    "scan",
    "pbr",
    "obj",
    "fbx",
    "blend",
    "glb",
    "gltf",
}


def stem(w: str) -> str:
    if len(w) > 4 and w.endswith("ies"):
        return w[:-3] + "y"
    if len(w) > 3 and w.endswith("es") and w[-3] in "sxz":
        return w[:-2]
    if len(w) > 3 and w.endswith("s") and not w.endswith("ss"):
        return w[:-1]
    return w


def tokens(text: str) -> list[str]:
    if not text:
        return []
    text = text.replace("_", " ").replace("-", " ")
    words = re.findall(r"[a-z0-9]+", text.lower())
    return [stem(w) for w in words if w not in STOP and len(w) > 1]


def expand_query(query: str) -> list[str]:
    """查询词：英文分词 + 中文词按表换成英文（最长匹配优先）。"""
    extra = []
    rest = query
    for zh in sorted(ZH_EN, key=len, reverse=True):
        if zh in rest:
            extra.append(ZH_EN[zh])
            rest = rest.replace(zh, " ")
    out = tokens(rest + " " + " ".join(extra))
    return list(dict.fromkeys(out))


class BM25:
    """多字段 BM25：每个文档是 {字段: 文本}，字段权重乘到词频上。"""

    def __init__(
        self, docs: list[dict[str, str]], weights: dict[str, float], k1: float = 1.2, b: float = 0.75
    ):
        self.k1, self.b = k1, b
        self.tf: list[Counter] = []
        lengths = []
        df: Counter = Counter()
        for d in docs:
            c: Counter = Counter()
            for field, text in d.items():
                w = weights.get(field, 1.0)
                for tok in tokens(text):
                    c[tok] += w
            self.tf.append(c)
            lengths.append(sum(c.values()))
            df.update(set(c))
        self.n = len(docs)
        self.avg = (sum(lengths) / self.n) if self.n else 1.0
        self.len = lengths
        self.idf = {t: math.log(1 + (self.n - f + 0.5) / (f + 0.5)) for t, f in df.items()}

    def scores(self, query: list[str]) -> list[float]:
        out = []
        for c, ln in zip(self.tf, self.len, strict=True):
            s = 0.0
            for q in query:
                f = c.get(q, 0.0)
                if f:
                    s += (
                        self.idf.get(q, 0.0)
                        * f
                        * (self.k1 + 1)
                        / (f + self.k1 * (1 - self.b + self.b * ln / self.avg))
                    )
            out.append(s)
        return out
