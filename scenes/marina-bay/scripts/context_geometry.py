"""场景配准与校验共用的平面几何变换。"""
import math

import numpy as np


def floor_outline(shape):
    transform = shape.get('transform', {})
    yaw = math.radians(transform.get('yaw', 0))
    rotation = np.array([[math.cos(yaw), math.sin(yaw)], [-math.sin(yaw), math.cos(yaw)]])
    return np.array(shape['outline']['points']) @ rotation.T + np.array(transform.get('position', [0, 0, 0]))[[0, 2]]
