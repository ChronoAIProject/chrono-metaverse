"""Resurface the survey mesh of the Merlion plinth in metric stone courses."""

import argparse
import hashlib
import io
import json
import struct
from pathlib import Path

import numpy as np
from PIL import Image
from shapely.geometry import LinearRing, MultiPoint, Point
from merlion_portrait import portrait

ROOT = Path(__file__).resolve().parents[1]
ID = "bay.a900c832-9448-4b5c-a1ef-a8828bfe76a9"
SOURCE = "786a17032f2b9a9e68e3ddbd6656e48733cd29e4b35385c1e9efd831760f4de7"
PHOTO = "https://commons.wikimedia.org/wiki/File:Merlion_Singapore_2018.tif"


def masonry(perimeter):
    # One repeating 3.46 m section carries three staggered blocks per course.
    # The texture axes stay in metres along both straight and rounded sides.
    height, width = 768, 1024
    y, x = np.indices((height, width), dtype=float)
    u, v = (x+.5)/width, (y+.5)/height
    along, down = u * perimeter / 8, v * 2.714
    materials = json.loads((ROOT/"context.json").read_text())["quay"]["granite"]
    sample = Image.open(ROOT/"assets"/(materials["color"]+".webp")).convert("L")
    grain = np.asarray(sample, dtype=float)
    row = np.minimum(6, np.floor(v*7).astype(int))
    phase = along / (perimeter/24) + (row % 2)*.5
    block = np.floor(phase).astype(int) % 3
    rng = np.random.default_rng(786170)
    offset = rng.integers(0, 512, (7, 3, 2))
    shade = rng.uniform(-8, 8, (7, 3))[row, block]
    ix = np.int32(along*520 + offset[row, block, 0]) % grain.shape[1]
    iy = np.int32(down*520 + offset[row, block, 1]) % grain.shape[0]
    grit = (grain[iy, ix] - np.mean(grain))*.55
    # Narrow recessed joints and the eased upper edges are visible even on
    # the shaded front; no baked sun highlight is painted into the colour.
    dh = np.abs(((v*7+.5)%1)-.5)*2.714/7
    dw = np.abs(((phase+.5)%1)-.5)*perimeter/24
    edge = np.minimum(dh,dw)
    bevel = np.clip(edge/.014,0,1)
    wet = np.clip((v-.70)/.30,0,1)
    diffuse = np.array([91,91,87]) + (grit + shade)[..., None]
    diffuse *= (1-.28*wet)[..., None]
    mortar = np.array([113,111,102])*(1-.24*wet)[...,None]
    mix = np.clip((edge-.003)/.004,0,1)[...,None]
    diffuse = mortar*(1-mix)+diffuse*mix
    relief = -.004*(1-bevel)**2 + .00034*np.clip(grit/12,-1.6,1.6)
    dx = (np.roll(relief,-1,axis=1)-np.roll(relief,1,axis=1))/(2*perimeter/8/width)
    dy = np.gradient(relief,axis=0)/(2.714/height)
    normal = np.stack([-dx,dy,np.ones_like(dx)],axis=-1)
    normal /= np.linalg.norm(normal,axis=2)[...,None]
    rough = .79-.35*wet+.05*np.clip(grit/15,-1,1)
    orm = np.stack([(.83+.17*bevel),rough,np.zeros_like(rough)],axis=-1)
    return [Image.fromarray(np.uint8(np.clip(c,0,255)))
            for c in [diffuse, (normal*.5+.5)*255, orm*255]]


def bake(file):
    raw = file.read_bytes()
    if hashlib.sha256(raw).hexdigest() != SOURCE:
        raise ValueError("Expected the original SLA survey of the Merlion")
    size = struct.unpack_from("<I",raw,12)[0]
    doc = json.loads(raw[20:20+size])
    binary = bytearray(raw[28+size:])
    mesh = next(m for m in doc["meshes"] if "TEXCOORD_0" in m["primitives"][0]["attributes"])
    upper, = mesh["primitives"]

    def read(index):
        acc = doc["accessors"][index]
        view = doc["bufferViews"][acc["bufferView"]]
        dtype = {5126:"<f4",5125:"<u4",5123:"<u2"}[acc["componentType"]]
        channels = {"VEC3":3,"VEC2":2,"SCALAR":1}[acc["type"]]
        return np.frombuffer(binary, dtype, count=acc["count"]*channels,
                             offset=view.get("byteOffset",0)+acc.get("byteOffset",0)).reshape(-1,channels).copy()

    def append_view(data):
        binary.extend(b"\0"*(-len(binary)%4))
        doc["bufferViews"].append({"buffer":0,"byteOffset":len(binary),"byteLength":len(data)})
        binary.extend(data)
        return len(doc["bufferViews"])-1

    def accessor(array,kind,component):
        view = append_view(array.tobytes())
        doc["accessors"].append({"bufferView":view,"count":len(array),"componentType":component,"type":kind,
                                 "min":array.min(axis=0).tolist(),"max":array.max(axis=0).tolist()})
        return len(doc["accessors"])-1

    vertices = read(upper["attributes"]["POSITION"])
    faces = read(upper["indices"]).reshape(-1,3)
    select = vertices[faces,1].max(axis=1)<2.72
    if select.sum()!=120:
        raise ValueError("Missing surveyed podium triangles")
    sculpture, stone_pos, stone_norm, stone_uv, atlas = portrait(
        ROOT/"references/merlion-sculpture-2018.jpg", vertices, faces, read(upper["attributes"]["NORMAL"]))
    # Keep the original UVs and index order for the mosaic under the statue.
    upper["indices"] = accessor(faces[~(select|sculpture)].reshape(-1,1).astype("<u4"),"SCALAR",5125)
    base = vertices[faces[select]]
    ring = LinearRing(MultiPoint(vertices[vertices[:,1]<.01][:,[0,2]]).convex_hull.exterior.coords)
    perimeter = ring.length
    tex = []
    for image in masonry(perimeter):
        encoded = io.BytesIO()
        image.save(encoded,format="JPEG",quality=86,subsampling=0)
        doc["images"].append({"bufferView":append_view(encoded.getvalue()),"mimeType":"image/jpeg"})
        doc["textures"].append({"source":len(doc["images"])-1})
        tex.append(len(doc["textures"])-1)
    mat = len(doc["materials"])
    doc["materials"].append({"name":"Merlion plinth granite","pbrMetallicRoughness":{
        "baseColorTexture":{"index":tex[0]},"metallicRoughnessTexture":{"index":tex[2]},"metallicFactor":0},
        "normalTexture":{"index":tex[1],"scale":.75},"occlusionTexture":{"index":tex[2]}})
    pos, norms, uv, seen = [], [], [], set()
    for tri in base:
        # Several SLA faces repeat with the same winding. Share the surface
        # once when all three surveyed positions are exactly the same.
        key = tuple(sorted(tuple(row) for row in tri))
        if key in seen:
            continue
        seen.add(key)
        n = np.cross(tri[1]-tri[0],tri[2]-tri[0])
        n /= np.linalg.norm(n)
        if abs(n[1])<.3:
            arc = np.array([ring.project(Point(p[[0,2]]))/perimeter for p in tri])
            if np.ptp(arc)>.5:
                arc[arc<.5]+=1
            st = np.column_stack([arc*8,1-tri[:,1]/2.714])
        else:
            # Capstones run across the rim. Keep their long joints above
            # the top course, with a separate metric projection on the flat cap.
            st = tri[:,[0,2]]/[perimeter/8,2.714]
        pos.extend(tri)
        norms.extend([n]*3)
        uv.extend(st)
    mesh["primitives"].append({"mode":4,"material":mat,"attributes":{
        "POSITION":accessor(np.array(pos,dtype="<f4"),"VEC3",5126),
        "NORMAL":accessor(np.array(norms,dtype="<f4"),"VEC3",5126),
        "TEXCOORD_0":accessor(np.array(uv,dtype="<f4"),"VEC2",5126)}})
    encoded = io.BytesIO()
    atlas.save(encoded,format="JPEG",quality=92,subsampling=0)
    doc["images"].append({"bufferView":append_view(encoded.getvalue()),"mimeType":"image/jpeg"})
    doc["textures"].append({"source":len(doc["images"])-1})
    doc["materials"].append({"name":"Merlion carved stone","pbrMetallicRoughness":{
        "baseColorTexture":{"index":len(doc["textures"])-1},"roughnessFactor":.88,"metallicFactor":0}})
    mesh["primitives"].append({"mode":4,"material":len(doc["materials"])-1,"attributes":{
        "POSITION":accessor(stone_pos.astype("<f4"),"VEC3",5126),
        "NORMAL":accessor(stone_norm.astype("<f4"),"VEC3",5126),
        "TEXCOORD_0":accessor(stone_uv.astype("<f4"),"VEC2",5126)}})
    binary.extend(b"\0"*(-len(binary)%4))
    doc["buffers"][0]["byteLength"]=len(binary)
    header=json.dumps(doc,separators=(",",":")).encode()
    header+=b" "*(-len(header)%4)
    data=(struct.pack("<4sIII4s",b"glTF",2,28+len(header)+len(binary),len(header),b"JSON")+header+
          struct.pack("<I4s",len(binary),b"BIN\0")+binary)
    digest=hashlib.sha256(data).hexdigest()
    (ROOT/"assets"/(digest+".glb")).write_bytes(data)
    path=ROOT/"build/onemap-entities.json"
    buildings=json.loads(path.read_text())
    statue=next(e for e in buildings if e["entityId"]==ID)
    statue.update(assetHash=digest)
    old_count=sum(doc["accessors"][pr["indices"]]["count"]//3 if "indices" in pr else
                  doc["accessors"][pr["attributes"]["POSITION"]]["count"]//3 for m in doc["meshes"] for pr in m["primitives"])
    statue["props"].update({"三角形数":old_count,"原建筑资源":SOURCE,"基座参考":PHOTO,
        "雕像摄影":PHOTO,"雕像表面":"Adam Wilson · 2018 · CC0。按原模型口部、鬃毛和基座高度配准，可见侧取自照片，对侧按对称性估配。",
        "基座石材":"Granite Tile 04 · Poly Haven · CC0。沿 OneMap 实测基座周长展开石缝，分层、湿润程度和砂浆宽度为照片估值。"})
    path.write_text(json.dumps(buildings,ensure_ascii=False,indent=2)+"\n")
    print(digest,len(data),len(seen),round(perimeter,3))


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source",type=Path)
    bake(parser.parse_args().source)
