//! 资源核对的二进制样本（docs/design/server-slim.md 6.5）：`api/crates/metaverse-core/tests/vectors/check/`。
//!
//! 样本由这里的生成器写出（`METAVERSE_WRITE_CHECK_VECTORS=1 cargo test --test check_vectors`），连同
//! `expected.json`（每个样本按哪个用途检查、应该通过还是被拒、拒绝码、通过时的核对记录）一起提交。
//! 平时运行时先确认目录里的样本与生成器的输出逐字节相同，再用接口服务的检查器（`runner::verify`，
//! 默认上限）跑一遍全部样本，结果必须与 `expected.json` 相同。命令行（TypeScript）在 S5 跑同一批样本。
//!
//! 期望的拒绝码写在生成器里（人定的），通过时的核对记录由检查器算出、写进 `expected.json` 以后人工
//! 复核过（见 README）。

use std::io::Write;
use std::path::PathBuf;

use flate2::write::GzEncoder;
use metaverse_api::runner::verify::{inspect_bytes, within_limits};
use metaverse_core::limits::UploadLimits;
use metaverse_core::model::UploadFormat;
use metaverse_core::scope::UploadPurpose;
use serde_json::{json, Value};

/// 一个样本：文件名、内容、要检查的用途（同一个文件可以按几个用途检查）。
struct Sample {
    file: &'static str,
    bytes: Vec<u8>,
    cases: Vec<(&'static str, Option<&'static str>)>,
}

fn sample(
    file: &'static str,
    bytes: Vec<u8>,
    purpose: &'static str,
    code: Option<&'static str>,
) -> Sample {
    Sample {
        file,
        bytes,
        cases: vec![(purpose, code)],
    }
}

fn directory() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../metaverse-core/tests/vectors/check")
}

// ---------------------------------------------------------------------------
// glb
// ---------------------------------------------------------------------------

/// 把 JSON 和 BIN 拼成 glb（JSON 用空格、BIN 用 0 补齐到 4 字节）。
fn glb(json: &Value, bin: &[u8]) -> Vec<u8> {
    let mut text = serde_json::to_vec(json).unwrap();
    while !text.len().is_multiple_of(4) {
        text.push(b' ');
    }
    let mut data = bin.to_vec();
    while !data.len().is_multiple_of(4) {
        data.push(0);
    }
    let total = 12 + 8 + text.len() + if data.is_empty() { 0 } else { 8 + data.len() };
    let mut out = b"glTF".to_vec();
    out.extend_from_slice(&2u32.to_le_bytes());
    out.extend_from_slice(&(total as u32).to_le_bytes());
    out.extend_from_slice(&(text.len() as u32).to_le_bytes());
    out.extend_from_slice(b"JSON");
    out.extend_from_slice(&text);
    if !data.is_empty() {
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(b"BIN\0");
        out.extend_from_slice(&data);
    }
    out
}

fn floats(values: &[f32]) -> Vec<u8> {
    values.iter().flat_map(|v| v.to_le_bytes()).collect()
}

/// 一个三角形（底面中心在原点、高 1 米）的 glb JSON 骨架；`extra` 合并进顶层。
fn triangle_json(min: [f32; 3], max: [f32; 3], extra: Value) -> Value {
    let mut json = json!({
        "asset": {"version": "2.0"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}}]}],
        "accessors": [{"bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3",
                       "min": min, "max": max}],
        "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": 36}],
        "buffers": [{"byteLength": 36}],
    });
    for (key, value) in extra.as_object().unwrap() {
        json[key] = value.clone();
    }
    json
}

const TRIANGLE: [f32; 9] = [-0.5, 0.0, -0.5, 0.5, 0.0, -0.5, 0.0, 1.0, 0.5];

fn triangle(extra: Value) -> Vec<u8> {
    glb(
        &triangle_json([-0.5, 0.0, -0.5], [0.5, 1.0, 0.5], extra),
        &floats(&TRIANGLE),
    )
}

fn png(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
    bytes.extend_from_slice(&width.to_be_bytes());
    bytes.extend_from_slice(&height.to_be_bytes());
    bytes.extend_from_slice(&[8, 2, 0, 0, 0, 0x90, 0x77, 0x53, 0xde]);
    bytes.extend_from_slice(b"\0\0\0\0IEND\xaeB`\x82");
    bytes
}

/// JPEG：SOI、若干 APP 段（每段最长 65533 字节）、SOF0、SOS、EOI。
fn jpeg(width: u16, height: u16, app_bytes: usize, with_sof: bool) -> Vec<u8> {
    let mut bytes = vec![0xff, 0xd8];
    let mut left = app_bytes;
    let mut marker = 0xe1;
    while left > 0 {
        let body = left.min(65533);
        bytes.extend_from_slice(&[0xff, marker]);
        bytes.extend_from_slice(&((body + 2) as u16).to_be_bytes());
        bytes.extend((0..body).map(|i| (i % 251) as u8));
        left -= body;
        marker = 0xe2;
    }
    bytes.extend_from_slice(&[0xff, 0xdb, 0x00, 0x43, 0x00]);
    bytes.extend(std::iter::repeat_n(1u8, 64));
    if with_sof {
        bytes.extend_from_slice(&[0xff, 0xc0, 0x00, 0x11, 0x08]);
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&[3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
    }
    bytes.extend_from_slice(&[0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 0x3f, 0, 0x12, 0x34]);
    bytes.extend_from_slice(&[0xff, 0xd9]);
    bytes
}

fn webp_vp8x(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = b"RIFF".to_vec();
    bytes.extend_from_slice(&22u32.to_le_bytes());
    bytes.extend_from_slice(b"WEBPVP8X");
    bytes.extend_from_slice(&10u32.to_le_bytes());
    bytes.extend_from_slice(&[0, 0, 0, 0]);
    bytes.extend_from_slice(&(width - 1).to_le_bytes()[..3]);
    bytes.extend_from_slice(&(height - 1).to_le_bytes()[..3]);
    bytes
}

/// 带一张图片的 glb（图片放在 BIN 里三角形数据之后）。
fn textured(image: &[u8], mime: &str, extra: Value) -> Vec<u8> {
    let mut bin = floats(&TRIANGLE);
    let image_offset = bin.len();
    bin.extend_from_slice(image);
    let mut json = triangle_json(
        [-0.5, 0.0, -0.5],
        [0.5, 1.0, 0.5],
        json!({
            "bufferViews": [
                {"buffer": 0, "byteOffset": 0, "byteLength": 36},
                {"buffer": 0, "byteOffset": image_offset, "byteLength": image.len()},
            ],
            "buffers": [{"byteLength": bin.len()}],
            "images": [{"bufferView": 1, "mimeType": mime}],
            "textures": [{"source": 0}],
            "materials": [{"pbrMetallicRoughness": {"baseColorTexture": {"index": 0,
                "extensions": {"KHR_texture_transform": {"scale": [2, 2]}}}}}],
            "extensionsUsed": ["KHR_texture_transform"],
        }),
    );
    json["meshes"][0]["primitives"][0]["material"] = json!(0);
    for (key, value) in extra.as_object().unwrap() {
        json[key] = value.clone();
    }
    glb(&json, &bin)
}

// ---------------------------------------------------------------------------
// zip（存储方式，与 demo_seed/pack.rs 的布局相同）
// ---------------------------------------------------------------------------

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for byte in data {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = if crc & 1 != 0 {
                (crc >> 1) ^ 0xedb8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

struct Member<'a> {
    name: &'a str,
    data: &'a [u8],
    flags: u16,
    /// 本地头里写的名字（为空时与中央目录相同）。
    local_name: Option<&'a str>,
}

fn member<'a>(name: &'a str, data: &'a [u8]) -> Member<'a> {
    Member {
        name,
        data,
        flags: 0,
        local_name: None,
    }
}

fn zip(members: &[Member<'_>], zip64_locator: bool) -> Vec<u8> {
    let mut out = Vec::new();
    let mut central = Vec::new();
    for entry in members {
        let offset = out.len() as u32;
        let crc = crc32(entry.data);
        let size = entry.data.len() as u32;
        let local_name = entry.local_name.unwrap_or(entry.name);
        out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes());
        out.extend_from_slice(&entry.flags.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&[0, 0, 0x21, 0]);
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&size.to_le_bytes());
        out.extend_from_slice(&size.to_le_bytes());
        out.extend_from_slice(&(local_name.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(local_name.as_bytes());
        out.extend_from_slice(entry.data);
        central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes());
        central.extend_from_slice(&entry.flags.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&[0, 0, 0x21, 0]);
        central.extend_from_slice(&crc.to_le_bytes());
        central.extend_from_slice(&size.to_le_bytes());
        central.extend_from_slice(&size.to_le_bytes());
        central.extend_from_slice(&(entry.name.len() as u16).to_le_bytes());
        central.extend_from_slice(&[0; 12]);
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(entry.name.as_bytes());
    }
    let cd_offset = out.len() as u32;
    out.extend_from_slice(&central);
    if zip64_locator {
        // zip64 结束记录定位器（只要出现就拒绝）。
        out.extend_from_slice(&0x0706_4b50u32.to_le_bytes());
        out.extend_from_slice(&[0; 16]);
    }
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&[0; 4]);
    out.extend_from_slice(&(members.len() as u16).to_le_bytes());
    out.extend_from_slice(&(members.len() as u16).to_le_bytes());
    out.extend_from_slice(&(central.len() as u32).to_le_bytes());
    out.extend_from_slice(&cd_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

const DRC: &[u8] = b"DRACO\x02\x02\x01\x01\x00\x00 mesh data";

// ---------------------------------------------------------------------------
// 全部样本
// ---------------------------------------------------------------------------

fn samples() -> Vec<Sample> {
    let mut list = Vec::new();
    // ---- glb：通过 ----
    list.push(sample(
        "glb_model_triangle.glb",
        triangle(json!({})),
        "model",
        None,
    ));
    list.push(sample(
        "glb_model_png_texture.glb",
        textured(&png(64, 32), "image/png", json!({})),
        "model",
        None,
    ));
    // 量化坐标：有符号短整数、归一化，节点缩放 2 倍。
    {
        let raw: [i16; 9] = [-16383, 0, -16383, 16383, 0, -16383, 0, 32767, 16383];
        let bin: Vec<u8> = raw.iter().flat_map(|v| v.to_le_bytes()).collect();
        let json = json!({
            "asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0]}],
            "nodes": [{"mesh": 0, "scale": [2, 1, 2]}],
            "meshes": [{"primitives": [{"attributes": {"POSITION": 0}}]}],
            "accessors": [{"bufferView": 0, "componentType": 5122, "normalized": true, "count": 3,
                           "type": "VEC3", "min": [-16383, 0, -16383], "max": [16383, 32767, 16383]}],
            "bufferViews": [{"buffer": 0, "byteLength": 24, "byteStride": 8}],
            "buffers": [{"byteLength": 24}],
            "extensionsUsed": ["KHR_mesh_quantization"],
            "extensionsRequired": ["KHR_mesh_quantization"],
        });
        // 步长 8：每个元素 6 字节后补 2 个字节。
        let mut strided = Vec::new();
        for element in bin.chunks(6) {
            strided.extend_from_slice(element);
            strided.extend_from_slice(&[0, 0]);
        }
        list.push(sample(
            "glb_quantized.glb",
            glb(&json, &strided),
            "model",
            None,
        ));
    }
    // 绕竖直轴转 45 度的节点：世界包围盒是 8 个角点变换后的外包（比实际偏大）。
    {
        let half = std::f64::consts::FRAC_PI_8;
        let json = triangle_json(
            [-0.5, 0.0, -0.5],
            [0.5, 1.0, 0.5],
            json!({"nodes": [{"mesh": 0, "rotation": [0.0, half.sin(), 0.0, half.cos()]}]}),
        );
        list.push(sample(
            "glb_rotated_node.glb",
            glb(&json, &floats(&TRIANGLE)),
            "model",
            None,
        ));
    }
    // 保持扫描原坐标的网页用模型（5000 米外）：当网页用模型可以，当物件模型超出坐标上限。
    {
        let far: Vec<f32> = TRIANGLE.iter().map(|v| v + 5000.0).collect();
        let json = triangle_json(
            [4999.5, 5000.0, 4999.5],
            [5000.5, 5001.0, 5000.5],
            json!({}),
        );
        list.push(Sample {
            file: "glb_far_coordinates.glb",
            bytes: glb(&json, &floats(&far)),
            cases: vec![("webmodel", None), ("model", Some("over_limit"))],
        });
    }
    // 扫描用途的轻量检查：不限扩展（Draco 压缩），不算三角形和包围盒；当物件模型则拒绝扩展。
    list.push(Sample {
        file: "glb_scan_draco.glb",
        bytes: triangle(json!({
            "extensionsUsed": ["KHR_draco_mesh_compression"],
            "extensionsRequired": ["KHR_draco_mesh_compression"],
        })),
        cases: vec![("scan", None), ("model", Some("glb_extension"))],
    });
    // ---- glb：拒绝 ----
    list.push(sample(
        "glb_external_uri.glb",
        triangle(json!({"buffers": [{"byteLength": 36, "uri": "https://example.com/mesh.bin"}]})),
        "model",
        Some("glb_external_ref"),
    ));
    list.push(sample(
        "glb_data_uri_image.glb",
        triangle(json!({"images": [{"uri": "data:image/png;base64,iVBORw0KGgo="}]})),
        "model",
        Some("glb_external_ref"),
    ));
    list.push(sample(
        "glb_lights.glb",
        triangle(json!({"extensionsUsed": ["KHR_lights_punctual"],
            "extensions": {"KHR_lights_punctual": {"lights": [{"type": "point"}]}}})),
        "model",
        Some("glb_extension"),
    ));
    list.push(sample(
        "glb_object_extension.glb",
        triangle(json!({"nodes": [{"mesh": 0, "extensions": {"EXT_mesh_gpu_instancing": {"attributes": {}}}}]})),
        "model",
        Some("glb_extension"),
    ));
    list.push(sample(
        "glb_camera.glb",
        triangle(json!({"cameras": [{"type": "perspective", "perspective": {"yfov": 1.0, "znear": 0.1}}]})),
        "model",
        Some("glb_unsupported"),
    ));
    list.push(sample(
        "glb_skin.glb",
        triangle(json!({"skins": [{"joints": [0]}]})),
        "model",
        Some("glb_unsupported"),
    ));
    list.push(sample(
        "glb_node_cycle.glb",
        triangle(json!({"scenes": [{"nodes": [0]}],
            "nodes": [{"mesh": 0, "children": [1]}, {"children": [2]}, {"children": [1]}]})),
        "model",
        Some("glb_node_graph"),
    ));
    list.push(sample(
        "glb_two_parents.glb",
        triangle(json!({"scenes": [{"nodes": [0, 1]}],
            "nodes": [{"children": [2]}, {"children": [2]}, {"mesh": 0}]})),
        "model",
        Some("glb_node_graph"),
    ));
    {
        // 4 个顶点、没有索引：三角形数不是整数。
        let mut four = TRIANGLE.to_vec();
        four.extend_from_slice(&[0.0, 0.5, 0.0]);
        let json = triangle_json(
            [-0.5, 0.0, -0.5],
            [0.5, 1.0, 0.5],
            json!({
                "accessors": [{"bufferView": 0, "componentType": 5126, "count": 4, "type": "VEC3",
                               "min": [-0.5, 0.0, -0.5], "max": [0.5, 1.0, 0.5]}],
                "bufferViews": [{"buffer": 0, "byteLength": 48}],
                "buffers": [{"byteLength": 48}],
            }),
        );
        list.push(sample(
            "glb_triangles_not_integer.glb",
            glb(&json, &floats(&four)),
            "model",
            Some("glb_triangles"),
        ));
    }
    // 声明的 max 比数据小（伪造包围盒）。
    list.push(sample(
        "glb_bounds_mismatch.glb",
        glb(
            &triangle_json([-0.5, 0.0, -0.5], [0.5, 0.2, 0.5], json!({})),
            &floats(&TRIANGLE),
        ),
        "model",
        Some("glb_bounds_mismatch"),
    ));
    {
        let far: Vec<f32> = TRIANGLE.iter().map(|v| v + 2000.0).collect();
        let json = triangle_json(
            [1999.5, 2000.0, 1999.5],
            [2000.5, 2001.0, 2000.5],
            json!({}),
        );
        list.push(sample(
            "glb_coords_out_of_range.glb",
            glb(&json, &floats(&far)),
            "model",
            Some("over_limit"),
        ));
    }
    list.push(sample(
        "glb_png_declared_jpeg.glb",
        textured(&png(64, 32), "image/jpeg", json!({})),
        "model",
        Some("image_mime_mismatch"),
    ));
    list.push(sample(
        "glb_jpeg_without_sof.glb",
        textured(&jpeg(16, 16, 100, false), "image/jpeg", json!({})),
        "model",
        Some("jpeg_no_sof"),
    ));
    list.push(sample(
        "glb_texture_too_large.glb",
        textured(&png(4096, 4096), "image/png", json!({})),
        "model",
        Some("over_limit"),
    ));
    // ---- 图片 ----
    list.push(sample("texture.png", png(640, 480), "texture", None));
    // EXIF + ICC 段合计 85 000 字节，宽高在第 85 KB 以后。
    list.push(sample(
        "texture_long_exif.jpg",
        jpeg(4000, 3000, 85_000, true),
        "texture",
        None,
    ));
    list.push(sample(
        "texture_no_sof.jpg",
        jpeg(16, 16, 200, false),
        "texture",
        Some("jpeg_no_sof"),
    ));
    list.push(sample(
        "texture.webp",
        webp_vp8x(2048, 1024),
        "texture",
        None,
    ));
    list.push(sample(
        "texture_too_large.png",
        png(8192, 8192),
        "texture",
        Some("over_limit"),
    ));
    // ---- zip（扫描） ----
    let tex = jpeg(64, 64, 0, true);
    list.push(sample(
        "scan.zip",
        zip(&[member("mesh.drc", DRC), member("tex.jpg", &tex)], false),
        "scan",
        None,
    ));
    list.push(sample(
        "scan_macos.zip",
        zip(
            &[
                member("lobby/", b""),
                member("lobby/mesh.drc", DRC),
                member("lobby/tex.jpg", &tex),
                member("lobby/.DS_Store", b"\0\0\0\x01Bud1"),
                member("__MACOSX/", b""),
                member("__MACOSX/lobby/._mesh.drc", b"\0\x05\x16\x07apple"),
            ],
            false,
        ),
        "scan",
        None,
    ));
    list.push(sample(
        "zip_dotdot.zip",
        zip(&[member("../mesh.drc", DRC)], false),
        "scan",
        Some("zip_path"),
    ));
    list.push(sample(
        "zip_absolute.zip",
        zip(&[member("/tmp/mesh.drc", DRC)], false),
        "scan",
        Some("zip_path"),
    ));
    list.push(sample(
        "zip_encrypted.zip",
        zip(
            &[Member {
                name: "mesh.drc",
                data: DRC,
                flags: 1,
                local_name: None,
            }],
            false,
        ),
        "scan",
        Some("zip_encrypted"),
    ));
    list.push(sample(
        "zip64.zip",
        zip(&[member("mesh.drc", DRC)], true),
        "scan",
        Some("zip_zip64"),
    ));
    list.push(sample(
        "zip_two_meshes.zip",
        zip(
            &[member("a.drc", DRC), member("b.obj", b"v 0 0 0\n")],
            false,
        ),
        "scan",
        Some("zip_members"),
    ));
    list.push(sample(
        "zip_local_header_mismatch.zip",
        zip(
            &[Member {
                name: "mesh.drc",
                data: DRC,
                flags: 0,
                local_name: Some("mash.drc"),
            }],
            false,
        ),
        "scan",
        Some("zip_local_header"),
    ));
    // ---- 其他扫描格式 ----
    list.push(sample("scan.drc", DRC.to_vec(), "scan", None));
    list.push(sample(
        "pointcloud.drc",
        b"DRACO\x02\x02\x00\x01\x00\x00 points".to_vec(),
        "scan",
        Some("drc_header"),
    ));
    list.push(sample(
        "scan.obj",
        b"# Scaniverse\nmtllib scan.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n".to_vec(),
        "scan",
        None,
    ));
    // ---- 操作文件、文本、清单 ----
    let ops = "{\"op\":\"fill\",\"box\":[0,0,0,1,1,1],\"block\":2}\n\n{\"op\":\"addBlock\",\"name\":\"stone\"}\n";
    list.push(sample("ops.ndjson", ops.as_bytes().to_vec(), "ops", None));
    {
        // 不压缩的 deflate（存储块）：输出与压缩库的版本无关。
        let mut encoder = GzEncoder::new(Vec::new(), flate2::Compression::none());
        encoder.write_all(ops.as_bytes()).unwrap();
        list.push(sample(
            "ops.ndjson.gz",
            encoder.finish().unwrap(),
            "ops",
            None,
        ));
    }
    list.push(sample(
        "ops_not_object.ndjson",
        b"{\"op\":\"fill\"}\n[1, 2]\n".to_vec(),
        "ops",
        Some("ndjson_line"),
    ));
    list.push(sample(
        "notes.txt",
        "建模记录：前台 🪑\n".as_bytes().to_vec(),
        "script",
        None,
    ));
    list.push(sample(
        "notes_bad_utf8.txt",
        b"notes \xff\xfe broken".to_vec(),
        "script",
        Some("text_encoding"),
    ));
    list.push(sample(
        "bundle.json",
        serde_json::to_vec(
            &json!({"format": "chrono-metaverse-rebuild-bundle", "version": 1, "files": []}),
        )
        .unwrap(),
        "bundle",
        None,
    ));
    list.push(sample(
        "bundle_wrong_version.json",
        serde_json::to_vec(
            &json!({"format": "chrono-metaverse-rebuild-bundle", "version": 2, "files": []}),
        )
        .unwrap(),
        "bundle",
        Some("json_structure"),
    ));
    list
}

fn purpose_of(name: &str) -> UploadPurpose {
    match name {
        "scan" => UploadPurpose::Scan,
        "webmodel" => UploadPurpose::WebModel,
        "model" => UploadPurpose::Model,
        "texture" => UploadPurpose::Texture,
        "ops" => UploadPurpose::Ops,
        "script" => UploadPurpose::Script,
        "bundle" => UploadPurpose::Bundle,
        other => panic!("未知用途 {other}"),
    }
}

/// 按扩展名定格式（与上传时声明的格式相同）。
fn format_of(file: &str) -> UploadFormat {
    let name = file.trim_end_matches(".gz");
    let format = if file.ends_with(".gz") {
        "gzip"
    } else {
        match name.rsplit('.').next().unwrap() {
            "jpg" => "jpeg",
            "txt" => "text",
            other => other,
        }
    };
    UploadFormat::from_name(format).unwrap_or_else(|| panic!("{file} 的格式"))
}

/// 跑一个样本：返回 `{ok, code?, check?}`。
fn run(bytes: &[u8], purpose: UploadPurpose, format: UploadFormat, step: usize) -> Value {
    let limits = UploadLimits::default();
    let outcome = inspect_bytes(purpose, format, bytes, step)
        .and_then(|check| within_limits(purpose, &check, &limits).map(|()| check));
    match outcome {
        Ok(check) => json!({"ok": true, "check": serde_json::to_value(check).unwrap()}),
        Err(reject) => json!({"ok": false, "code": reject.code}),
    }
}

fn expected_of(samples: &[Sample]) -> Value {
    let mut cases = Vec::new();
    for sample in samples {
        let format = format_of(sample.file);
        for (purpose, code) in &sample.cases {
            let actual = run(&sample.bytes, purpose_of(purpose), format, 1 << 18);
            let mut case =
                json!({"file": sample.file, "purpose": purpose, "format": format.name()});
            match code {
                None => {
                    assert_eq!(
                        actual["ok"], true,
                        "{} 按 {purpose} 应该通过：{actual}",
                        sample.file
                    );
                    case["ok"] = json!(true);
                    case["check"] = actual["check"].clone();
                }
                Some(code) => {
                    assert_eq!(
                        actual["code"], *code,
                        "{} 按 {purpose} 的拒绝码：{actual}",
                        sample.file
                    );
                    case["ok"] = json!(false);
                    case["code"] = json!(code);
                }
            }
            cases.push(case);
        }
    }
    json!({"version": 1, "limits": "default", "cases": cases})
}

#[test]
fn check_vectors_match_the_verifier() {
    let samples = samples();
    let expected = expected_of(&samples);
    let dir = directory();
    if std::env::var("METAVERSE_WRITE_CHECK_VECTORS").as_deref() == Ok("1") {
        std::fs::create_dir_all(&dir).unwrap();
        for sample in &samples {
            std::fs::write(dir.join(sample.file), &sample.bytes).unwrap();
        }
        let mut text = serde_json::to_string_pretty(&expected).unwrap();
        text.push('\n');
        std::fs::write(dir.join("expected.json"), text).unwrap();
    }
    // 目录里的样本与生成器一致。
    for sample in &samples {
        let stored = std::fs::read(dir.join(sample.file)).unwrap_or_else(|_| {
            panic!(
                "缺少样本 {}（用 METAVERSE_WRITE_CHECK_VECTORS=1 重新生成）",
                sample.file
            )
        });
        assert!(
            stored == sample.bytes,
            "样本 {} 与生成器不一致，请重新生成",
            sample.file
        );
    }
    let stored: Value =
        serde_json::from_slice(&std::fs::read(dir.join("expected.json")).unwrap()).unwrap();
    assert_eq!(stored, expected, "expected.json 与检查器的结果不一致");
    // 同一个文件按任意大小切块喂入，结果都一样（流式检查跨块接得上）。
    for case in stored["cases"].as_array().unwrap() {
        let file = case["file"].as_str().unwrap();
        let bytes = std::fs::read(dir.join(file)).unwrap();
        let purpose = purpose_of(case["purpose"].as_str().unwrap());
        let format = UploadFormat::from_name(case["format"].as_str().unwrap()).unwrap();
        for step in [1, 7, 4096] {
            let actual = run(&bytes, purpose, format, step);
            assert_eq!(actual["ok"], case["ok"], "{file}（每次 {step} 字节）");
            if case["ok"] == true {
                assert_eq!(actual["check"], case["check"], "{file}（每次 {step} 字节）");
            } else {
                assert_eq!(actual["code"], case["code"], "{file}（每次 {step} 字节）");
            }
        }
    }
}

/// 设计要求的样本都在（docs/design/server-slim.md 6.5）。
#[test]
fn required_samples_are_present() {
    let names: Vec<&str> = samples().iter().map(|sample| sample.file).collect();
    for required in [
        "glb_external_uri.glb",
        "glb_data_uri_image.glb",
        "glb_scan_draco.glb",
        "glb_lights.glb",
        "glb_object_extension.glb",
        "glb_camera.glb",
        "glb_node_cycle.glb",
        "glb_two_parents.glb",
        "glb_skin.glb",
        "glb_triangles_not_integer.glb",
        "glb_bounds_mismatch.glb",
        "glb_quantized.glb",
        "glb_rotated_node.glb",
        "glb_coords_out_of_range.glb",
        "texture_long_exif.jpg",
        "texture_no_sof.jpg",
        "glb_png_declared_jpeg.glb",
        "zip_dotdot.zip",
        "zip_absolute.zip",
        "zip_encrypted.zip",
        "zip64.zip",
        "zip_two_meshes.zip",
        "zip_local_header_mismatch.zip",
        "scan_macos.zip",
    ] {
        assert!(names.contains(&required), "缺少样本 {required}");
    }
}
