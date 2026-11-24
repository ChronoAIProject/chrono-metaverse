"""Fit triangular aluminium sunshades to the two surveyed Esplanade roof shells."""

import numpy as np
import trimesh


DESIGN = 'https://www.dpa.com.sg/projects/esplanade-theatres-on-the-bay/'
PHOTOGRAPHS = [
    'https://commons.wikimedia.org/?curid=74794455',
    'https://commons.wikimedia.org/?curid=83988992',
    'https://commons.wikimedia.org/?curid=85563656',
]


def transverse_sections(shell):
    """Measure the length of each cross-roof arc and the centreline joining the arcs."""
    vertices = shell.vertices
    center = vertices.mean(axis=0)
    center[1] = 0
    _, basis = np.linalg.eigh(np.cov(vertices[:, [0, 2]].T))
    axis = np.array([basis[0, 1], 0, basis[1, 1]])
    side = np.cross(axis, [0, 1, 0])
    along = (vertices - center) @ axis
    sections, centers = [], []
    for station in np.linspace(along.min() + .06, along.max() - .06, 320):
        origin = center + station * axis
        segments = trimesh.intersections.mesh_plane(shell, axis, origin).reshape(-1, 3)
        lateral = (segments - center) @ side
        order = np.argsort(lateral)
        across, index = np.unique(np.round(lateral[order], 4), return_index=True)
        if len(across) < 2:
            continue
        points = segments[order[index]]
        length = np.r_[0, np.cumsum(np.linalg.norm(np.diff(points, axis=0), axis=1))]
        middle = (across.min() + across.max()) / 2
        length -= np.interp(middle, across, length)
        centers.append(origin + middle * side + [0, np.interp(middle, across, points[:, 1]), 0])
        sections.append((length, points))
    ridge = np.r_[0, np.cumsum(np.linalg.norm(np.diff(centers, axis=0), axis=1))]
    return ridge, sections


def triangular_plates(positions, faces):
    mesh = trimesh.Trimesh(vertices=positions, faces=faces, process=False)
    mesh.merge_vertices(merge_tex=True, merge_norm=True)
    shells = sorted(mesh.split(only_watertight=False, repair=False), key=lambda m: -len(m.faces))
    if len(shells) != 2:
        raise ValueError('Expected the two connected glass roofs')
    plates, counts = [], []
    width, spacing = 2.34, .98
    for shell in shells:
        ridge, sections = transverse_sections(shell)

        def sample(u, t):
            j = np.searchsorted(ridge, u)
            if j == 0 or j >= len(ridge):
                return None
            points = []
            for length, section in sections[j-1:j+1]:
                if t < length[0] - .25 or t > length[-1] + .25:
                    return None
                points.append(np.array([np.interp(t, length, coord) for coord in section.T]))
            fraction = (u - ridge[j-1]) / (ridge[j] - ridge[j-1])
            return (1 - fraction) * points[0] + fraction * points[1]

        before = len(plates)
        extent = max(max(abs(length[0]), abs(length[-1])) for length, _ in sections)
        rows = int(np.ceil(extent / spacing)) + 1
        for row in range(-rows, rows + 1):
            across = row * spacing
            downhill = 1 if across >= 0 else -1
            for along in np.arange(width + (row % 2) * width / 2, ridge[-1] - width / 2, width):
                upper = across - downhill * .55 * spacing
                left = sample(along - .49 * width, upper)
                right = sample(along + .49 * width, upper)
                tip = sample(along, across + downhill * .98 * spacing)
                if left is None or right is None or tip is None:
                    continue
                normal = np.cross(right - left, tip - left)
                area = np.linalg.norm(normal)
                if area < .15:
                    continue
                normal /= area
                if normal[1] < 0:
                    left, right, normal = right, left, -normal
                # The flatter crown has greater overlap. Steeper sides expose the glass.
                tip += (tip - (left + right) / 2) * (.25 * normal[1] ** 2)
                lift = .32 + .47 * (1 - normal[1])
                plates.append([left + .07 * normal, right + .07 * normal, tip + lift * normal])
        counts.append(len(plates) - before)
    plates = np.asarray(plates)
    # The survey measures the outer envelope, including its shades. Seat complete
    # edge plates inside it so their projecting tips preserve the measured extents.
    plates += np.maximum(positions.min(axis=0) - plates.min(axis=1), 0)[:, None, :]
    plates -= np.maximum(plates.max(axis=1) - positions.max(axis=0), 0)[:, None, :]
    return plates, counts
