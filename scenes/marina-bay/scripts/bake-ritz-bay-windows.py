"""Register the bay-facing Ritz-Carlton glazing to the original OneMap facade UVs."""

import argparse
import hashlib
import io
import struct
import json
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image
from scipy.signal import find_peaks
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals

ROOT = Path(__file__).resolve().parents[1]
SOURCE = "38ce4cbd7a086641de0014c1c22054e470b6d8489f786c3c36e4ffcae637f8cd"
TOWER = "bay.d23a14f1-ee9f-4731-9bb5-080032ef42b4"
PHOTO = "https://commons.wikimedia.org/wiki/File:The_Ritz-Carlton_Millenia_Singapore_-_20050505.jpg"
# Pixel rows in the 2048 px survey atlas. Its horizontal dimension runs down
# the tower. Short paired openings and projecting square bays are kept distinct.
BANDS = [
    (617,633,"octagon"),(644,675,"long"),(686,716,"long"),(727,743,"octagon"),
    (746,762,"octagon"),(772,803,"long"),(813,843,"long"),(854,869,"octagon"),
    (897,913,"square"),(942,958,"octagon"),(969,1000,"long"),(1009,1040,"long"),
    (1051,1066,"octagon"),(1096,1111,"square"),(1142,1157,"octagon"),(1168,1198,"long"),
    (1208,1239,"long"),(1249,1265,"octagon"),(1268,1284,"octagon"),(1295,1326,"long"),
    (1334,1365,"long"),(1376,1392,"octagon"),
]


def place_openings(mesh):
    image = np.asarray(mesh.visual.material.baseColorTexture.convert("RGB"), float)
    luminance = image @ [.2126,.7152,.0722]
    texture = mesh.visual.uv*[2048,-2048] + [-.5,2047.5]
    faces = mesh.faces[mesh.face_normals[:,2] < -.95]
    triangles = mesh.vertices[faces]
    uv = texture[faces]
    matrices = (uv[:,1:]-uv[:,:1]).transpose(0,2,1)
    valid = np.abs(np.linalg.det(matrices)) > 1e-3
    matrices,uv,triangles = matrices[valid],uv[valid],triangles[valid]
    inverse = np.linalg.inv(matrices)
    panes, pane_faces, ledges, ledge_faces = [],[],[],[]
    pane_sizes = []
    counts = {}
    for first,last,kind in BANDS:
        y = .5*(first+last)
        profile = luminance[first+3:last-2].mean(axis=0)
        peaks, _ = find_peaks(-profile[44:507], distance=13, prominence=17)
        for peak in peaks+44:
            # The darkest part is the head reveal. The fitted opening is
            # centred below it in the elevation (rightward in the UV atlas).
            point = np.array([peak+1.45,y])
            coords = np.einsum("nij,nj->ni",inverse,point-uv[:,0])
            indices = np.flatnonzero((coords.min(axis=1)>=-.001)&(coords.sum(axis=1)<=1.001))
            if not len(indices):
                continue
            i = indices[0]
            world = triangles[i]
            center = (np.r_[1-coords[i].sum(),coords[i]] @ world)
            derivative = (world[1:]-world[0]).T @ inverse[i]
            up = -derivative[:,0]/np.linalg.norm(derivative[:,0])
            side = derivative[:,1]/np.linalg.norm(derivative[:,1])
            normal = np.cross(side,up)
            if normal[2]>0:
                side = -side
                normal = -normal
            height = 1.82 if kind=="long" else 1.68
            width = np.linalg.norm(derivative[:,1])*(last-first+1)*.95
            if kind=="octagon" and peak>56:
                cut=.43
                outline=np.array([[-1,-cut],[-cut,-1],[cut,-1],[1,-cut],[1,cut],[cut,1],[-cut,1],[-1,cut]])
            else:
                outline=np.array([[-1,-1],[1,-1],[1,1],[-1,1]])
            # Slightly proud of the survey plate. The upper lip casts a narrow
            # shadow onto the glazing, as in the daylight reference.
            outline3 = center+.029*normal+outline[:,:1]*side*width/2+outline[:,1:]*up*height/2
            offset=len(panes)
            panes.extend(outline3)
            pane_sizes.append(len(outline3))
            pane_faces.extend((offset,offset+k,offset+k+1) for k in range(1,len(outline)-1))
            top=center+up*(height*.5)+normal*.015
            # The photograph shows a pitched sheet and triangular cheeks, with
            # deeper hoods on the octagonal bays and narrower overhangs on the long lights.
            lip=.44 if len(outline)==8 else .34
            raise_at_wall=.20 if len(outline)==8 else .15
            half=width*(.51 if len(outline)==8 else .53)
            offset=len(ledges)
            ledges.extend([top-side*half+up*raise_at_wall,top+side*half+up*raise_at_wall,
                           top+side*half+normal*lip,top-side*half+normal*lip,
                           top+side*half-up*.055,top-side*half-up*.055])
            ledge_faces.extend(tuple(offset+j for j in tri) for tri in
                               [(0,3,2),(0,2,1),(3,5,4),(3,4,2),(0,5,3),(1,2,4)])
            shape="octagon" if len(outline)==8 else ("long" if kind=="long" else "square")
            counts[shape]=counts.get(shape,0)+1
    return (panes,pane_faces),(ledges,ledge_faces),counts,pane_sizes


def waterfront_glazing(data, pane_sizes):
    """Add the measured waterfront reflection and the shade under each window head."""
    json_size = int.from_bytes(data[12:16], "little")
    doc = json.loads(data[20:20 + json_size])
    original = data[28 + json_size:]
    views = doc["bufferViews"]
    binary = bytearray(original)

    def append_view(payload, **properties):
        binary.extend(bytes(-len(binary) % 4))
        views.append({"buffer": 0, **properties, "byteOffset": len(binary), "byteLength": len(payload)})
        binary.extend(payload)
        return len(views) - 1

    doc["images"] = []
    doc["textures"] = []

    def png_texture(name, payload):
        view = append_view(payload)
        doc["images"].append({"bufferView": view, "mimeType": "image/png", "name": name})
        doc["textures"].append({"source": len(doc["images"]) - 1})
        return len(doc["textures"]) - 1

    panes = doc["meshes"][0]["primitives"][0]
    position = doc["accessors"][panes["attributes"]["POSITION"]]
    view = views[position["bufferView"]]
    vertices = np.frombuffer(original, dtype="<f4", count=3 * position["count"],
                             offset=view.get("byteOffset", 0) + position.get("byteOffset", 0)).reshape(-1, 3)
    uv = np.empty((len(vertices), 2), dtype="<f4")
    offset = 0
    for size in pane_sizes:
        end = offset + size
        pane = vertices[offset:end]
        along = pane @ np.array([.9965, 0, .0836])
        uv[offset:end, 0] = (along - along.min()) / np.ptp(along)
        uv[offset:end, 1] = (pane[:, 1].max() - pane[:, 1]) / np.ptp(pane[:, 1])
        offset = end
    if offset != len(vertices):
        raise ValueError("Window outlines disagree with the exported vertex order")
    uv_view = append_view(uv.tobytes(), target=34962)
    panes["attributes"]["TEXCOORD_0"] = len(doc["accessors"])
    doc["accessors"].append({"bufferView": uv_view, "componentType": 5126, "count": len(uv), "type": "VEC2"})

    capture = ROOT / "references/ritz-millenia-window-radiance.png"
    reflection = png_texture("Millenia waterfront at three window heights", capture.read_bytes())
    y, x = np.mgrid[:64, :96]
    s, t = (x + .5) / 96, (y + .5) / 64
    visibility = 1 - .405 * np.exp(-t / .20) - .065 * (np.exp(-s / .085) + np.exp(-(1 - s) / .085))
    stream = io.BytesIO()
    Image.fromarray(np.rint(255 * visibility).astype("uint8")).convert("RGB").save(stream, "PNG", optimize=True)
    occlusion = png_texture("Window head and jamb sky visibility", stream.getvalue())

    material = doc["materials"][panes["material"]]
    material["extras"] = {
        "surfaceRole": "facade",
        "reflectionLevels": {"first": 21.007188415527345, "last": 73.98183746337891, "count": 3, "scale": 13},
    }
    material.update(emissiveTexture={"index": reflection}, emissiveFactor=[0, 0, 0], occlusionTexture={"index": occlusion})
    material["pbrMetallicRoughness"].update(metallicFactor=.02, roughnessFactor=.27)
    binary.extend(bytes(-len(binary) % 4))
    doc["buffers"][0]["byteLength"] = len(binary)
    encoded = json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode()
    encoded += b" " * (-len(encoded) % 4)
    header = struct.pack("<4sIII4s", b"glTF", 2, len(encoded) + len(binary) + 28, len(encoded), b"JSON")
    return header + encoded + struct.pack("<I4s", len(binary), b"BIN\0") + binary


def bake(path):
    if hashlib.sha256(path.read_bytes()).hexdigest()!=SOURCE:
        raise ValueError("Expected the original registered Millenia hotel glTF")
    source=trimesh.load_scene(path,process=False).geometry["24_0.glb"]
    panes,ledges,counts,pane_sizes=place_openings(source)
    record=next(e for e in json.loads((ROOT/"build/onemap-entities.json").read_text()) if e["entityId"]==TOWER)
    anchor=np.array([record["bounds"]["min"],record["bounds"]["max"]]).mean(axis=0)
    anchor[1]=record["bounds"]["min"][1]
    scene=trimesh.Scene()
    for (vertices,faces), mat in [
        (panes,PBRMaterial(name="Millenia bay glazing",baseColorFactor=[3,4,5,255],metallicFactor=.045,roughnessFactor=.25)),
        (ledges,PBRMaterial(name="Millenia window head",baseColorFactor=[107,110,111,255],metallicFactor=.18,roughnessFactor=.48,doubleSided=True)),
    ]:
        mesh=trimesh.Trimesh(vertices=np.asarray(vertices)+anchor,faces=faces,visual=TextureVisuals(material=mat),process=False)
        scene.add_geometry(mesh,geom_name=mat.name)
    low,high=scene.bounds
    origin=(low+high)/2
    origin[1]=low[1]
    for mesh in scene.geometry.values():
        mesh.apply_translation(-origin)
    def metadata(doc):
        panel=next(m for m in doc["materials"] if m["name"]=="Millenia bay glazing")
        panel["extras"]={"surfaceRole":"facade","reflectSky":True}
    data=trimesh.exchange.gltf.export_glb(scene,include_normals=True,tree_postprocessor=metadata)
    data = waterfront_glazing(data, pane_sizes)
    digest=hashlib.sha256(data).hexdigest()
    (ROOT/"assets"/(digest+".glb")).write_bytes(data)
    print(counts)
    return dict(entityId="bay.ritz-millenia-bay-windows",kind="structure",layer="ext",regionId=record["regionId"],
                label="丽思卡尔顿美年酒店 · 临湾窗带",assetHash=digest,
                bounds={"min":low.tolist(),"max":high.tolist()},material={"shading":"albedo"},
                props={"background":True,"立面调查":"Map Data © Singapore Land Authority / OneMap · "+TOWER,
                       "实景参考":PHOTO,"重建":"从官方立面纹理提取窗列并投回原三角面，按实景区分横向长窗、八角窗及方形开口。玻璃色、窗高与遮阳沿突出量为估值。",
                       "材质校准来源":"db04dea9253a476a0a29f179104ac5bc25b8f3d9e04e7be43c4c9ef08eca352b",
                       "日间材质":"临湾暗玻璃与遮阳沿按跨湾照片校准窗墙明暗差。",
                       "临湾日间材质":"按已配准的客房外窗开口估计窗头与侧边的天空遮蔽。窗内反射在酒店前方三个高度的现场渲染环境之间插值。",
                       "已测窗数":len(pane_sizes)})


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source",type=Path,help="Original OneMap tower GLB")
    entry=bake(parser.parse_args().source)
    path=ROOT/"build/streetscape.json"
    records={e["entityId"]:e for e in json.loads(path.read_text())}
    records[entry["entityId"]]=entry
    path.write_text(json.dumps(list(records.values()),indent=2,ensure_ascii=False)+"\n")
    print(entry["assetHash"])
