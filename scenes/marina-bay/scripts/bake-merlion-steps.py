"""Rebuild the stone seating steps along the photographed Merlion Park shore."""

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image

from coastal_finishes import dress_risers
from shapely import constrained_delaunay_triangles
from shapely.geometry import MultiPoint, Point, Polygon
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals

ROOT = Path(__file__).resolve().parents[1]
SOURCE = "786a17032f2b9a9e68e3ddbd6656e48733cd29e4b35385c1e9efd831760f4de7"
PHOTO = "https://commons.wikimedia.org/wiki/File:Merlion_Singapore_2018.tif"
# Survey coordinates of the centre of OSM way 182819157. X points towards
# the bay, Y follows the straight shore to the north. Distances are metres.
CENTER = np.array([285.32, 661.69])
BEARING = np.deg2rad(25 + 5.8)
BASIS = np.array([[-np.cos(BEARING), np.sin(BEARING)], [np.sin(BEARING), np.cos(BEARING)]])
SHORE = np.array([[11.90, -21.10], [3.70, -12.65], [3.60, 18.70], [15.35, 21.60]])
BASE_Y = -60.042648


def offset(edge, depth):
    along = np.diff(edge, axis=0)
    along /= np.linalg.norm(along, axis=1)[:, None]
    inward = np.column_stack([-along[:, 1], along[:, 0]])
    miter = inward[:-1] + inward[1:]
    miter /= np.sum(miter * inward[:-1], axis=1)[:, None]
    return edge + depth * np.vstack([inward[0], miter, inward[-1]])


def to_world(plan, height):
    x, z = np.asarray(plan) @ BASIS + CENTER
    return [x, BASE_Y + height, z]


def granite():
    files = json.loads((ROOT/'context.json').read_text())["quay"]["granite"]
    image = Image.open(ROOT/'assets'/(files["color"]+'.webp')).convert("RGB")
    image.thumbnail((512, 512), Image.Resampling.LANCZOS)
    image.format = "JPEG"
    normals = Image.open(ROOT/'assets'/(files["normal"]+'.webp')).convert("RGB")
    normals.thumbnail((512, 512), Image.Resampling.LANCZOS)
    normals.format = "JPEG"
    return PBRMaterial(name="Merlion Park granite", baseColorTexture=image,
                       normalTexture=normals, metallicFactor=0, roughnessFactor=.78)


class Stonework:
    def __init__(self):
        self.vertices, self.uv, self.tint, self.faces = [], [], [], []

    def face(self, plan, heights, uv, tint, direction):
        vertices = np.array([to_world(p, h) for p, h in zip(plan, heights)])
        start = len(self.vertices)
        self.vertices.extend(vertices)
        self.uv.extend(uv)
        self.tint.extend(tint)
        for j in range(1, len(plan)-1):
            tri = [0, j, j+1]
            normal = np.cross(vertices[j]-vertices[0], vertices[j+1]-vertices[0])
            if np.dot(normal, direction) < 0:
                tri.reverse()
            self.faces.append(np.asarray(tri)+start)

    def mesh(self, material):
        model = trimesh.Trimesh(vertices=self.vertices, faces=self.faces,
                                visual=TextureVisuals(uv=self.uv, material=material), process=False)
        colors = np.uint8(np.clip(self.tint, 0, 255))
        model.visual.vertex_attributes["color"] = np.column_stack([colors, np.full(len(colors), 255, np.uint8)])
        return model


def polygons(geometry):
    if geometry.geom_type == "Polygon":
        return [geometry] if not geometry.is_empty else []
    return [p for p in geometry.geoms if p.geom_type == "Polygon" and not p.is_empty]


def flight(source):
    scene = trimesh.load_scene(source, process=False)
    shell = next(m for m in scene.geometry.values() if m.visual.kind == "texture")
    ground = shell.vertices[shell.vertices[:, 1] < .01][:, [0, 2]]
    survey_center = np.array([285.336484, 661.532012])
    base = MultiPoint((ground + survey_center - CENTER) @ BASIS.T).convex_hull.buffer(-.014)
    stone = Stonework()
    rng = np.random.default_rng(182819157)
    levels = 7
    tread = .92
    rise = .343
    # Twelve browser ray samples put the vector water 1.1–1.5 m outside
    # the south and central image edges. Fit the lower nosings to that bank;
    # the upper landing, the north pier and the surveyed plinth retain their anchors.
    toe = SHORE + np.array([[1.12, 1.08], [1.32, .48], [1.14, .28], [0, 0]])
    def step_edge(level):
        return offset(SHORE, level*tread) + (toe-SHORE) * max(0, 1-level/4)
    for level in range(levels):
        front, rear = step_edge(level), step_edge(level+1)
        top = .28 + level*rise
        bottom = top-rise
        for segment in range(len(front)-1):
            along = front[segment+1]-front[segment]
            axis = along/np.linalg.norm(along)
            outward = np.array([axis[1], -axis[0]]) @ BASIS
            direction = [outward[0], 0, outward[1]]
            spans = max(1, round(np.linalg.norm(along)/1.18))
            for j in range(spans):
                a, b = (j+0.003)/spans, (j+1-.003)/spans
                f0, f1 = front[segment]+a*along, front[segment]+b*along
                step = rear[segment+1]-rear[segment]
                b0, b1 = rear[segment]+a*step, rear[segment]+b*step
                tile = Polygon([f0, f1, b1, b0]).difference(base)
                tone = rng.uniform(.94,1.02)*np.array([206,202,193])
                if level==0:
                    tone *= [.65,.71,.60]
                for poly in polygons(tile):
                    for tri in constrained_delaunay_triangles(poly).geoms:
                        plan = np.array(tri.exterior.coords[:3])
                        stone.face(plan, [top]*3, plan/.72, [tone]*3, [0,1,0])
                    # Only the front lip and end returns face the water. The
                    # 7 mm expansion joints expose the shadowed stone below.
                    ring = np.array(poly.exterior.coords)
                    for p0,p1 in zip(ring[:-1],ring[1:]):
                        mid=(p0+p1)/2
                        if abs(np.dot(mid-(f0+f1)/2, [axis[1],-axis[0]]))>.018:
                            continue
                        lip=(b0-f0+b1-f1)*.5
                        lip/=np.linalg.norm(lip)
                        for h0,h1,d0,d1,t0,t1 in [
                            (bottom-.009,top-.042, .012,.012,.62,.76),
                            (top-.042,top-.025, .012,-.009,.74,.79),
                            (top-.025,top,-.009,0,.95,1.02)]:
                            plan=np.array([p0+lip*d0,p1+lip*d0,p1+lip*d1,p0+lip*d1])
                            uv=np.column_stack([plan@axis/.72,np.array([h0,h0,h1,h1])/.72])
                            stone.face(plan,[h0,h0,h1,h1],uv,[tone*t0,tone*t0,tone*t1,tone*t1],direction)
                # Close the visible return at each end of the whole flight.
                for at_end, p0, p1, normal in [
                    (segment==0 and j==0, f0,b0,-axis), (segment==len(front)-2 and j==spans-1,f1,b1,axis)]:
                    if at_end:
                        wx,wz=normal@BASIS
                        q=np.array([p0,p1,p1,p0])
                        stone.face(q,[-.08,-.08,top,top],q/.72,[tone*.72]*4,[wx,0,wz])
    # Granite marker posts follow the darker row of dots on the orthophoto.
    posts=[]
    line=(step_edge(3)+step_edge(4))/2
    for a,b in zip(line[:-1],line[1:]):
        length=np.linalg.norm(b-a)
        for t in np.arange(1.1,length-.5,2.35)/length:
            point=a+(b-a)*t
            if base.distance(Point(point)) < .32:
                continue
            y=.28+3*rise
            tr=trimesh.creation.cylinder(radius=.14,height=.40,sections=14)
            tr.apply_transform(trimesh.transformations.rotation_matrix(-np.pi/2,[1,0,0]))
            tr.apply_translation(to_world(point,y+.20))
            posts.append(tr)
    if posts:
        m=trimesh.util.concatenate(posts)
        start=len(stone.vertices);stone.vertices.extend(m.vertices);stone.faces.extend(m.faces+start)
        stone.uv.extend(m.vertices[:,[0,1]]/.52);stone.tint.extend([[186,184,175]]*len(m.vertices))
    return stone.mesh(granite()), base


def apron(reference, base):
    # Register the landward apron to the same OneMap image that lies below
    # it. Bring the edge back to the existing terrain at the park approaches.
    img=Image.open(reference).convert("RGB")
    if img.size!=(468,780):
        raise ValueError("Expected rectified OneMap patch at 10 px/m, X -24..22.8, Y 40..-38")
    img.format="JPEG"
    mat=PBRMaterial(name="Merlion Park landing",baseColorTexture=img,metallicFactor=0,roughnessFactor=.89)
    builder=Stonework()
    front=offset(SHORE,7*.92)
    back=np.array([[4.4,-28.5],[-13.8,-15.2],[-13.8,22.3],[11.5,29.0]])
    middle=front*.75+back*.25
    for left,right,h0,h1 in [(front,middle,.28+6*.343,.28+6*.343),(middle,back,.28+6*.343,-.26)]:
        for j in range(3):
            for tri in [[left[j],left[j+1],right[j+1]],[left[j],right[j+1],right[j]]]:
                polygon=Polygon(tri)
                basis=np.column_stack((np.array(tri),[1,1,1]))
                heights=[h0,h0,h1] if np.array_equal(tri[1],left[j+1]) else [h0,h1,h1]
                plane=np.linalg.solve(basis,heights)
                for poly in polygons(polygon.difference(base)):
                    for face in constrained_delaunay_triangles(poly).geoms:
                        plan=np.array(face.exterior.coords[:3])
                        uv=(plan+[24,38])/[46.8,78]
                        builder.face(plan,plan@plane[:2]+plane[2],uv,[[253]*3]*3,[0,1,0])
    return builder.mesh(mat)


def bake(source, reference):
    if hashlib.sha256(source.read_bytes()).hexdigest()!=SOURCE:raise ValueError("Expected OneMap's Merlion survey")
    stairs,cutout=flight(source)
    parts=[stairs,apron(reference,cutout)]
    scene=trimesh.Scene()
    for m in parts:scene.add_geometry(m,geom_name=m.visual.material.name)
    lo,hi=scene.bounds;center=(lo+hi)/2;center[1]=lo[1]
    for m in scene.geometry.values():m.apply_translation(-center)
    def normal_strength(doc):
        for mat in doc["materials"]:
            if "normalTexture" in mat:mat["normalTexture"]["scale"]=.34
    data=trimesh.exchange.gltf.export_glb(scene,include_normals=True,tree_postprocessor=normal_strength)
    data=dress_risers(data)
    digest=hashlib.sha256(data).hexdigest();(ROOT/'assets'/(digest+'.glb')).write_bytes(data)
    path=ROOT/'build/streetscape.json'
    items={e['entityId']:e for e in json.loads(path.read_text())};key="bay.merlion-park-steps"
    survey = json.loads((ROOT/"build/onemap-entities.json").read_text())
    region = next(e["regionId"] for e in survey if e["entityId"] == "bay.a900c832-9448-4b5c-a1ef-a8828bfe76a9")
    items[key]=dict(entityId=key,kind="structure",layer="ext",regionId=region,
                    assetHash=digest,label="鱼尾狮公园 · 滨水石阶",material={"shading":"albedo"},bounds={"min":lo.tolist(),"max":hi.tolist()},
                    props={"background":True,"surfaceRole":"landscape","现场参考":PHOTO,
                           "影像":"Map Data © Singapore Land Authority / OneMap OrthoJPG","石材":"Granite Tile 04 · Poly Haven · CC0",
                           "说明":"沿正射影像三段折线铺设七级石阶，扣除实测雕像基座。低处踏面衔接矢量水岸约 1.1–1.5 米的配准差。踏步尺寸、石柱间距和陆侧过渡坡度按照片估配。"})
    path.write_text(json.dumps(list(items.values()),ensure_ascii=False,indent=2)+'\n')
    print(digest,len(data),sum(len(m.faces) for m in parts))


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("statue",type=Path)
    parser.add_argument("orthophoto", type=Path, nargs="?", default=ROOT/"references/merlion-park-landing.jpg")
    args=parser.parse_args()
    bake(args.statue,args.orthophoto)
