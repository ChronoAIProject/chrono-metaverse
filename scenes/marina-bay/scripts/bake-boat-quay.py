"""Build the surveyed riverside shophouse row, including roof pitches and arcades."""
import json
import sys

import numpy as np
from PIL import Image
from shapely.geometry import LineString, Point, Polygon, box
import trimesh
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals

from context_geometry import geographic_point
from scanned_canopy import ROOT, write_tree_asset

sys.path.insert(0, str(ROOT.parents[1] / 'recon/src'))
from metaverse_recon.context.convert import frame

CREDIT = ('Footprints © OpenStreetMap contributors (ODbL). Roof colour survey: OneMap, '
          'Singapore Land Authority. Cropped and rectified textures: Shophouses on Boat Quay, '
          'Singapore (2023)-L1003691 by Frank Schulenburg, Boat Quay in Singapore (Cropped) by '
          'Chensiyuan (both CC BY-SA 4.0), and SG-riverside-boat-quay by Balou46 (CC BY-SA 3.0). '
          'Adapted textures and model: https://creativecommons.org/licenses/by-sa/4.0/.')
LIMEWASH = [(244,234,211),(244,226,189),(225,234,222),(201,222,216),
            (227,209,187),(239,219,163),(194,219,227),(237,225,218)]
CANVAS = [(121,62,62),(68,94,108),(60,98,88),(181,169,145),(71,75,78)]


class AtlasMesh:
    def __init__(self):
        self.vertices, self.faces, self.uv, self.colours = [], [], [], []

    def face(self, points, tile, tint=(255,255,255), coordinates=None):
        points = np.array(points)
        if len(points) < 3:
            return
        if coordinates is None:
            coordinates = [(0,0),(1,0),(1,1),(0,1)][:len(points)]
        offset = len(self.vertices)
        for j in range(1,len(points)-1):
            self.faces.append((offset,offset+j,offset+j+1))
        self.vertices.extend(points)
        # A padding inset keeps neighbouring photo patches out of the mip chain.
        for u,v in coordinates:
            self.uv.append(((tile%4+.012+.976*u)/4,1-(tile//4+.988-.976*v)/6))
        self.colours.extend([np.rint(255*(np.array(tint)/255)**2.2)]*len(points))

    def build(self):
        atlas = Image.open(ROOT/'references/boat-quay-surfaces.jpg')
        paint = PBRMaterial(name='Boat Quay plaster, shutters, pantiles and canvas',
                            baseColorTexture=atlas,metallicFactor=0,roughnessFactor=.88,
                            doubleSided=True)
        mesh = trimesh.Trimesh(vertices=self.vertices, faces=self.faces, process=False,
                               visual=TextureVisuals(uv=self.uv,material=paint))
        mesh.visual.vertex_attributes['color'] = np.column_stack(
            (self.colours,np.full(len(self.colours),255))).astype(np.uint8)
        return mesh


def house(mesh, row, points, ground):
    # Work in the plane of the actual shopfront, including skewed end lots.
    start = points[0]
    edge = points[1]-start
    width = np.linalg.norm(edge)
    along = edge/width
    inward = np.array([-along[1],along[0]])
    if (points.mean(0)-start) @ inward < 0:
        inward *= -1
    polygon = Polygon(np.column_stack(((points-start) @ along,(points-start) @ inward)))
    depth = polygon.bounds[3]
    def xyz(u,v,y):
        x,z = start+u*along+v*inward
        return [x,ground+y,z]
    def panel(ua,ub,v,lo,hi,texture,colour):
        mesh.face([xyz(ua,v,lo),xyz(ub,v,lo),xyz(ub,v,hi),xyz(ua,v,hi)],texture,colour)
    def shelf(ua,ub,va,vb,ya,yb,tile,colour):
        mesh.face([xyz(ua,va,ya),xyz(ub,va,ya),xyz(ub,vb,yb),xyz(ua,vb,yb)],tile,colour)
    number = row['number']
    rng = np.random.default_rng(row['way'])
    samples = np.array(row['roofSamples'])
    tiles = samples[:,0] > samples[:,2]*1.25
    pitched = tiles[:10].sum() >= 5
    ridge = row['height'] + rng.uniform(-.55,.35)
    eaves = ridge-rng.uniform(2.9,4.0) if pitched else ridge
    render = LIMEWASH[rng.integers(len(LIMEWASH))]
    facade = rng.choice([12,13,16,17,18,19]) if pitched else rng.choice([14,15,20])
    trim = (239,233,213)
    # Orthophotos show two roof ranges on many deep lots. Clip both ridges
    # to the real rear corners instead of approximating the lots as rectangles.
    breaks = np.array([0,.32,.64,.81,1])*depth if pitched else np.array([0,depth])
    levels = [eaves,ridge,eaves-.55,ridge-1.2,eaves-.6] if pitched else [ridge,ridge]
    xmin,_,xmax,_ = polygon.bounds
    for j,(va,vb) in enumerate(zip(breaks,breaks[1:])):
        part = polygon.intersection(box(xmin-1,va,xmax+1,vb))
        ring = np.array(part.exterior.coords)[:-1]
        height = lambda v: np.interp(v,[va,vb],levels[j:j+2])
        mid = np.clip(round(((va+vb)/(2*depth)-.10)/.05),0,len(samples)-1)
        tone = np.clip(samples[mid]*1.17,60,238)
        uv = [((u-xmin)/(xmax-xmin),(v-va)/(vb-va)) for u,v in ring]
        if pitched and tiles[mid]:
            # Preserve the relative ortho brightness while recovering the red clay
            # hue seen in the across-river photograph.
            tone = np.clip(tone*[1.04,.83,.68],55,245)
        mesh.face([xyz(u,v,height(v)) for u,v in ring],7,tone,uv)
        for (ua,a),(ub,b) in zip(ring,np.roll(ring,-1,axis=0)):
            # Only boundary walls get gables. Skip cross-sections at roof ridges.
            if abs(a-b)<.0001 and b<depth-.001:
                continue
            mesh.face([xyz(ua,a,0),xyz(ub,b,0),xyz(ub,b,height(b)),xyz(ua,a,height(a))],
                      6,render)
    panel(0,width,0,0,eaves,6,render)
    arcade = 3.55
    panel(width*.06,width*.94,-.025,.08,arcade,4+number%2,(217,212,199))
    panel(width*.035,width*.965,-.065,arcade+.03,eaves-.1,facade,(251,248,238))
    mid_sill = arcade+(eaves-arcade)*.54
    shelf(.06,width-.06,-.16,0,mid_sill,mid_sill,6,trim)
    panel(0,width,-.20,eaves-.18,eaves,6,trim)
    if pitched and number%3 != 0:
        # Lime-plastered firewalls break the roof line between adjoining terraces.
        for j,(va,vb) in enumerate(zip(breaks,breaks[1:])):
            span = polygon.intersection(box(xmin-1,va,xmax+1,vb))
            ring = np.asarray(span.exterior.coords)
            for (ua,a),(ub,b) in zip(ring,ring[1:]):
                if ua+ub>width or abs(a-b)<.3:
                    continue
                ya,yb=np.interp([a,b],[va,vb],levels[j:j+2])
                mesh.face([xyz(ua,a,ya),xyz(ub,b,yb),xyz(ub,b,yb+.26),xyz(ua,a,ya+.26)],6,trim)
                mesh.face([xyz(ua,a,ya+.26),xyz(ub,b,yb+.26),xyz(ub+.15,b,yb+.26),xyz(ua+.15,a,ya+.26)],6,trim)
    for u in [0,width-.22]:
        panel(u,u+.22,-.21,0,eaves+.14,6,trim)
        mesh.face([xyz(u,-.21,0),xyz(u,0,0),xyz(u,0,eaves),xyz(u,-.21,eaves)],6,trim)
    shelf(-.1,width+.1,-.4,.12,eaves+.12,eaves+.17,7,trim)
    awning = CANVAS[rng.integers(len(CANVAS))]
    shelf(.06,width-.06,-2.5,0,2.85,3.57,8,awning)
    panel(.06,width-.06,-2.5,2.63,2.85,8,awning)
    # Detached dining shelters sit across the five-foot way, on the bank side.
    for a,b,ha,hb in [(-9,-7,2.7,3.4),(-7,-4.9,3.4,2.7)]:
        shelf(.12,width-.12,a,b,ha,hb,8,awning)
    for u in [.16,width-.23]:
        for v in [-8.9,-5.0]:
            panel(u,u+.075,v,.05,2.77,6,(76,72,61))
            mesh.face([xyz(u,v,0),xyz(u,v+.075,0),xyz(u,v+.075,2.77),xyz(u,v,2.77)],6,(76,72,61))


def bake():
    source = json.loads((ROOT/'references/boat-quay.json').read_text())
    config = json.loads((ROOT/'context.json').read_text())['oneMap']
    origin, rotation = frame(config)
    shift = np.array(json.loads((ROOT/'build/alignment.json').read_text())['shift'])
    mesh = AtlasMesh()
    ground_datum = json.loads((ROOT/'build/environment.json').read_text())['props']['environment']['map']['origin'][1]
    def local(ll):
        return geographic_point(*ll,origin,rotation,shift)
    bank = LineString([local(ll)[[0,2]] for ll in source['shoreline']])
    fronts = []
    for row in source['houses']:
        points = np.array([geographic_point(lon,lat,origin,rotation,shift) for lon,lat in row['ring']])
        ground = ground_datum + .16 + (points[:,1].mean()+config['officeHeightMeters']-shift[1])
        top = ground + 1.21
        house(mesh,row,points[:,[0,2]],top)
        fronts.extend(points[:2,[0,2]])
    # Subdivide the real river edge at shop-width intervals to keep the
    # photographic stone face and the brick paving at a consistent scale.
    front = LineString(sorted(fronts,key=lambda q:bank.project(Point(q))))
    lo,hi = sorted(bank.project(Point(q)) for q in (front.coords[0],front.coords[-1]))
    stations = np.linspace(lo,hi,int(np.ceil((hi-lo)/4.8))+1)
    def level(q, y):
        return [q[0],y,q[1]]
    top = ground_datum + 1.30
    for a,b in zip(stations,stations[1:]):
        pa,pb = bank.interpolate(a),bank.interpolate(b)
        outer = np.asarray([pa.coords[0],pb.coords[0]])
        inner = np.asarray([front.interpolate(front.project(pt)).coords[0] for pt in (pa,pb)])
        mesh.face([level(outer[0],top-1.8),level(outer[1],top-1.8),
                   level(outer[1],top),level(outer[0],top)],21,(222,217,208))
        mesh.face([level(outer[0],top),level(outer[1],top),
                   level(inner[1],top+.08),level(inner[0],top+.08)],22,(184,173,154))
    scene = trimesh.Scene()
    scene.add_geometry(mesh.build(),geom_name='Boat Quay riverside shophouses')
    digest,bounds = write_tree_asset(scene,copyright=CREDIT)
    return dict(entityId='bay.boat-quay-shophouses',layer='ext',kind='structure',
                label='驳船码头 · 临河店屋与骑楼',regionId='marina-bay-exterior',assetHash=digest,
                bounds=bounds,material={'shading':'albedo'},props={'background':True,
                '依据':'© OpenStreetMap contributors · ODbL, OneMap 正射影像，河岸现场照片',
                '重建范围':'45 至 85 号内有测绘记录的 40 栋。门窗样式、屋脊、雨棚与分户立面配色按同街实拍近似。',
                '材质版权':CREDIT})


if __name__ == '__main__':
    row = bake()
    path = ROOT/'build/streetscape.json'
    rows = {e['entityId']:e for e in json.loads(path.read_text())}
    rows[row['entityId']] = row
    path.write_text(json.dumps(list(rows.values()),ensure_ascii=False,indent=2)+'\n')
    print(row['assetHash'])
