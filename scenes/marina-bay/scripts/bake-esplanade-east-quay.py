"""Build the east promenade, gangway and floating landing beside the Outdoor Theatre."""
import hashlib
from importlib import import_module
import json

import numpy as np
from PIL import Image, ImageFilter
import trimesh

from bridge_geometry import SurfaceBatch
from esplanade_quay import ROOT, QuaySurface


def stone_texture(granite):
    stone = np.array(granite.resize((512, 512), Image.Resampling.LANCZOS)).astype(float)
    # A 2.4 m repeat contains four courses with half-block staggered joints.
    y, x = np.indices(stone.shape[:2])
    joint = (y % 128 < 2) | ((x + 128 * (y // 128 % 2)) % 256 < 2)
    stone[joint] *= .57
    image = Image.fromarray(stone.round().clip(0, 255).astype('uint8'))
    image.format = 'JPEG'
    return image


def wall_texture(granite):
    # Keep the high-frequency mineral grain. The photographed quay has darker joints
    # and a band of damp stone at the reservoir, with much less contrast on each slab.
    stone = granite.convert('L').resize((512, 512), Image.Resampling.LANCZOS)
    grain = np.asarray(stone, dtype=float) - np.asarray(stone.filter(ImageFilter.GaussianBlur(6)))
    rng = np.random.default_rng(1977)
    h, w = 512, 2048
    y, x = np.indices((h, w))
    height = (1-y/(h-1))*4
    row = y//64
    col = (x+64*(row%2))//128
    blocks = rng.normal(0, 3, (8,16))[row,col%16]
    detail = grain[(y+11*col+35*row)%512, (x+87*row+23*col)%512]
    tide = .62+.06*np.sin(2*np.pi*x/w)+.04*np.sin(10*np.pi*x/w)
    value = 118 + blocks + .27*detail - 27*np.clip((tide-height)/.28, 0,1)
    joints = (y%64 < 2) | ((x+64*(row%2))%128 < 2)
    value[joints] *= .79
    image = Image.fromarray(np.uint8(np.clip(value[:,:,None]*[1.02,1.0,.94],0,255)))
    image.format = 'JPEG'
    return image


def bake():
    quay = QuaySurface()
    reference = quay.reference
    kit = import_module('bake-bay-landings')
    granite = json.loads((ROOT / 'context.json').read_text())['quay']['granite']['color']
    with Image.open(ROOT / 'assets' / (granite + '.webp')) as photo:
        texture = stone_texture(photo.convert('RGB'))
        facing = wall_texture(photo)
    paving = SurfaceBatch('Esplanade promenade paving', [213,211,203,255], 0, .87, baseColorTexture=texture)
    wall = SurfaceBatch('Esplanade quay stone', [211,212,209,255], 0, .91, baseColorTexture=facing)
    metal = SurfaceBatch('Esplanade quay rails', [152,158,156,255], .50, .40)
    float_deck = SurfaceBatch('Esplanade landing deck', [148,151,147,255], 0, .83, baseColorTexture=texture)
    float_edge = SurfaceBatch('Esplanade pontoon hull', [71,77,75,255], .18, .66)
    for xyz in quay.triangles():
        paving.add(xyz, [[0,1,2]], xyz[:, [0,2]] / 2.4)
    shelter = reference['shelter']
    plinth = np.array(shelter['footprint'])
    grades = [quay.height(point) for point in plinth]
    shelter_level = max(grades) + .025
    kit.build_deck(plinth, np.full(len(plinth), shelter_level), shelter_level - min(grades) + .03,
                   paving, wall, wall, 2.4)
    posts = set()
    landing = reference['landing']
    ramp = np.array(landing['ramp'])
    # Locate the opening by the shoreline stations closest to the two gangway corners.
    fronts = np.array([s[0] for s in quay.sections])
    hinge = ramp[2:, [0,2]].mean(axis=0)
    gap = np.argmin(np.linalg.norm((fronts[:-1, [0,2]] + fronts[1:, [0,2]]) / 2 - hinge, axis=1))
    distance = 0
    for i, (a, b) in enumerate(zip(fronts, fronts[1:])):
        length = np.linalg.norm(b[[0,2]]-a[[0,2]])
        floor = min(reference['stations'][i]['edge'][1], reference['stations'][i+1]['edge'][1]) - .7
        xyz = np.array([a,b,[b[0],floor,b[2]],[a[0],floor,a[2]]])
        datum = reference['stations'][i]['edge'][1] - .198
        # Start the atlas a little below the visible waterline.
        uv = [[u/16, (y-datum+.30)/4] for u,y in [
            (distance,a[1]),(distance+length,b[1]),(distance+length,floor),(distance,floor)]]
        wall.add(xyz, [[0,2,1],[0,3,2]], uv)
        distance += length
        if i != gap:
            kit.guardrail(metal, a[[0,2]], b[[0,2]], a[1], b[1], posts)
    # Water in the survey frame is 0.30 m above the mapped ellipsoid surface.
    deck_xyz = np.array(landing['deck'])
    plan = deck_xyz[:, [0,2]]
    top = deck_xyz[:, 1].mean() + .30 + landing['freeboard']
    kit.build_deck(plan, np.full(len(plan),top), .72, float_deck, float_edge, float_edge, 1.2)
    shore = (fronts[gap,1] + fronts[gap+1,1]) / 2
    kit.build_deck(ramp[:, [0,2]], [top+.025,top+.025,shore+.025,shore+.025], .14,
                   float_deck, float_edge, float_edge, 1.2)
    for i,j in [(0,3),(1,2)]:
        kit.guardrail(metal, ramp[i,[0,2]], ramp[j,[0,2]], top+.025, shore+.025, posts)
    for x,datum,z in landing['piles']:
        float_edge.tube([[x,datum-.3,z],[x,top+1.20,z]], .15, 12)
    scene = trimesh.Scene()
    for batch in (paving, wall, metal, float_deck, float_edge):
        scene.add_geometry(batch.mesh(), geom_name=batch.material.name)
    low, high = scene.bounds
    origin=(high+low)/2
    origin[1]=low[1]
    for mesh in scene.geometry.values():
        mesh.apply_translation(-origin)
    data=trimesh.exchange.gltf.export_glb(scene,include_normals=True)
    digest=hashlib.sha256(data).hexdigest()
    (ROOT/'assets'/(digest+'.glb')).write_bytes(data)
    entity=dict(entityId='bay.esplanade-east-quay',label='滨海艺术中心 · 东侧岸墙、步道与浮码头',
                layer='ext',kind='structure',regionId='marina-bay-exterior',assetHash=digest,
                material={'shading':'albedo'},bounds={'min':low.tolist(),'max':high.tolist()},
                props={'background':True,'岸线':'Map Data © Singapore Land Authority / OneMap',
                       '码头轮廓':reference['osm'],'实拍':reference['photo'],
                       '高程':'岸顶按跨湾照片估高，内侧和两端的坡面与现有地面衔接。浮台干舷、栏杆和桩径为估值。',
                       '铺装':'Poly Haven Granite Tile 04, CC0'})
    (ROOT/'build/esplanade-east-quay.json').write_text(json.dumps(entity,ensure_ascii=False,indent=2)+'\n')
    # The surveyed shelter's record is still in the pre-placement frame.
    source_y = json.loads((ROOT/'build/placement.json').read_text())['translation'][1]
    path = ROOT/'build/onemap-entities.json'
    records = json.loads(path.read_text())
    record = next(row for row in records if row['entityId'] == shelter['entityId'])
    record['bounds']['min'][1] = round(shelter_level - source_y, 6)
    record['bounds']['max'][1] = round(shelter_level - source_y + shelter['surveyHeight'], 6)
    path.write_text(json.dumps(records, ensure_ascii=False, indent=2)+'\n')
    print(digest,len(data))


if __name__=='__main__':
    bake()
