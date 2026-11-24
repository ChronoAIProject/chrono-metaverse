"""Reconstruct the six open shade structures on the ArtScience Museum waterfront."""
import argparse
import json
from importlib import import_module
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image
from scipy.interpolate import make_interp_spline

from bridge_geometry import BridgeFrame, SurfaceBatch
from context_geometry import geographic_point
from ground_materials import scanned_pavers
from scanned_canopy import ROOT, write_tree_asset


def beam(batch, start, end, width, depth):
    """A rectangular extrusion with a separate normal on each painted face."""
    direction = end - start
    side = np.cross(direction, [0., 1., 0.])
    side *= width / (2 * np.linalg.norm(side))
    up = np.cross(side, direction)
    up *= depth / (2 * np.linalg.norm(up))
    rings = np.array([p + offset for p in (start, end)
                      for offset in (-side-up, side-up, side+up, -side+up)])
    centre = rings.mean(axis=0)
    for face in [[0,1,2,3], [4,5,6,7], [0,1,5,4], [1,2,6,5], [2,3,7,6], [3,0,4,7]]:
        quad = rings[face]
        if np.dot(np.cross(quad[1]-quad[0], quad[2]-quad[0]), quad.mean(axis=0)-centre) < 0:
            quad = quad[::-1]
        batch.add(quad, [[0,1,2], [0,2,3]])


def build_segment(edges, roof, stone, height, pitch):
    path = make_interp_spline([0., .5, 1.], edges, k=2, axis=1)
    def point(t, across, level):
        outer, inner = path(t)
        return outer + across * (inner-outer) + [0, level, 0]

    # Each shade is split down the middle. The curved longitudinal girders
    # run on the column axes, set back from the ends of the cantilevered slats.
    stations = np.linspace(0, 1, 15)
    length = np.linalg.norm(np.diff([point(t, .5, 0) for t in stations], axis=0), axis=1).sum()
    for t in np.linspace(0, 1, round(length / pitch) + 1):
        for start, end in [(0, .48), (.52, 1)]:
            beam(roof, point(t, start, height), point(t, end, height), .16, .20)
    for across in [.14, .43, .57, .86]:
        for lo, hi in zip(stations, stations[1:]):
            beam(roof, point(lo, across, height-.18), point(hi, across, height-.18), .14, .23)
    for across in [.14, .86]:
        for t in np.linspace(.065, .935, 4):
            roof.tube([point(t, across, .025), point(t, across, height-.19)], .17, 12)
    # Replace the old roof and its baked bars in the aerial ground image.
    # Keep the planting and unroofed passages between separate arc sections.
    for t0, t1 in zip(stations, stations[1:]):
        quad = np.array([point(t0, -.025, .045), point(t0, 1.025, .045),
                         point(t1, 1.025, .045), point(t1, -.025, .045)])
        if np.cross(quad[1]-quad[0], quad[2]-quad[0])[1] < 0:
            quad = quad[::-1]
        stone.add(quad, [[0,1,2], [0,2,3]], quad[:, [0, 2]] / 1.8)


def bake(palm_folder):
    survey = json.loads((ROOT/'references/artscience-promenade.json').read_text())
    frame = BridgeFrame()
    config = json.loads((ROOT/'context.json').read_text())['oneMap']
    environment = json.loads((ROOT/'build/environment.json').read_text())['props']['environment']
    datum = environment['map']['origin'][1] + config['officeHeightMeters'] - frame.shift[1]
    def project(pixel):
        x, y = (np.array(survey['pixelOrigin']) + pixel) / (256 * 2**survey['zoom'])
        lon, lat = x*360-180, np.degrees(np.arctan(np.sinh(np.pi*(1-2*y))))
        return geographic_point(lon, lat, frame.origin, frame.rotation, frame.shift) + [0, datum, 0]

    roof = SurfaceBatch('Museum promenade painted aluminium', [166,169,165,255], .04, .65)
    stone = SurfaceBatch('Museum promenade granite', [255]*4, 0, .88)
    stone.material = scanned_pavers('Museum promenade granite', [125,123,116], [.45,.30])
    for segment in survey['segments']:
        edges = np.array([[project(p) for p in segment[key]] for key in ('bayEdge', 'museumEdge')])
        build_segment(edges, roof, stone, survey['roofHeightMetres'], survey['slatPitchMetres'])
    court = np.array([project(p) + [0, .045, 0] for p in survey['palmCourt']])
    if np.cross(court[1]-court[0], court[2]-court[0])[1] < 0:
        court = court[::-1]
    stone.add(court, [[0,1,2], [0,2,3]], court[:, [0, 2]] / 1.8)

    scene = trimesh.Scene()
    for batch in [roof, stone]:
        scene.add_geometry(batch.mesh(), geom_name=batch.material.name)
    credit = 'Layout interpreted from OneMap and OpenStreetMap contributors (ODbL). Granite Tile 04 by Poly Haven (CC0).'
    digest, bounds = write_tree_asset(scene, copyright=credit)
    promenade = dict(entityId='bay.artscience-promenade', kind='structure', layer='ext',
                regionId='marina-bay-exterior', label='艺术科学博物馆滨水廊架', assetHash=digest,
                bounds=bounds, material={'shading':'albedo'}, props={'background':True,
                '平面依据':survey['orthophoto'], '现场照片':survey['photographs'], '资料来源':credit,
                '重建范围':'六段弧形廊架及棚下铺地。棚高取自地图标注，柱距和格栅尺寸据照片及正射图估读。'})


    palm_source = import_module('bake-sands-waterfront-palms')
    trees = []
    rng = np.random.default_rng(172471575)
    for centre in survey['palmCentres']:
        x, y, z = project(centre)
        trees.append(dict(variant='d', localXZ=[x, z], groundY=y+.04,
                          estimatedHeightMetres=rng.uniform(6.3, 7.5),
                          crownDiameterMetres=rng.uniform(3.4, 4.1),
                          yawDegrees=rng.uniform(0, 360), trunkWidthFactor=.73, linearTint=[192,180,146]))
    stand = palm_source.palm_stand(palm_folder, trees)
    # The atlas puts fronds on the left and the ringed trunk on the right.
    # Retain the cutout and reduce the contrast of trunk rings seen in the bridge view.
    material = stand.visual.material
    atlas = np.array(material.baseColorTexture)
    rgb = atlas[:, :, :3].astype(float)
    split = round(atlas.shape[1]*.73)
    rgb[:, :split] *= [.86, .83, .79]
    bark = rgb[:, split:]
    luma = bark @ [.2126, .7152, .0722]
    rgb[:, split:] = np.clip((luma[:, :, None] - 115)*.46 + [126,121,111], 0, 255)
    atlas[:, :, :3] = np.round(rgb).astype(np.uint8)
    material.baseColorTexture = Image.fromarray(atlas)
    material.baseColorTexture.format = 'PNG'
    grove = trimesh.Scene()
    grove.add_geometry(stand, geom_name=stand.visual.material.name)
    digest, bounds = write_tree_asset(grove, packing_options=('-si','0.48','-se','0.0005','-slb'),
                                     copyright=palm_source.CREDIT)
    palms = dict(entityId='bay.artscience-palm-court', kind='structure', layer='ext',
                 regionId='marina-bay-exterior', label='艺术科学博物馆滨水棕榈广场', assetHash=digest,
                 bounds=bounds, material={'shading':'albedo'}, props={'background':True, 'surfaceRole':'landscape',
                 '平面依据':survey['orthophoto'], '现场照片':survey['photographs'], '素材来源':palm_source.CREDIT,
                 '重建范围':'树冠中心按正射影像定位。树高及冠幅按照片估读，复用王棕网格近似树形。'})
    return promenade, palms


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('palm_folder', type=Path, help='Pinned 0 A.D. royal palm mesh and textures')
    entities = bake(parser.parse_args().palm_folder)
    path = ROOT/'build/streetscape.json'
    rows = {row['entityId']:row for row in json.loads(path.read_text())}
    for entity in entities:
        rows[entity['entityId']] = entity
    path.write_text(json.dumps(list(rows.values()), ensure_ascii=False, indent=2)+'\n')
    print([entity['assetHash'] for entity in entities])
