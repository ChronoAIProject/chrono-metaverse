"""Metric frame and surveyed waterline of the Sands SkyPark."""

import numpy as np

HOTEL_ID = "bay.1ce79c44-305a-4e67-80bf-9aa31f2f39a4"
ORIGIN = np.array([-475.49503137, 652.53070077])
ALONG = np.array([.03393571, .99942402])
ACROSS = ALONG[[1, 0]] * [1, -1]

# The high-resolution mesh puts the front and back of a 10 cm wide strip one
# metre above the water. Poolside photographs show a flush dark overflow edge.
# These surveyed points locate that strip without touching the crosswalks.
OUTER_EDGE = np.array([
    [-103.17, 20.27], [-94.516, 18.636], [-86.548, 17.064], [-77.004, 15.456],
    [-66.408, 13.920], [-60.876, 13.212], [-54.064, 12.360], [-46.584, 11.752],
    [-40.084, 11.140], [-34.148, 10.720], [-27.156, 10.256], [-20.936, 9.892],
    [-15.212, 9.608], [-10.584, 9.520], [-6.368, 9.424], [-1.528, 9.348],
    [4.452, 9.440], [11.216, 9.536], [17.956, 9.736], [23.996, 9.944],
    [34.192, 10.596], [39.06, 11.02],
])


def overflow_crest(positions, anchor):
    xyz = positions + anchor
    sx = (xyz[:, [0, 2]] - ORIGIN) @ np.array([ALONG, ACROSS]).T
    s, x = sx.T
    edge = np.interp(s, OUTER_EDGE[:, 0], OUTER_EDGE[:, 1])
    high_points = ((s >= -103.24) & (s <= 39.13) & (np.abs(x - edge) < .22) &
                   (np.abs(xyz[:, 1] - 134.785) < .025))
    xyz[high_points, 1] -= .914
    return (xyz - anchor).astype(positions.dtype), int(high_points.sum())
