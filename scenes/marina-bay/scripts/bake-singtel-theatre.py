"""Recover the fluted finish of the fly tower from its surveyed wall planes."""
import argparse
from collections import defaultdict
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import map_coordinates
import trimesh
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals

ROOT = Path(__file__).resolve().parents[1]
SOURCE = 'c5d3a36eb0e083d26db29f112e097b3afd94a0f944707e04b38ab66f2141eb9b'
ENTITY = 'bay.f43b6174-9599-462d-8f5b-9f4885a3be81'
PHOTO = 'https://www.esplanade.com/visit/venues-and-spaces/venues/singtel-waterfront-theatre'
WIDTH, BAND, SCALE = 1536, 288, 39
PITCH = .185


def coated_walls(mesh):
    groups = defaultdict(list)
    for i, (tri, normal) in enumerate(zip(mesh.triangles, mesh.face_normals)):
        # The tall stage volume rises above the podium roof. Short returns and
        # edge caps below the fly tower retain their original material.
        if abs(normal[1]) > .05 or np.ptp(tri[:, 1]) < 5:
            continue
        bearing = np.degrees(np.arctan2(normal[0], normal[2]))
        if tri[:, 1].min() >= 11.35:
            finish_type = 'flutes'
        elif -160 < bearing < -159 and 4.0 < tri[:, 1].min() < 4.4 and mesh.area_faces[i] > 80:
            finish_type = 'bay'
        else:
            continue
        groups[finish_type, round(bearing, 1), round(tri.mean(0) @ normal, 1)].append(i)
    return groups


def finish(rgb, positions, centre, finish_type):
    light = rgb.mean(axis=2)
    paint = np.clip((light - centre.mean() * .43) / (centre.mean() * .39), 0, 1)
    paint *= np.clip((1 - np.ptp(rgb, axis=2) / np.maximum(light, 1)) * 1.45, 0, 1)
    # Remove the broad capture-time colour cast from coated panels. Keep
    # photographed ventilation openings and their original darker values.
    if finish_type == 'bay':
        # Retain the broad patterned facade visible beneath the overhang. Its
        # survey already includes the shade that the renderer casts a second time.
        diffuse = rgb + np.clip(light[:,:,None] / 85, 0, 1) * [45,34,21]
        paint = np.zeros_like(light)
    else:
        diffuse = rgb * (1 - paint[:,:,None]) + paint[:,:,None] * np.clip(
            rgb - centre + [212,204,188], 0, 255)
    phase = positions * 2 * np.pi / PITCH
    slope = .38 * np.sin(phase) * paint
    normal = np.stack([-slope, np.zeros_like(slope), np.ones_like(slope)], axis=-1)
    normal /= np.linalg.norm(normal, axis=-1, keepdims=True)
    roughness = np.stack([np.ones_like(paint), .73 - .25*paint, .04 + .10*paint], axis=-1)
    return (diffuse.clip(0,255).astype(np.uint8), np.uint8(127.5*(1+normal)),
            np.uint8(255*roughness))


def panel_atlas(mesh, groups):
    photo = np.asarray(mesh.visual.material.baseColorTexture.convert('RGB'), dtype=float)
    height = BAND * len(groups)
    colour = np.full((height,WIDTH,3), 184, np.uint8)
    normals = np.full_like(colour, [128,128,255])
    roughness = np.full_like(colour, [255,140,65])
    vertices, uv, faces, face_normals = [], [], [], []
    for band, ((finish_type, _, _), indices) in enumerate(groups.items()):
        # Several charts have identical duplicate faces in this OneMap tile.
        _, unique = np.unique(mesh.triangles[indices].round(5).reshape(len(indices),9),
                              axis=0, return_index=True)
        indices = np.asarray(indices)[np.sort(unique)]
        normal = mesh.face_normals[indices[0]]
        tangent = np.array([normal[2],0,-normal[0]])
        tris = mesh.triangles[indices]
        plane = np.stack([tris @ tangent, tris[:,:,1]], axis=-1)
        low = plane.min(axis=(0,1))
        high = plane.max(axis=(0,1))
        scale = min(SCALE, (WIDTH-10)/(high[0]-low[0]), (BAND-10)/(high[1]-low[1]))
        size = np.ceil((high-low)*scale).astype(int)+8
        if size[0] > WIDTH or size[1] > BAND:
            raise ValueError('Survey plane exceeds atlas band')
        gx, gy = np.meshgrid(np.arange(size[0]), np.arange(size[1]))
        metres = np.stack([low[0]+(gx-3.5)/scale, high[1]-(gy-3.5)/scale], axis=-1)
        st = np.zeros_like(metres)
        best = np.full(gx.shape,-np.inf)
        for face, measured in zip(indices, plane):
            basis = np.linalg.inv((measured[1:]-measured[0]).T)
            b = (metres-measured[0]) @ basis.T
            weights = np.dstack([1-b.sum(axis=2),b])
            margin = weights.min(axis=2)
            keep = margin > best
            st[keep] = weights[keep] @ mesh.visual.uv[mesh.faces[face]]
            best[keep] = margin[keep]
            coords = np.column_stack([(4+(measured[:,0]-low[0])*scale)/WIDTH,
                1-(band*BAND+4+(high[1]-measured[:,1])*scale)/height])
            faces.append(np.arange(3)+len(vertices))
            vertices.extend(mesh.vertices[mesh.faces[face]])
            face_normals.extend(mesh.vertex_normals[mesh.faces[face]])
            uv.extend(coords)
        pixels = [(1-st[:,:,1])*(photo.shape[0]-1),st[:,:,0]*(photo.shape[1]-1)]
        rgb = np.stack([map_coordinates(photo[:,:,c],pixels,order=1,mode='nearest')
                        for c in range(3)],axis=-1)
        centre = np.median(rgb[best>=-.002],axis=0)
        region = np.s_[band*BAND:band*BAND+size[1], :size[0]]
        colour[region],normals[region],roughness[region] = finish(rgb,metres[:,:,0],centre,finish_type)

    def image(pixels, fmt):
        result = Image.fromarray(pixels)
        result.format = fmt
        return result

    mat = PBRMaterial(name='Singtel stage tower and waterfront panels', baseColorTexture=image(colour,'JPEG'),
                      normalTexture=image(normals,'PNG'), metallicRoughnessTexture=image(roughness,'PNG'),
                      roughnessFactor=1, metallicFactor=1)
    return trimesh.Trimesh(vertices=vertices,faces=faces,vertex_normals=face_normals,
                           visual=TextureVisuals(uv=uv,material=mat),process=False)


def bake(source):
    if hashlib.sha256(source.read_bytes()).hexdigest() != SOURCE:
        raise ValueError('Expected the original Singtel Waterfront Theatre survey')
    scene = trimesh.load_scene(source,process=False)
    mesh, = [m for m in scene.geometry.values() if m.visual.kind=='texture']
    groups = coated_walls(mesh)
    panels = panel_atlas(mesh,groups)
    selected = np.concatenate(list(groups.values()))
    keep = np.ones(len(mesh.faces),bool)
    keep[selected] = False
    source_normals = mesh.vertex_normals.copy()
    mesh.update_faces(keep)
    mesh.vertex_normals = source_normals
    scene.add_geometry(panels,geom_name=panels.visual.material.name)
    data = trimesh.exchange.gltf.export_glb(scene,include_normals=True)
    digest = hashlib.sha256(data).hexdigest()
    (ROOT/'assets'/(digest+'.glb')).write_bytes(data)
    path = ROOT/'build/onemap-entities.json'
    records = json.loads(path.read_text())
    entity = next(e for e in records if e['entityId']==ENTITY)
    entity['assetHash'] = digest
    entity['props']['舞台塔外墙'] = {'原模型':SOURCE,'实拍':PHOTO,'测绘墙面数':len(groups),
        '跨湾参照':'https://commons.wikimedia.org/?curid=152986183',
        '依据':'从原摄影图集采样涂层、通风口及临水饰面。竖纹间距、涂层色调与粗糙度按日景照估算，临水饰面按跨湾照校正采集阴影。'}
    entity['props']['三角形数'] = sum(len(m.faces) for m in scene.geometry.values())
    path.write_text(json.dumps(records,ensure_ascii=False,indent=2)+'\n')
    print(digest,len(data),len(groups),len(selected),len(panels.faces))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source',type=Path)
    bake(parser.parse_args().source)
