"""Objaverse 1.0（https://huggingface.co/datasets/allenai/objaverse）：约 80 万个 Sketchfab 模型的 glb 镜像，
**每个对象有自己的许可**（元数据里的 `license`），只保留 CC0 和 CC-BY（`licenses.normalize`）。

本地索引（`<缓存>/objaverse/index.sqlite`，SQLite FTS5，按 BM25 排序）：

- `lvis-annotations.json.gz`（约 1 MB）：约 4.6 万个对象的 LVIS 类别（chair、sofa、armchair、table……）；
- `object-paths.json.gz`（约 20 MB）：对象 → glb 路径（`glbs/000-023/<uid>.glb`，目录名就是元数据分片名）；
- `metadata/<分片>.json.gz`（160 个，每个约 3.6 MB、5000 个对象）：名称、标签、类别、描述、作者、许可、面数、
  缩略图。**增量下载**：检索时只下载这次需要的分片（按 LVIS 类别匹配到的对象所在的分片优先），解析后只把
  许可允许的对象写进索引，原始分片不保留。不会下载任何模型文件，模型由 fetch 按需单个下载。

缩略图在 media.sketchfab.com，模型页是 Sketchfab 的原页面（署名用）。
"""

from __future__ import annotations

import gzip
import json
import os
import sqlite3
import threading
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from ..core import ReconError, log
from ..env import cache_dir
from . import http
from .licenses import normalize
from .text import expand_query, tokens

HF = "https://huggingface.co/datasets/allenai/objaverse/resolve/main"
SHARDS = [f"{a:03d}-{b:03d}" for a in range(1) for b in range(160)]
SCHEMA = """
CREATE TABLE IF NOT EXISTS shards(shard TEXT PRIMARY KEY, objects INTEGER, kept INTEGER, at REAL);
CREATE TABLE IF NOT EXISTS lvis(uid TEXT, category TEXT);
CREATE INDEX IF NOT EXISTS lvis_uid ON lvis(uid);
CREATE INDEX IF NOT EXISTS lvis_cat ON lvis(category);
CREATE TABLE IF NOT EXISTS paths(uid TEXT PRIMARY KEY, shard TEXT);
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
CREATE VIRTUAL TABLE IF NOT EXISTS objects USING fts5(
  uid UNINDEXED, name, tags, categories, lvis, description,
  author UNINDEXED, author_url UNINDEXED, license UNINDEXED, faces UNINDEXED, thumb UNINDEXED,
  shard UNINDEXED, likes UNINDEXED, page UNINDEXED,
  tokenize = 'porter unicode61'
);
"""
WEIGHTS = (0.0, 6.0, 2.5, 1.5, 4.0, 0.6)  # uid, name, tags, categories, lvis, description（bm25 越小越好）


def db_path() -> Path:
    return Path(os.environ.get("METAVERSE_RECON_OBJAVERSE_DB") or cache_dir() / "objaverse" / "index.sqlite")


def connect() -> sqlite3.Connection:
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path, check_same_thread=False)
    con.executescript(SCHEMA)
    return con


# ---------------------------------------------------------------------------- 元数据下载与入索引


def _meta(con, key: str) -> str | None:
    row = con.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return row[0] if row else None


def ensure_lvis(con, offline: bool = False) -> None:
    if _meta(con, "lvis"):
        return
    if offline:
        return
    path = http.cached(
        f"{HF}/lvis-annotations.json.gz", "objaverse", suffix=".lvis.json.gz", max_bytes=16 << 20
    )
    data = json.loads(gzip.decompress(path.read_bytes()))
    rows = [(uid, cat) for cat, uids in data.items() for uid in uids]
    with con:
        con.execute("DELETE FROM lvis")
        con.executemany("INSERT INTO lvis(uid, category) VALUES (?, ?)", rows)
        con.execute("INSERT OR REPLACE INTO meta VALUES ('lvis', ?)", (str(len(rows)),))
    log(f"  Objaverse：LVIS 类别 {len(data)} 个，{len(rows)} 个对象")


def ensure_paths(con, offline: bool = False) -> None:
    """对象 → 分片（只存分片名；glb 路径 = glbs/<分片>/<uid>.glb）。"""
    if _meta(con, "paths") or offline:
        return
    log("  Objaverse：下载对象路径表（约 20 MB，只下载一次）…")
    path = http.cached(f"{HF}/object-paths.json.gz", "objaverse", suffix=".paths.json.gz", max_bytes=64 << 20)
    data = json.loads(gzip.decompress(path.read_bytes()))
    rows = [(uid, p.split("/")[1]) for uid, p in data.items() if p.count("/") == 2]
    with con:
        con.execute("DELETE FROM paths")
        con.executemany("INSERT INTO paths(uid, shard) VALUES (?, ?)", rows)
        con.execute("INSERT OR REPLACE INTO meta VALUES ('paths', ?)", (str(len(rows)),))
    path.unlink(missing_ok=True)  # 已经进了索引，原文件不留
    log(f"  Objaverse：{len(rows)} 个对象的路径")


def _thumb(info: dict) -> str:
    imgs = (info.get("thumbnails") or {}).get("images") or []
    best = None
    for im in imgs:
        w = im.get("width") or 0
        if best is None or abs(w - 256) < abs((best.get("width") or 0) - 256):
            best = im
    return (best or {}).get("url") or ""


def object_rows(shard: str, data: dict, lvis: dict[str, str]) -> tuple[list[tuple], int]:
    rows = []
    for uid, info in data.items():
        lic = normalize(info.get("license"))
        if lic is None or info.get("isAgeRestricted"):
            continue
        user = info.get("user") or {}
        rows.append(
            (
                uid,
                info.get("name") or "",
                " ".join(t.get("name", "") for t in info.get("tags") or []),
                " ".join(c.get("name", "") for c in info.get("categories") or []),
                lvis.get(uid, "").replace("_", " "),
                (info.get("description") or "")[:400],
                user.get("displayName") or user.get("username") or "",
                user.get("profileUrl") or "",
                lic,
                int(info.get("faceCount") or 0),
                _thumb(info),
                shard,
                int(info.get("likeCount") or 0),
                info.get("viewerUrl") or f"https://sketchfab.com/3d-models/{uid}",
            )
        )
    return rows, len(data)


def index_shards(con, shards: list[str], workers: int = 4) -> int:
    """下载并索引这些分片（并行下载，单线程写库）。返回新收录的对象数。"""
    if not shards:
        return 0
    lvis = dict(con.execute("SELECT uid, category FROM lvis").fetchall())
    lock = threading.Lock()
    kept_total = 0

    def one(shard: str):
        data = json.loads(
            gzip.decompress(http.get_bytes(f"{HF}/metadata/{shard}.json.gz", max_bytes=64 << 20))
        )
        return shard, *object_rows(shard, data, lvis)

    done = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for shard, rows, total in pool.map(one, shards):
            with lock, con:
                con.execute("DELETE FROM objects WHERE shard = ?", (shard,))
                con.executemany("INSERT INTO objects VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
                con.execute(
                    "INSERT OR REPLACE INTO shards VALUES (?, ?, ?, strftime('%s','now'))",
                    (shard, total, len(rows)),
                )
            kept_total += len(rows)
            done += 1
            if done % 8 == 0 or done == len(shards):
                log(
                    f"  Objaverse：已下载 {done}/{len(shards)} 个分片（这次收录 {kept_total} "
                    "个许可允许的对象）"
                )
    return kept_total


def indexed(con) -> set[str]:
    return {r[0] for r in con.execute("SELECT shard FROM shards")}


def lvis_categories(con, words: list[str]) -> list[str]:
    """查询词对应的 LVIS 类别（类别名按 _ 拆开的词里有查询词，如 chair → chair、folding_chair）。"""
    cats = [r[0] for r in con.execute("SELECT DISTINCT category FROM lvis")]
    want = set(words)
    out = []
    for c in cats:
        parts = {w for w in tokens(c.replace("(", " ").replace(")", " "))}
        if parts & want:
            out.append(c)
    return out


def shards_for(con, categories: list[str]) -> list[str]:
    """这些 LVIS 类别的对象所在的分片，按对象数从多到少。"""
    if not categories:
        return []
    q = ",".join("?" * len(categories))
    rows = con.execute(
        f"SELECT p.shard FROM lvis l JOIN paths p ON p.uid = l.uid WHERE l.category IN ({q})", categories
    )
    counts = Counter(r[0] for r in rows)
    return [s for s, _ in counts.most_common()]


def grow_index(con, words: list[str], max_new: int, offline: bool) -> dict:
    """按查询词增量下载分片。返回状态（已收录分片数、这次新下载的、匹配到的 LVIS 类别）。"""
    ensure_lvis(con, offline)
    cats = lvis_categories(con, words)
    have = indexed(con)
    new: list[str] = []
    if not offline and max_new > 0:
        if cats:
            ensure_paths(con, offline)
        wanted = [s for s in shards_for(con, cats) if s not in have]
        if not wanted:
            wanted = [s for s in SHARDS if s not in have]
        new = wanted[:max_new]
        if new:
            log(
                f"  Objaverse：下载 {len(new)} 个元数据分片（每个约 3.6 MB）"
                + (f"，按 LVIS 类别 {', '.join(cats[:6])} 优先" if cats else "")
            )
            index_shards(con, new)
    return {
        "shardsIndexed": len(indexed(con)),
        "shardsTotal": len(SHARDS),
        "newShards": len(new),
        "lvis": cats,
    }


def _fts_query(words: list[str]) -> str:
    return " OR ".join(f'"{w}"' for w in words if w.isalnum())


def search(
    query: str,
    category: str | None,
    max_faces: int,
    limit: int,
    max_new_shards: int = 48,
    offline: bool = False,
) -> tuple[list[dict], dict]:
    con = connect()
    try:
        words = expand_query(" ".join(x for x in (query, category or "") if x))
        cat_words = expand_query(category) if category else []
        try:
            status = grow_index(con, cat_words or words, max_new_shards, offline)
        except http.DownloadError as e:
            log(f"  Objaverse：{e}（只用已有的索引）")
            status = {"shardsIndexed": len(indexed(con)), "shardsTotal": len(SHARDS), "error": str(e)}
        fts = _fts_query(words)
        if not fts:
            return [], status
        sql = (
            "SELECT uid, name, tags, categories, lvis, description, author, author_url, license, faces, "
            "thumb, shard,"
            " likes, page, bm25(objects, ?, ?, ?, ?, ?, ?) AS s FROM objects WHERE objects MATCH ? AND faces "
            "<= ?"
            " ORDER BY s LIMIT ?"
        )
        rows = con.execute(sql, (*WEIGHTS, fts, max_faces, max(200, limit * 20))).fetchall()
    finally:
        con.close()
    cats = set(status.get("lvis") or []) if cat_words else set()
    out = []
    for row in rows:
        uid, name, tags, cats_, lvis, desc, author, author_url, lic, faces, thumb, shard, likes, page, s = row
        if normalize(lic) is None:  # 再查一次（索引是旧版本写的也不会漏过）
            continue
        # 指定了类别：LVIS 标了别的类别的不要；没标的按名称、标签里有类别词才要
        other = lvis or not set(cat_words) & set(tokens(f"{name} {tags} {cats_}"))
        if cats and lvis.replace(" ", "_") not in cats and other:
            continue
        score = -s + (2.0 if lvis and lvis.replace(" ", "_") in cats else 0.0) + min(likes, 200) / 400
        out.append(
            {
                "library": "objaverse",
                "id": uid,
                "title": name or uid,
                "author": author or "unknown",
                "authorUrl": author_url,
                "license": lic,
                "page": page,
                "faceCount": faces or None,
                "download": {"url": f"{HF}/glbs/{shard}/{uid}.glb", "format": "glb"},
                "thumbnail": thumb,
                "tags": tags.split()[:12],
                "category": lvis or cats_,
                "description": desc[:240],
                "score": round(score, 3),
            }
        )
    out.sort(key=lambda c: -c["score"])
    return out, status


def lookup(uid: str) -> dict | None:
    """按编号取一个已索引的对象（fetch 用）。"""
    con = connect()
    try:
        row = con.execute(
            "SELECT uid, name, author, author_url, license, faces, thumb, shard, page FROM objects "
            "WHERE uid = ?",
            (uid,),
        ).fetchone()
        shard = row[7] if row else None
        if shard is None:
            p = con.execute("SELECT shard FROM paths WHERE uid = ?", (uid,)).fetchone()
            if p is None:
                return None
            index_shards(con, [p[0]])
            return lookup(uid)
    finally:
        con.close()
    uid, name, author, author_url, lic, faces, thumb, shard, page = row
    return {
        "library": "objaverse",
        "id": uid,
        "title": name or uid,
        "author": author or "unknown",
        "authorUrl": author_url,
        "license": lic,
        "page": page,
        "faceCount": faces or None,
        "download": {"url": f"{HF}/glbs/{shard}/{uid}.glb", "format": "glb"},
        "thumbnail": thumb,
    }


def mirror_url(uid: str) -> str | None:
    """Sketchfab 模型在 Objaverse 镜像里的 glb 地址（没有就 None）。需要路径表。"""
    con = connect()
    try:
        ensure_paths(con)
        row = con.execute("SELECT shard FROM paths WHERE uid = ?", (uid,)).fetchone()
    finally:
        con.close()
    return f"{HF}/glbs/{row[0]}/{uid}.glb" if row else None


def cmd_index(args) -> None:
    con = connect()
    try:
        ensure_lvis(con)
        have = indexed(con)
        if args.all:
            todo = [s for s in SHARDS if s not in have]
        else:
            words = [w for c in args.category or [] for w in expand_query(c)]
            cats = lvis_categories(con, words)
            if cats:
                ensure_paths(con)
            todo = [s for s in shards_for(con, cats) if s not in have] or [s for s in SHARDS if s not in have]
            todo = todo[: args.shards]
        kept = index_shards(con, todo)
        total = con.execute("SELECT count(*) FROM objects").fetchone()[0]
        print(
            f"Objaverse 索引：{len(indexed(con))}/{len(SHARDS)} 个分片，"
            f"{total} 个许可允许（CC0 / CC-BY）的对象"
            f"（这次新增 {kept}）→ {db_path()}"
        )
    except http.DownloadError as e:
        raise ReconError(str(e)) from e
    finally:
        con.close()
