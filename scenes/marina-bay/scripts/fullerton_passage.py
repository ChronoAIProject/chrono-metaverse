"""Open the waterfront entrance below One Fullerton's surveyed canopy."""

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image
from shapely import constrained_delaunay_triangles
from shapely.geometry import Polygon, box
from trimesh.visual.texture import TextureVisuals
from trimesh.visual.material import PBRMaterial

ROOT = Path(__file__).resolve().parents[1]
ENTITY = "bay.0c252ba3-f96a-4c82-b87b-fa5ef91708f2"
SOURCE = "fc6df4b2bdf01666c8e6ac4902d14acd66be88ff6df2a7eb03e7e3785afd0bf2"
PHOTO = "https://commons.wikimedia.org/wiki/File:Singapore_-_panoramio_(109).jpg"
LEFT, RIGHT, HEAD, FLOOR, DEPTH = 96.0, 112.9, 8.15, -.245, 11.2


def carve(facade, local):
    # Clip the projected facade against the photographed entrance. Each source
    # triangle has its own survey UVs and is interpolated in its own plane.
    tri = local[facade.faces]
    x, h, s = tri.transpose(2, 0, 1)
    select = ((s.max(1) > LEFT) & (s.min(1) < RIGHT) & (h.min(1) < HEAD) & (h.max(1) > 0)
              & (x.max(1) < 18) & (x.min(1) > 14))
    normal = np.cross(tri[:, 1]-tri[:, 0], tri[:, 2]-tri[:, 0])
    select &= np.abs(normal[:, 0]) > .82*np.linalg.norm(normal, axis=1)
    if select.sum() != 16:
        raise ValueError("The sixteen registered entrance triangles have changed")
    uv = facade.visual.uv
    attributes = np.column_stack((facade.vertices, facade.vertex_normals, uv))
    keep = [attributes[facade.faces[~select]].reshape(-1, 8)]
    aperture = box(LEFT, -.08, RIGHT, HEAD)
    profiles = []
    for index in np.flatnonzero(select):
        xyz = tri[index]
        flat = xyz[:, [2, 1]]
        inverse = np.linalg.inv(flat[1:] - flat[:1])
        original = attributes[facade.faces[index]]
        for poly in constrained_delaunay_triangles(Polygon(flat).difference(aperture)).geoms:
            points = np.array(poly.exterior.coords)[:3]
            weights = (points-flat[0]) @ inverse
            rows = np.column_stack((1-weights.sum(1), weights)) @ original
            if np.cross(rows[1,:3]-rows[0,:3], rows[2,:3]-rows[0,:3]) @ facade.face_normals[index] < 0:
                rows = rows[::-1]
            keep.append(rows)
        profiles.extend(xyz[:, [2,0]])
    source = np.unique(np.round(profiles, 4), axis=0)
    positions, ids = np.unique(np.vstack(keep).astype('float32'), return_inverse=True, axis=0)
    wall = trimesh.Trimesh(vertices=positions[:,:3], vertex_normals=positions[:,3:6], faces=ids.reshape(-1,3),
                           visual=TextureVisuals(uv=positions[:,6:], material=facade.visual.material), process=False)
    return wall, lambda station: np.interp(station, source[:,0], source[:,1])


def passage_mesh(front, transform):
    vertices, colors, faces, uv = [], [], [], []
    # Vertices use depth from the curved survey wall, elevation, station along the bay.
    def quad(corners, normal, color, patch=None):
        local = np.asarray(corners, float)
        inset, y, s = local.T
        xyz = np.column_stack((front(s)+inset, y, s))
        ids = np.arange(len(vertices), len(vertices)+4)
        if np.cross(xyz[1]-xyz[0],xyz[2]-xyz[0]) @ normal < 0:
            ids = ids[::-1]
        vertices.extend(xyz)
        factor = 1 - .53*np.minimum(1, np.maximum(0, inset)/DEPTH)**.72
        colors.extend(np.column_stack((np.asarray(color)*factor[:,None], np.full(4,255))))
        if patch == 'glass':
            uv.extend(np.column_stack(((1+253*inset/DEPTH)/512, (1+253*(y-FLOOR)/(HEAD-FLOOR))/256)))
        elif patch == 'rear':
            uv.extend(np.column_stack(((259+248*(s-LEFT)/(RIGHT-LEFT))/512,
                                       (132+122*(y-FLOOR)/(HEAD-FLOOR))/256)))
        elif patch == 'stone':
            uv.extend([(260/512,3/256),(505/512,3/256),(505/512,122/256),(260/512,122/256)])
        else:
            uv.extend([(.994,.5)]*4)
        faces.extend([(ids[0],ids[1],ids[2]),(ids[0],ids[2],ids[3])])

    def horizontal(a,b,s,t,y,color,ceiling=False,patch=None):
        quad([(a,y,s),(a,y,t),(b,y,t),(b,y,s)], [0,-1 if ceiling else 1,0],color,patch)

    def across(a,s,t,lo,hi,color,patch=None):
        quad([(a,lo,s),(a,hi,s),(a,hi,t),(a,lo,t)], [-1,0,0],color,patch)

    def side(a,b,s,lo,hi,color,right=False,patch=None):
        quad([(a,lo,s),(b,lo,s),(b,hi,s),(a,hi,s)], [0,0,-1 if right else 1],color,patch)

    # The 2014 elevation shows a glazed return on the left, pale floor inserts,
    # a shaded soffit and a stair at the back right. Interior dimensions are estimates.
    spans = np.linspace(LEFT, RIGHT, 19)
    depths = np.linspace(0, DEPTH, 14)
    rng = np.random.default_rng(425)
    for j,(s,t) in enumerate(zip(spans,spans[1:])):
        for k,(a,b) in enumerate(zip(depths,depths[1:])):
            stone = np.array([153,149,143]) + rng.integers(-4,5)
            horizontal(a,b,s,t,FLOOR,stone,patch="stone")
            if j%2 == 1 and k%2 == 0:
                mid_u, mid_s = (a+b)/2, (s+t)/2
                horizontal(mid_u-.085,mid_u+.085,mid_s-.085,mid_s+.085,FLOOR+.003,[70,70,68])
        horizontal(0,DEPTH,s,t,HEAD,[131,132,129],True)


    for s,right in [(LEFT,False),(RIGHT,True)]:
        for a,b in zip(depths,depths[1:]):
            side(a,b,s,FLOOR,HEAD,[208,216,222],right,"glass")

    lower, upper = RIGHT-5.8, RIGHT-.35
    run, rise, count = .31,.16,10
    landing_height = FLOOR + count*rise
    # The stairs lead onto a recessed landing. At eye level the landing and
    # upper return mask the terminal wall in the back of the photograph.
    across(DEPTH,LEFT,lower,FLOOR,HEAD,[206,210,212],"rear")
    across(DEPTH,upper,RIGHT,FLOOR,HEAD,[206,210,212],"rear")
    across(DEPTH,lower,upper,landing_height+2.8,HEAD,[150,154,151],"rear")
    horizontal(DEPTH,DEPTH+2.5,lower,upper,landing_height,[135,129,121],patch="stone")
    horizontal(DEPTH,DEPTH+2.5,lower,upper,landing_height+2.8,[104,99,90],True)
    side(DEPTH,DEPTH+2.5,lower,landing_height,landing_height+2.8,[85,91,89])
    side(DEPTH,DEPTH+2.5,upper,landing_height,landing_height+2.8,[85,91,89],True)
    across(DEPTH+2.5,lower,upper,landing_height,landing_height+2.8,[70,71,69])
    for s in np.linspace(LEFT+.9,lower-.4,5):
        across(DEPTH-.016,s,s+.036,FLOOR,HEAD,[89,92,89])
    for k in range(count):
        a = DEPTH-(count-k)*run
        h = FLOOR+(k+1)*rise
        across(a,lower,upper,h-rise,h,[114,111,105])
        horizontal(a,a+run,lower,upper,h,[148,145,139])
        side(a,a+run,lower,FLOOR,h,[116,114,109],True)
        side(a,a+run,upper,FLOOR,h,[116,114,109])

    atlas=Image.open(ROOT/'references/fullerton-passage-materials.jpg').convert("RGB")
    atlas.format="JPEG"
    material=PBRMaterial(name="Shaded entrance stone and glazing",baseColorTexture=atlas,
                         metallicFactor=0,roughnessFactor=.73)
    visual=TextureVisuals(uv=uv,material=material)
    visual.vertex_attributes["color"]=np.uint8(np.clip(colors,0,255))
    return trimesh.Trimesh(vertices=transform(np.array(vertices)), faces=faces,visual=visual,process=False)


def bake(path, entity, quay, output):
    if entity['entityId'] != ENTITY:
        raise ValueError('Expected the One Fullerton waterfront building')
    scene = trimesh.load_scene(path, process=False)
    facade, = [k for k,m in scene.geometry.items() if isinstance(m.visual, TextureVisuals)]
    start,end = np.array(quay['start']),np.array(quay['end'])
    along=end-start
    along[1]=0
    along/=np.linalg.norm(along)
    axes=np.array([along[[2,1,0]]*[1,0,-1], [0,1,0], along])
    low,high = np.array([entity['bounds'][k] for k in ['min','max']])
    center=(low+high)/2
    center[1]=low[1]
    offset=center-start
    mesh=scene.geometry[facade]
    scene.geometry[facade],front=carve(mesh,(mesh.vertices+offset) @ axes.T)
    inside=passage_mesh(front,lambda pts: pts @ axes-offset)
    # The original facade uses baked survey imagery. The interior has its own
    # albedo entity so the sun, canopy shadow and vertex occlusion apply to it.
    data = trimesh.exchange.gltf.export_glb(scene,include_normals=True)
    digest = hashlib.sha256(data).hexdigest()
    (output/(digest+'.glb')).write_bytes(data)
    entity['assetHash'] = digest
    entity['props'].update({'三角形数':sum(len(m.faces) for m in scene.geometry.values()),
        '入口参考':PHOTO,'入口门廊':'按临水雨棚下的测绘立面恢复入口开口。'})
    inside.apply_translation(center)
    low, high = inside.bounds.copy()
    anchor = (low+high)/2
    anchor[1] = low[1]
    inside.apply_translation(-anchor)
    interior = trimesh.exchange.gltf.export_glb(trimesh.Scene(inside),include_normals=True)
    facing = hashlib.sha256(interior).hexdigest()
    (output/(facing+'.glb')).write_bytes(interior)
    return dict(entityId="bay.fullerton-entrance-passage",regionId=entity["regionId"],layer="ext",kind="structure",
                label="One Fullerton · 临水入口门廊",assetHash=facing,
                bounds={"min":low.tolist(),"max":high.tolist()},material={"shading":"albedo"},
                props={"background":True,"入口参考":PHOTO,
                       "门廊纹理署名":"Андрей Бобровский · Singapore - panoramio (109) · 2014 · https://creativecommons.org/licenses/by/3.0/ · 裁切、透视纠正并调整阴影。石材纹理 Poly Haven Granite Tile 04 · CC0。",
                       "门廊":"玻璃侧墙、铺石与后方台阶依实景照片重建。进深、室内尺寸与材料为估值。地坪按场景前方广场标高衔接。"})


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source',type=Path)
    source=parser.parse_args().source
    if hashlib.sha256(source.read_bytes()).hexdigest() != SOURCE:
        raise ValueError('Expected the original opened terrace asset')
    file=ROOT/'build/onemap-entities.json'
    entries=json.loads(file.read_text())
    e=next(e for e in entries if e['entityId']==ENTITY)
    room=bake(source,e,json.loads((ROOT/'context.json').read_text())['quay'],ROOT/'assets')
    room_file=ROOT/'build/streetscape.json'
    records={r['entityId']:r for r in json.loads(room_file.read_text())}
    records[room['entityId']]=room
    room_file.write_text(json.dumps(list(records.values()),indent=2,ensure_ascii=False)+'\n')
    print(e['assetHash'],room['assetHash'])
    file.write_text(json.dumps(entries,indent=2,ensure_ascii=False)+'\n')
