"""Register visible Fullerton Pavilion window and door profiles to the SLA shell."""

import numpy as np


# Along a cylindrical unwrap, u=0 is -180 degrees and u=1800 is +180.
# Trace the middle of each photographed vertical at the sill and eave.
# The untextured return beside the gangway has no registered sections.
CENTRE = np.array([-7.8, 0., 17.7])
MULLIONS = [
    (249, 251), (293, 295), (339, 342), (384, 385), (429, 430),
    (956, 952), (1001, 998), (1040, 1039), (1085, 1083),
    (1129, 1128), (1175, 1176), (1223, 1221),
]
# Two pairs of door leaves. The ordering is left jamb, meeting stile, right jamb.
DOORS = [((33, 67, 93), (36, 68, 93), 2.24),
         ((1296, 1320, 1350), (1295, 1320, 1347), 2.39)]


def frame_geometry(positions, triangles):
    shell = positions[triangles].astype(float)
    middle = shell.mean(axis=1)
    radius = np.linalg.norm((middle - CENTRE)[:, [0, 2]], axis=1)
    shell = shell[(radius > 9) & (radius < 14) & (middle[:, 1] < 6.2)]
    origins = shell[:, 0]
    side_a, side_b = (shell[:, 1:] - origins[:, None]).transpose(1, 0, 2)
    normals = np.cross(side_a, side_b)
    inverse = np.linalg.pinv(shell[:, 1:] - origins[:, None])

    def project(u, height):
        angle = (u / 900 - 1) * np.pi
        ray = np.array([np.cos(angle), 0., np.sin(angle)])
        eye = CENTRE + [0, height, 0]
        denominator = normals @ ray
        distance = np.divide(((origins - eye) * normals).sum(axis=1), denominator,
                             out=np.zeros(len(shell)), where=denominator > 1e-8)
        points = eye + distance[:, None] * ray
        weights = np.einsum('ij,ijk->ik', points - origins, inverse)
        inside = (weights.min(axis=1) >= -1e-6) & (weights.sum(axis=1) <= 1.000001)
        hits = distance[inside & (distance > 9) & (distance < 14)]
        if not hits.size:
            raise ValueError(f'Missing shell at unwrap coordinate {u}, height {height}')
        return eye + hits.max() * ray, ray

    points, shading, colors = [], [], []

    def rail(path, width, color):
        rings = []
        for i, (point, ray) in enumerate(path):
            along = path[min(i + 1, len(path) - 1)][0] - path[max(i - 1, 0)][0]
            lateral = np.cross(ray, along)
            lateral *= width / (2 * np.linalg.norm(lateral))
            # A shallow chamfer gives the cap a narrow sunlit edge in grazing views.
            rings.append([point + side * lateral + depth * ray for side, depth in
                          [(-1, .004), (-1, .030), (-.80, .038), (.80, .038), (1, .030), (1, .004)]])
        for lower, upper in zip(rings, rings[1:]):
            for j in range(len(lower) - 1):
                a, b, c, d = lower[j], upper[j], upper[j+1], lower[j+1]
                normal = np.cross(b - a, c - a)
                normal /= np.linalg.norm(normal)
                points.extend([a,b,c,a,c,d])
                shading.extend([normal] * 6)
                colors.extend([color] * 6)

    for bottom, top in MULLIONS:
        # The eave slopes down to the gangway on this return.
        eave = {956: 3.68, 1001: 4.93}.get(bottom, 5.16)
        heights = [h for h in [.41, 2.39, 2.65, 4.10] if h < eave] + [eave]
        path = [project(np.interp(h, [heights[0], heights[-1]], [bottom, top]), h)
                for h in heights]
        rail(path, .055, [.091, .111, .117])
    for sill_stiles, head_stiles, head in DOORS:
        door_color = [.34, .36, .35]
        for sill_u, head_u in zip(sill_stiles, head_stiles):
            path = [project(np.interp(h, [.41, head], [sill_u, head_u]), h)
                    for h in [.41, 1.47, head - .03]]
            rail(path, .065, door_color)
        rail([project(u, head) for u in np.linspace(head_stiles[0], head_stiles[-1], 7)],
             .065, door_color)
    return {name: np.asarray(values, dtype='<f4') for name, values in
            [('POSITION', points), ('NORMAL', shading), ('COLOR_0', colors)]}
