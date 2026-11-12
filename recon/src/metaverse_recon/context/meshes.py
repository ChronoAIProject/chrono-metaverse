"""按平台物件的三角形上限拆分，保留来源材质与纹理。"""

import numpy as np


def triangle_groups(meshes, limit=90000):
    groups, current, count = [], [], 0
    for mesh in meshes:
        for start in range(0, len(mesh.faces), limit):
            part = (
                mesh.copy()
                if start == 0 and len(mesh.faces) <= limit
                else mesh.submesh(
                    [np.arange(start, min(start + limit, len(mesh.faces)))], append=True, repair=False
                )
            )
            if current and count + len(part.faces) > limit:
                groups.append(current)
                current, count = [], 0
            current.append(part)
            count += len(part.faces)
    if current:
        groups.append(current)
    return groups
