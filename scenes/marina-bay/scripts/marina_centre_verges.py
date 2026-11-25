"""Build the planted margins and paved approaches around the Marina Centre junction."""

import numpy as np
from scipy.spatial import cKDTree
from shapely import get_parts, union_all
from shapely.geometry import GeometryCollection, Polygon, box

from ground_materials import scanned_pavers, scanned_turf


def add_verges(scene, reference, project, carriageway, bridges, ground, datum, surface):
    def polygon(ring):
        return Polygon([project(point) for point in ring])

    covers = [polygon(ring) for ring in reference["coveredFootprints"]]
    excluded = union_all([carriageway, *covers, *bridges])
    beds = union_all([polygon(row["ring"]) for row in reference["surfaces"] if row["surface"] == "turf"])
    paving = union_all([polygon(row["ring"]) for row in reference["surfaces"] if row["surface"] == "paving"])
    paving = paving.difference(excluded)
    beds = beds.difference(excluded).difference(paving)
    # Only put a raised kerb on the side of a planting bed that borders a vehicle lane.
    roadside = beds.boundary.intersection(carriageway.buffer(.85)).buffer(.16)
    grass = beds.difference(roadside)
    stone = union_all([paving, beds.intersection(roadside)])
    pavers = scanned_pavers("Marina Centre granite paving", [129, 128, 119], [.55, .35])
    pavement = surface(stone, pavers, ground, datum, height=.079, walls=stone)
    pavement.visual.uv = pavement.visual.uv * [2.08 / (4 * .55), 2.08 / (6 * .35)]
    scene.add_geometry(pavement, geom_name="Paved approaches and stone kerbs")

    turf = scanned_turf("Marina Centre planted verges", [115, 122, 90])
    # Sample several metres of grass per vertex while the photographed blades and
    # roughness repeat at ground scale. Adjacent cells sample the same colour field.
    cells = []
    span = 3.5
    for bed in get_parts(grass):
        x0, z0, x1, z1 = bed.bounds
        for x in np.arange(np.floor(x0 / span) * span, x1, span):
            for z in np.arange(np.floor(z0 / span) * span, z1, span):
                part = bed.intersection(box(x, z, x + span, z + span))
                if part.area > .0001:
                    cells.append(part)
    lawn = surface(GeometryCollection(cells), turf, ground, datum, height=.06, tile_width=1.65)
    samples = reference["toneSurvey"]["samples"]
    positions = [project(row[:2]) for row in samples]
    rgb = np.array([row[2:] for row in samples], dtype=float)
    distance, index = cKDTree(positions).query(lawn.vertices[:, [0, 2]], k=4)
    weight = 1 / np.maximum(distance, .6) ** 2
    field = np.sum(rgb[index] * weight[:, :, None], axis=1) / weight.sum(axis=1)[:, None]
    # Convert the relative survey colours to linear vertex multipliers. Limit the
    # influence of dark tree crowns so the scene's own tree shadows remain legible.
    relative = np.clip(field / np.median(rgb, axis=0), .61, 1.48)
    tint = np.clip(.56 * relative ** 1.8, .25, 1)
    lawn.visual.vertex_attributes["color"] = np.uint8(255 * np.column_stack((tint, np.ones(len(tint)))))
    scene.add_geometry(lawn, geom_name="Planted road margins")
    return round(grass.area), round(stone.area)
