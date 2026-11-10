"""测试用的合成网格：带斜墙的小房间、实心盒子。"""

from __future__ import annotations

import numpy as np

from metaverse_recon.processing.scan import ScanMesh

TILE = 64  # 贴图里每个元素一块 64×64 的纯色区域


def _quad_grid(origin, u_vec, v_vec, nu, nv):
    """平面上 nu×nv 个小四边形；三角形绕向使法线 = u × v。返回 (顶点, 面, 归一化平面坐标)。"""
    origin, u_vec, v_vec = (np.asarray(a, float) for a in (origin, u_vec, v_vec))
    us, vs = np.meshgrid(np.linspace(0, 1, nu + 1), np.linspace(0, 1, nv + 1), indexing="ij")
    verts = origin + us.reshape(-1, 1) * u_vec + vs.reshape(-1, 1) * v_vec
    idx = np.arange((nu + 1) * (nv + 1)).reshape(nu + 1, nv + 1)
    a, b = idx[:-1, :-1].ravel(), idx[1:, :-1].ravel()
    c, d = idx[1:, 1:].ravel(), idx[:-1, 1:].ravel()
    faces = np.concatenate([np.stack([a, b, c], 1), np.stack([a, c, d], 1)])
    return verts, faces, np.stack([us.ravel(), vs.ravel()], 1)


class _Builder:
    def __init__(self, tiles_per_row: int = 4) -> None:
        self.V: list[np.ndarray] = []
        self.F: list[np.ndarray] = []
        self.UV: list[np.ndarray] = []
        self.n = 0
        self.tiles = tiles_per_row
        self.colors: list[tuple[int, int, int]] = []

    def plane(self, origin, u_vec, v_vec, color, cell=0.25):
        lu, lv = np.linalg.norm(u_vec), np.linalg.norm(v_vec)
        nu, nv = max(1, int(np.ceil(lu / cell))), max(1, int(np.ceil(lv / cell)))
        verts, faces, st = _quad_grid(origin, u_vec, v_vec, nu, nv)
        tile = len(self.colors)
        self.colors.append(color)
        tx, ty = tile % self.tiles, tile // self.tiles
        # 每块贴图只用中间 80%，避免采样落到相邻块
        size = 1.0 / self.tiles
        uv = np.stack([(tx + 0.1 + 0.8 * st[:, 0]) * size, (ty + 0.1 + 0.8 * st[:, 1]) * size], 1)
        self.V.append(verts)
        self.F.append(faces + self.n)
        self.UV.append(uv)
        self.n += len(verts)

    def build(self) -> ScanMesh:
        tex = np.zeros((self.tiles * TILE, self.tiles * TILE, 3), np.uint8)
        for i, color in enumerate(self.colors):
            tx, ty = i % self.tiles, i // self.tiles
            tex[ty * TILE : (ty + 1) * TILE, tx * TILE : (tx + 1) * TILE] = color
        return ScanMesh(np.concatenate(self.V), np.concatenate(self.F), np.concatenate(self.UV), tex)


ROOM_COLORS = {
    "floor": (150, 120, 90),
    "ceiling": (230, 230, 230),
    "west": (200, 60, 60),  # x = 0，法线 +x
    "south": (60, 160, 60),  # z = 0，法线 +z
    "east": (60, 60, 200),  # x = 5，法线 −x
    "north": (200, 200, 60),  # z = 4，法线 −z
    "diagonal": (180, 60, 180),  # (3,4)–(5,2) 斜墙
}


def room_mesh(height: float = 2.6, diagonal: bool = True) -> ScanMesh:
    """5×4 米的房间（x∈[0,5]，z∈[0,4]），东北角被一面 45° 斜墙切掉（从 (3,4) 到 (5,2)）。墙法线都朝里。"""
    b = _Builder()
    up = np.array([0.0, height, 0.0])
    # 地面：用两个矩形拼（斜墙外的三角形不铺）
    if diagonal:
        b.plane([0, 0, 0], [0, 0, 4], [3, 0, 0], ROOM_COLORS["floor"])  # x∈[0,3]：u=z, v=x → 法线 +y
        b.plane([3, 0, 0], [0, 0, 2], [2, 0, 0], ROOM_COLORS["floor"])  # x∈[3,5], z∈[0,2]
        # 斜墙前的三角形区域：用细长条近似填满 x∈[3,5], z∈[2, 4-(x-3)]
        for k in range(8):
            x0 = 3 + k * 0.25
            zmax = 4 - (x0 + 0.25 - 3)
            if zmax > 2:
                b.plane([x0, 0, 2], [0, 0, zmax - 2], [0.25, 0, 0], ROOM_COLORS["floor"])
    else:
        b.plane([0, 0, 0], [0, 0, 4], [5, 0, 0], ROOM_COLORS["floor"])
    b.plane([0, height, 0], [5, 0, 0], [0, 0, 4], ROOM_COLORS["ceiling"])  # 法线 −y
    walls = {
        "south": ((0, 0), (5, 0)),
        "east": ((5, 0), (5, 2) if diagonal else (5, 4)),
        "north": ((3, 4) if diagonal else (5, 4), (0, 4)),
        "west": ((0, 4), (0, 0)),
    }
    if diagonal:
        walls["diagonal"] = ((5, 2), (3, 4))
    for name, ((x0, z0), (x1, z1)) in walls.items():
        # 沿逆时针走墙线：u = 走向，v = 向上，法线 = u × v 朝房间里
        along = np.array([x1 - x0, 0, z1 - z0], float)
        b.plane([x0, 0, z0], along, up, ROOM_COLORS[name])
    return b.build()


def box_mesh(lo, hi, color=(200, 100, 50)) -> ScanMesh:
    """实心盒子的六个面（法线朝外）。"""
    lo, hi = np.asarray(lo, float), np.asarray(hi, float)
    d = hi - lo
    b = _Builder(tiles_per_row=2)
    ex, ey, ez = np.array([d[0], 0, 0]), np.array([0, d[1], 0]), np.array([0, 0, d[2]])
    b.plane(lo, ez, ey, color, cell=0.1)  # x = lo，法线 −x
    b.plane(lo + ex, ey, ez, color, cell=0.1)  # x = hi，法线 +x
    b.plane(lo, ex, ez, color, cell=0.1)  # y = lo，法线 −y
    b.plane(lo + ey, ez, ex, color, cell=0.1)  # y = hi，法线 +y
    b.plane(lo, ey, ex, color, cell=0.1)  # z = lo，法线 −z
    b.plane(lo + ez, ex, ey, color, cell=0.1)  # z = hi，法线 +z
    return b.build()


def merged(a: ScanMesh, b: ScanMesh) -> ScanMesh:
    """两块带贴图的网格拼成一块：贴图左右并排，贴图坐标按各自的位置换算（左上角原点）。"""
    ha, wa = a.texture.shape[:2]
    hb, wb = b.texture.shape[:2]
    H, W = max(ha, hb), wa + wb
    tex = np.zeros((H, W, 3), np.uint8)
    tex[:ha, :wa] = a.texture[..., :3]
    tex[:hb, wa:] = b.texture[..., :3]
    uv_a = a.uv * [wa / W, ha / H]
    uv_b = (b.uv * [wb, hb] + [wa, 0]) / [W, H]
    return ScanMesh(
        np.vstack([a.vertices, b.vertices]),
        np.vstack([a.faces, b.faces + len(a.vertices)]),
        np.vstack([uv_a, uv_b]),
        tex,
    )
