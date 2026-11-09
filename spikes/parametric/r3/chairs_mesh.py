"""Template part -> mesh (canonical chair frame) and instance placement.

Part types (all coordinates continuous, metres, canonical chair frame: y up from the floor, chair faces +z):
  loft      contour.loft sections ({axis: level, outline}) with axis 'y' (outline (x, z)) or 'x' (outline (z, y));
            optional "frame": {"pitch_deg": a, "pivot": [x, y, z]}: the loft is built in a frame reclined by a
            about the x axis through pivot (canonical = Rx(-a) (frame - pivot) + pivot; a > 0 leans the top back)
  tube      straight round bar from "a" to "b" (canonical points), radius "r_a" -> "r_b", "segments"
  cylinder  prims.py cylinder (vertical): radius, height, position (centre), segments
Instance placement (chairs.json): world = Ry(yaw) * Tilt(L) + position, Tilt = Rx(-pitch) about the template's
"tilt_pivot" for parts with group 'upper' (shell), identity for the base.
"""
import os, sys
import numpy as np
import trimesh
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import chairlib as L
import contour as C


def tube_mesh(a, b, ra, rb, seg=12, caps=True):
    a, b = np.asarray(a, float), np.asarray(b, float)
    d = b - a; Lh = np.linalg.norm(d); d /= Lh
    u = np.cross(d, [0, 1, 0] if abs(d[1]) < 0.9 else [1, 0, 0]); u /= np.linalg.norm(u); v = np.cross(d, u)
    t = np.linspace(0, 2 * np.pi, seg, endpoint=False)
    ring = np.cos(t)[:, None] * u + np.sin(t)[:, None] * v
    V = np.r_[a + ra * ring, b + rb * ring, [a, b]]
    F = []
    for i in range(seg):
        j = (i + 1) % seg
        F += [(i, j, seg + j), (i, seg + j, seg + i)]
        if caps:
            F += [(2 * seg, j, i), (2 * seg + 1, seg + i, seg + j)]
    m = trimesh.Trimesh(V, np.array(F), process=False)
    m.fix_normals()
    return m


def part_mesh(p):
    t = p['type']
    if t == 'loft':
        m = C.loft(p['sections'], axis=p.get('axis', 'y'), max_slope_deg=p.get('max_slope_deg', 75.0))
        fr = p.get('frame')
        if fr:
            c = np.asarray(fr['pivot'], float)
            V = (m.vertices - c) @ L.Rx(-fr['pitch_deg']).T + c
            m = trimesh.Trimesh(V, m.faces.copy(), process=False)
        return m
    if t == 'tube':
        return tube_mesh(p['a'], p['b'], p['r_a'], p.get('r_b', p['r_a']), p.get('segments', 12))
    if t == 'cylinder':
        from prims import part_mesh as pm
        m, _ = pm(dict(p, color_rgb=p.get('color_rgb', [128, 128, 128])))
        return m
    raise ValueError(t)


def template_meshes(parts):
    return [(p, part_mesh(p)) for p in parts]


def instance_mesh(tmeshes, inst, tilt_pivot, per_part=False):
    """World meshes of one instance: [(part, trimesh)] (or one concatenated mesh)."""
    yaw, pos, pitch = inst['yaw_deg'], np.asarray(inst['position'], float), inst.get('pitch_deg', 0.0)
    c = np.asarray(tilt_pivot, float)
    out = []
    for p, m in tmeshes:
        V = m.vertices.copy()
        if p.get('group') == 'upper':
            V = (V - c) @ L.Rx(-pitch).T + c
        out.append((p, trimesh.Trimesh(V @ L.Ry(yaw).T + pos, m.faces.copy(), process=False)))
    return out if per_part else trimesh.util.concatenate([m for _, m in out])
