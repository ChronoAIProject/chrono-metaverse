"""Bind the waterfront terrace's sampled indirect light to its surveyed geometry."""

import json
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.spatial import cKDTree

from fullerton_glazing import GLASS

REFERENCES = Path(__file__).resolve().parents[1] / "references" / "terrace-daylight"


def glazing_levels():
    return json.loads((REFERENCES / "surfaces.json").read_text())["glazing"]


def apply_terrace_daylight(scene, middle):
    surfaces = json.loads((REFERENCES / "surfaces.json").read_text())["middle" if middle else "south"]
    ramp = Image.fromarray(np.array([[0, 255], [0, 255]], dtype=np.uint8)).convert("RGB")
    ramp.format = "PNG"
    for mesh in scene.geometry.values():
        material = mesh.visual.material
        if material.name == GLASS:
            material.baseColorFactor = [145, 162, 169, 255]
            material.metallicFactor = .14
            material.roughnessFactor = .24
            material.emissiveFactor = [0, 0, 0]
            material.emissiveTexture = Image.open(REFERENCES / "fullerton-waterfront-reflection.png")

        field = surfaces.get(material.name)
        if field is None:
            continue
        if "texture" in field:
            # The lined slopes form a heightfield in the model's XZ plane.
            low, high = np.array(field["min"]), np.array(field["max"])
            uv = (mesh.vertices[:, [0, 2]] - low) / (high - low)
            material.occlusionTexture = Image.open(REFERENCES / field["texture"])
        else:
            # Rails share positions across hard edges. Reassociate face-oriented samples
            # after mesh merging and GLB vertex reordering.
            with np.load(REFERENCES / field["samples"]) as samples:
                support = np.column_stack([samples["position"], samples["normal"]])
                points = np.column_stack([mesh.vertices, mesh.vertex_normals])
                distance, nearest = cKDTree(support).query(points)
                if distance.max() > .01:
                    raise ValueError(f"Daylight samples do not match {material.name} geometry")
                uv = np.column_stack([.25 + .5 * samples["visibility"][nearest],
                                      np.full(len(nearest), .5)])
            material.occlusionTexture = ramp
        mesh.vertex_attributes["_AO_UV"] = np.asarray(uv, dtype=np.float32)
