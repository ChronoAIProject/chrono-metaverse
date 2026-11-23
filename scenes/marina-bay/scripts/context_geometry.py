"""场景配准与校验共用的平面几何变换。"""
import math

import numpy as np


def floor_outline(shape):
    transform = shape.get('transform', {})
    yaw = math.radians(transform.get('yaw', 0))
    rotation = np.array([[math.cos(yaw), math.sin(yaw)], [-math.sin(yaw), math.cos(yaw)]])
    return np.array(shape['outline']['points']) @ rotation.T + np.array(transform.get('position', [0, 0, 0]))[[0, 2]]


def geographic_point(longitude, latitude, origin, rotation, shift):
    """Project a sea-level WGS84 coordinate into the aligned OneMap frame."""
    lon, lat = np.radians([longitude, latitude])
    eccentricity = 6.6943799901413165e-3
    radius = 6378137 / np.sqrt(1 - eccentricity * np.sin(lat) ** 2)
    xyz = radius * np.array([np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon),
                             (1 - eccentricity) * np.sin(lat)])
    return (xyz - origin) @ rotation.T + shift
