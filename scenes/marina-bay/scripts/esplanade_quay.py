"""Measured promenade sections in the final scene frame."""
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]


class QuaySurface:
    def __init__(self):
        self.reference = json.loads((ROOT / 'references/esplanade-east-quay.json').read_text())
        self.sections = []
        for station in self.reference['stations']:
            front = np.array(station['edge'])
            back = np.array(station['inland'])
            direction = back - front
            inner = front + direction * station['levelWidth'] / np.linalg.norm(direction[[0, 2]])
            front[1] += station['rise']
            inner[1] = front[1] - .014
            self.sections.append([front, inner, back])

    def triangles(self):
        for a, b in zip(self.sections, self.sections[1:]):
            for i in (0, 1):
                for tri in ([a[i], a[i+1], b[i]], [b[i], a[i+1], b[i+1]]):
                    xyz = np.array(tri)
                    if np.cross(xyz[1]-xyz[0], xyz[2]-xyz[0])[1] < 0:
                        xyz = xyz[::-1]
                    yield xyz

    def height(self, xz):
        for tri in self.triangles():
            plan = tri[:, [0, 2]]
            weights = np.linalg.solve((plan[1:] - plan[0]).T, xz - plan[0])
            if min(weights) >= -1e-6 and weights.sum() <= 1.000001:
                return tri[0, 1] + weights @ (tri[1:, 1] - tri[0, 1])
        return None
