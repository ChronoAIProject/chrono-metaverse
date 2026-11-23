"""Victoria Theatre's four dials, registered to the rectified OneMap elevations."""

import numpy as np
import trimesh
from PIL import Image, ImageDraw
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals

PHOTO = "https://commons.wikimedia.org/wiki/File:Front_of_the_clock_tower,_Victoria_Theatre_and_Concert_Hall,_Singapore_-_20141101-01.JPG"
# Bearing, projected horizontal coordinate, elevation, cast rim radius (metres)
# and representative sRGB of the glass sampled from each survey elevation.
DIALS = [
    (-100, -.506, 39.036, 1.456, (197, 202, 198)),
    (170, 19.153, 39.080, 1.477, (135, 132, 130)),
    (80, .505, 39.142, 1.492, (128, 139, 152)),
    (-10, -19.116, 39.421, 1.477, (200, 203, 198)),
]


def dial_texture():
    size = 1024
    center = (size - 1) / 2
    radius = size * .48
    rows, cols = np.indices((size, size))
    x, y = (cols - center) / radius, (center - rows) / radius
    distance = np.hypot(x, y)
    glass = np.clip(235 + 4*y - 2*x - 6*distance**2, 205, 246)
    image = Image.fromarray(glass.astype('uint8')).convert('RGB')
    draw = ImageDraw.Draw(image)
    iron = (36, 40, 42)
    lead = (76, 79, 80)

    def points(coords):
        return [(center + radius*u, center - radius*v) for u, v in coords]

    def stroke(coords, width, fill):
        draw.line(points(coords), width=round(radius * width), fill=fill, joint='curve')

    def ring(r, width, color):
        draw.ellipse([center-r*radius, center-r*radius, center+r*radius, center+r*radius],
                     outline=color, width=round(radius * width))

    for r, width, color in [(1.012, .038, (62, 62, 58)), (.985, .031, iron),
                            (.883, .033, iron), (.603, .024, iron)]:
        ring(r, width, color)
    for minute in range(60):
        angle = np.pi * minute / 30
        radial = np.array([np.sin(angle), np.cos(angle)])
        stroke([.87*radial, .965*radial], .036 if minute % 5 == 0 else .020, iron)

    # The cast numerals span the space between two concentric iron rails.
    letters = {'I': [(0, 0, 0, 1)], 'V': [(-.5, 1, 0, 0), (0, 0, .5, 1)],
               'X': [(-.5, 1, .5, 0), (-.5, 0, .5, 1)]}
    numerals = ('XII', 'I', 'II', 'III', 'IIII', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI')
    for hour, numeral in enumerate(numerals):
        angle = hour * np.pi / 6
        up = np.array([np.sin(angle), np.cos(angle)])
        right = np.array([up[1], -up[0]])
        widths = [.046 if char == 'I' else .102 for char in numeral]
        start = -(sum(widths) + .012 * (len(numeral) - 1)) / 2
        for char, width in zip(numeral, widths):
            middle = start + width/2
            for u, v, s, t in letters[char]:
                stroke([up*(.586+.275*v) + right*(middle+u*width),
                        up*(.586+.275*t) + right*(middle+s*width)], .021, iron)
            start += width + .012

    # A central hexagonal light surrounded by six segments is visible in the photo.
    angles = np.arange(6) * np.pi / 3
    corners = np.column_stack((np.cos(angles), np.sin(angles)))
    stroke(np.vstack((corners, corners[0]))*.185, .011, lead)
    for i, c in enumerate(corners):
        joint = .185*c + .175*corners[(i+1) % 6]
        stroke([.185*c, joint, .588*joint/np.linalg.norm(joint)], .012, lead)
    # A solid swatch outside the dial supplies the raised hands and arbor.
    draw.rectangle((0, 0, 50, 50), fill=iron)
    return image.resize((256, 256), Image.Resampling.LANCZOS)


def make_dials(facade):
    triangles, normals = facade.triangles, facade.face_normals
    panel = ((triangles[:, :, 1] > 42.5).sum(1) == 2) & (triangles[:, :, 1].min(1) < 36)
    bearing = np.rint(np.degrees(np.arctan2(normals[:, 0], normals[:, 2])) / 10) * 10
    vertices, faces, texcoords, colors = [], [], [], []
    for azimuth, horizontal, elevation, radius, tint in DIALS:
        match = np.flatnonzero(panel & (np.abs(normals[:, 1]) < .1) & (bearing == azimuth))
        if len(match) != 1:
            raise ValueError(f"Expected a single survey head edge at {azimuth} degrees")
        normal = normals[match[0]]
        right = np.cross([0, 1, 0], normal)
        right /= np.linalg.norm(right)
        up = np.cross(normal, right)
        # Solve the facade plane at the registered horizontal and vertical coordinates.
        center = np.linalg.solve([right, [0, 1, 0], normal],
                                 [horizontal, elevation, triangles[match[0], 0] @ normal])
        # glTF multiplies linear vertex colours into an sRGB texture.
        color = np.r_[np.rint(255*((np.array(tint)/255+.055)/(234/255+.055))**2.4), 255]
        def vertex(u, v, depth, hand=False):
            vertices.append(center + radius*(right*u + up*v) + depth*normal)
            colors.append(color)
            texcoords.append((.023, .977) if hand else (.5+.48*u, .5+.48*v))
            return len(vertices) - 1

        axis = vertex(0, 0, .036)
        angles = np.arange(48) * 2*np.pi/48
        previous = []
        for r, depth in [(.96, .036), (.982, .054), (1.005, .049), (1.016, .014)]:
            ring = [vertex(r*np.cos(a), r*np.sin(a), depth) for a in angles]
            for i in range(len(ring)):
                j = (i+1) % len(ring)
                if previous:
                    faces.extend([(previous[i], ring[i], ring[j]), (previous[i], ring[j], previous[j])])
                else:
                    faces.append((axis, ring[i], ring[j]))
            previous = ring

        # The front photo shows approximately 06:10. All faces share that static reading.
        for angle, length, width, depth in [(185, .58, .050, .075), (60, .84, .039, .095)]:
            a = np.deg2rad(angle)
            radial, tangent = np.array([np.sin(a), np.cos(a)]), np.array([np.cos(a), -np.sin(a)])
            pivot = vertex(0, 0, depth, True)
            outline = [(-width*.52, -.085), (width*.52, -.085), (width, .35*length),
                       (width*.66, .76*length), (0, length), (-width*.66, .76*length), (-width, .35*length)]
            rim = [vertex(*(tangent*u+radial*v), depth, True) for u, v in outline]
            faces.extend((pivot, k, rim[(i+1) % len(rim)]) for i, k in enumerate(rim))
        pivot = vertex(0, 0, .114, True)
        cap = [vertex(.057*np.cos(a), .057*np.sin(a), .104, True) for a in angles[::4]]
        faces.extend((pivot, k, cap[(i+1) % len(cap)]) for i, k in enumerate(cap))

    material = PBRMaterial(name="Victoria clock ironwork and glazing", baseColorTexture=dial_texture(),
                           metallicFactor=0, roughnessFactor=.69)
    visual = TextureVisuals(uv=texcoords, material=material)
    visual.vertex_attributes['color'] = np.array(colors, dtype='uint8')
    return trimesh.Trimesh(vertices=vertices, faces=faces, visual=visual, process=False)
