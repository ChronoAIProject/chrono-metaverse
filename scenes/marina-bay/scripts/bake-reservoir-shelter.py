"""Bake the short-wave slope multiplier from the upwind reservoir shoreline."""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image
from pyproj import Transformer
from scipy.ndimage import map_coordinates
from shapely import contains_xy, make_valid, transform
from shapely.geometry import shape
from shapely.ops import unary_union


def upwind_distance(water, samples, direction, step):
    # Rotate the raster into wind coordinates and scan from the upwind edge.
    basis = np.array([direction, [-direction[1], direction[0]]])
    rotated = samples @ basis.T
    low = np.floor(rotated.min(axis=(0, 1)) / step) * step - 3 * step
    high = rotated.max(axis=(0, 1)) + 3 * step
    along, across = np.meshgrid(*[np.arange(lo, hi, step) for lo, hi in zip(low, high)])
    points = np.stack((along, across), axis=-1) @ basis
    inside = contains_xy(water, points[:, :, 0], points[:, :, 1])
    columns = np.arange(inside.shape[1])[None, :]
    last_land = np.maximum.accumulate(np.where(inside, -1, columns), axis=1)
    distance = np.where(inside, (columns - last_land - .5) * step, 0)
    indices = ((rotated - low) / step)[:, :, [1, 0]].transpose(2, 0, 1)
    return map_coordinates(distance, indices, order=1)


def bake(polygons, scene, output):
    config = json.loads((scene / 'build/environment.json').read_text())['props']['environment']['map']
    survey = json.loads((scene / 'references/marina-reservoir-water.json').read_text())
    wind = survey['rippleWind']['fromDegrees']
    to_ecef = Transformer.from_crs(4979, 4978, always_xy=True)
    from_ecef = Transformer.from_crs(4978, 4979, always_xy=True)
    longitude, latitude, heading = np.radians([config['longitude'], config['latitude'], config['heading']])
    east = np.array([-np.sin(longitude), np.cos(longitude), 0])
    north = np.array([-np.sin(latitude)*np.cos(longitude), -np.sin(latitude)*np.sin(longitude), np.cos(latitude)])
    basis = np.stack([-np.cos(heading)*east + np.sin(heading)*north, np.sin(heading)*east + np.cos(heading)*north])
    centre = np.array(to_ecef.transform(config['longitude'], config['latitude'], 0))
    origin = np.array(config['origin'])[[0, 2]]

    def local(lon_lat):
        points = np.column_stack(to_ecef.transform(*lon_lat.T, np.zeros(len(lon_lat))))
        return np.round((points - centre) @ basis.T + origin, 6)

    water = unary_union([make_valid(transform(shape(row['geometry']), local)) for row in polygons])
    xmin, zmin, xmax, zmax = water.bounds
    step = 8
    x = np.arange(np.floor(xmin / step) * step - 20, xmax + 20, step)
    z = np.arange(np.floor(zmin / step) * step - 20, zmax + 20, step)
    xx, zz = np.meshgrid(x, z)
    samples = np.stack([xx, zz], axis=-1)
    distances = np.zeros_like(xx)
    # Average a narrow directional fan to avoid a hard wake behind narrow piers.
    for offset, weight in [(-12, .25), (0, .5), (12, .25)]:
        angle = np.radians(wind + 180 + offset) - heading
        distances += weight * upwind_distance(water, samples, [-np.sin(angle), np.cos(angle)], step)
    # The shore gain and recovery length were selected using waterfront daylight views.
    fraction = np.clip(distances / 252, 0, 1)
    gain = .55 + .45 * fraction**2 * (3 - 2*fraction)
    gain[~contains_xy(water, xx, zz)] = 1
    image = output / 'ripple-shelter.png'
    output.mkdir(parents=True, exist_ok=True)
    Image.fromarray(np.rint(255 * gain).astype(np.uint8)).save(image)

    left, right = x[0] - step / 2, x[-1] + step / 2
    top, bottom = z[0] - step / 2, z[-1] + step / 2
    corners = np.array([[left, bottom], [right, bottom], [left, top]])
    lon, lat, _ = from_ecef.transform(*((corners - origin) @ basis + centre).T)
    raster = {'texture': hashlib.sha256(image.read_bytes()).hexdigest(),
              'windFrom': wind, 'corners': np.column_stack((lon, lat)).round(10).tolist()}
    (output / 'ripple-shelter.json').write_text(json.dumps(raster, indent=2) + '\n')


if __name__ == '__main__':
    scene = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    polygons = json.loads((scene / 'references/reservoir-wind/shoreline.geojson').read_text())
    bake(polygons['features'], scene, args.output)
