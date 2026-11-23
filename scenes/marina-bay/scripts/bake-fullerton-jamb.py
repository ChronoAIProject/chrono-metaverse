"""Reconstruct the three columns of glazing immediately south of the One Fullerton arcade."""

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals

ROOT = Path(__file__).resolve().parents[1]
PHOTO = "https://commons.wikimedia.org/wiki/File:Singapore_-_panoramio_(109).jpg"
# Rectified image columns and rows (top to bottom) that pass through the mullion centres.
COLS = np.array([0, 33, 89, 143])/143
ROWS = np.array([0, 43, 85, 125, 165, 205, 245, 287])/287
SOUTH = (16.936, 92.76)
NORTH = (16.268, 96.0)
SILL, HEAD = -.245, 8.15


def pane_transmission(photo):
    if hashlib.sha256(photo.read_bytes()).hexdigest() != "ced953eafbdd1fac45e48c520a21242cd69c81c7cc6b6dcdc0aed08ca6f4416a":
        raise ValueError("Expected the original 4288 by 2848 waterfront elevation")
    width, height = 144, 288
    corners = [(3235,1671),(3344,1677),(3343,1906),(3234,1904)]
    system, rhs = [], []
    for (u,v), (x,y) in zip([(0,0),(width,0),(width,height),(0,height)], corners):
        system.extend([[u,v,1,0,0,0,-x*u,-x*v], [0,0,0,u,v,1,-y*u,-y*v]])
        rhs.extend([x,y])
    image = Image.open(photo).convert("RGB").transform((width,height), Image.Transform.PERSPECTIVE,
                                                       np.linalg.solve(system, rhs), Image.Resampling.BICUBIC)
    # Keep low-frequency transmitted colour. Omit the mullions and foreground
    # pedestrians at the foot; the reflected courtyard has its own three probes.
    texture = Image.new("RGB",(width,height))
    for j,(v,w) in enumerate(zip(ROWS,ROWS[1:])):
        for u,t in zip(COLS,COLS[1:]):
            x0,x1 = round(u*width), round(t*width)
            y0,y1 = round(v*height), round(w*height)
            bottom = y0+(y1-y0)//2 if j==len(ROWS)-2 else y1-4
            patch = image.crop((x0+4,y0+4,x1-4,bottom)).resize((4,5),Image.Resampling.BOX)
            texture.paste(patch.resize((x1-x0,y1-y0),Image.Resampling.BICUBIC),(x0,y0))
    texture.format = "JPEG"
    return texture


def bake(photo):
    quay = json.loads((ROOT/"context.json").read_text())["quay"]
    start = np.array(quay["start"])
    along = np.array(quay["end"]) - start
    along[1] = 0
    along /= np.linalg.norm(along)
    inland = np.cross([0,1,0],along)
    def point(x,s):
        return start + x*inland + s*along
    foot = point(*SOUTH)
    tangent = point(*NORTH) - foot
    span = np.linalg.norm(tangent)
    tangent /= span
    landward = np.cross([0,1,0],tangent)
    orientation = np.eye(4)
    orientation[:3,:3] = np.column_stack([landward,[0,1,0],tangent])
    orientation[:3,3] = foot
    scene = trimesh.Scene()

    def add(mesh, name, material, uv=None):
        mesh.visual = TextureVisuals(uv=uv,material=material)
        mesh.apply_transform(orientation)
        scene.add_geometry(mesh,geom_name=name)

    height = HEAD-SILL
    frames = []
    def bar(depth,h,length,x,y,s):
        mesh = trimesh.creation.box([depth,h,length])
        mesh.apply_translation([x,y,s])
        frames.append(mesh)

    for u in COLS:
        bar(.153,height,.078,-.076,(SILL+HEAD)/2,np.clip(u*span,.039,span-.039))
    for i,v in enumerate(ROWS):
        width = .11 if i in (0,3,5,7) else .067
        y = np.clip(HEAD-v*height,SILL+width/2,HEAD-width/2)
        for a,b in zip(COLS,COLS[1:]):
            low=max(.078,a*span+.039);high=min(span-.078,b*span-.039)
            bar(.164,width,high-low,-.074,y,(low+high)/2)
    add(trimesh.util.concatenate(frames),"Mullions",
        PBRMaterial(name="Arcade mullion caps",baseColorFactor=[174,179,181,255],roughnessFactor=.46,metallicFactor=.22))
    def plane(offset):
        return trimesh.Trimesh(vertices=[[-offset,SILL,0],[-offset,SILL,span],
                                         [-offset,HEAD,span],[-offset,HEAD,0]],
                               faces=[[0,1,2],[0,2,3]],process=False)
    uv = np.array([[0,0],[1,0],[1,1],[0,1]],float)
    add(plane(.054),"Interior colour",PBRMaterial(name="Arcade window interior",
        baseColorTexture=pane_transmission(photo),roughnessFactor=.86,metallicFactor=0),uv)
    reflection = Image.open(ROOT/"references/fullerton-entrance-jamb-reflection.jpg")
    glass = PBRMaterial(name="Arcade south glazing",baseColorFactor=[76,101,124,37],roughnessFactor=.18,
                        metallicFactor=.06,emissiveTexture=reflection,emissiveFactor=[0,0,0],alphaMode="BLEND")
    add(plane(.114),glass.name,glass,uv)
    low,high = scene.bounds
    center = (low+high)/2
    center[1] = low[1]
    for mesh in scene.geometry.values():
        mesh.apply_translation(-center)

    def reflection_layout(doc):
        mat = next(m for m in doc["materials"] if m["name"]==glass.name)
        mat["extras"] = {"surfaceRole":"facade","reflectSky":True,
                         "facadeProbes":{"span":span,"height":height,"eyeHeight":2.3-SILL,
                                         "first":.48,"spacing":1.16,"count":3,"depth":12.5}}
    data = trimesh.exchange.gltf.export_glb(scene,include_normals=True,tree_postprocessor=reflection_layout)
    digest = hashlib.sha256(data).hexdigest()
    (ROOT/"assets"/(digest+".glb")).write_bytes(data)
    return dict(entityId="bay.fullerton-arcade-south-glazing",kind="structure",layer="ext",
                regionId="marina-bay-exterior",label="One Fullerton · 门廊南侧玻璃窗格",assetHash=digest,
                bounds={"min":low.tolist(),"max":high.tolist()},material={"shading":"albedo"},
                props={"background":True,"实景照片":PHOTO,
                       "窗格":"依据 OneMap 测绘面和 2014 年照片重建三列七行窗格。窗框深度、涂层、透射色与玻璃内退为估计值。",
                       "局部倒影":"沿玻璃面外侧三个位置采样滨水广场半球，近景反光随观察方向变化。倒影深度取代表性广场距离。",
                       "窗后色彩署名":"Андрей Бобровский · Singapore - panoramio (109) · CC BY 3.0 · 透视校正、分格裁切和降采样 · https://creativecommons.org/licenses/by/3.0/"})


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("photo",type=Path,help="Original Commons elevation, Singapore - panoramio (109)")
    entry=bake(parser.parse_args().photo)
    path=ROOT/"build/streetscape.json"
    records={e["entityId"]:e for e in json.loads(path.read_text())}
    records[entry["entityId"]]=entry
    path.write_text(json.dumps(list(records.values()),indent=2,ensure_ascii=False)+"\n")
    print(entry["assetHash"])
