//! 区域内容的分层文字（设计 8.3 `GET .../regions/{region_id}/content`）：给 AI 看的纯文本，
//! 按"区域 → 地块 → 重建层 → 扩展层 → 锚点"分层列出。列表有条数上限，方块用量只在涉及的
//! 区块不多时统计。

use std::collections::BTreeMap;
use std::fmt::Write as _;

use metaverse_core::chunk::{Chunk, ChunkKey, CHUNK_SIZE};
use metaverse_core::grid::{GridBox, GRID_UNIT};
use metaverse_core::model::{Layer, RegionKind};
use metaverse_core::ops::PaletteBlock;
use metaverse_core::record::{AnchorBody, AnchorFootprint, EntityBody, EntityKind};
use metaverse_core::Timestamp;
use serde_json::Value;

use super::palette::parse_palette;
use crate::auth::Grant;
use crate::error::ApiError;
use crate::repo::Repo;

/// 每类列出的条数上限。
const MAX_LINES: usize = 300;
/// 统计方块用量时最多读的区块数（每层）。
const MAX_HISTOGRAM_CHUNKS: usize = 64;

/// 区域内容。
pub struct RegionContent {
    pub kind: RegionKind,
    pub text: String,
}

fn chunk_box(key: &ChunkKey) -> GridBox {
    let size = CHUNK_SIZE as i64;
    let min = [
        i64::from(key.cx) * size,
        i64::from(key.cy) * size,
        i64::from(key.cz) * size,
    ];
    GridBox {
        min,
        max: min.map(|v| v + size),
    }
}

fn metres(value: f64) -> String {
    let rounded = (value * 100.0).round() / 100.0;
    format!("{rounded}")
}

fn vec3(values: [f64; 3]) -> String {
    format!(
        "[{}, {}, {}]",
        metres(values[0]),
        metres(values[1]),
        metres(values[2])
    )
}

fn box_text(grid: &GridBox) -> String {
    let size = grid.size().map(|v| v as f64 * GRID_UNIT);
    format!(
        "{:?}（约 {}×{}×{} 米）",
        grid.to_array(),
        metres(size[0]),
        metres(size[1]),
        metres(size[2])
    )
}

fn intersects_any(target: &GridBox, boxes: &[GridBox]) -> bool {
    boxes.iter().any(|b| b.intersects(target))
}

fn shape_name(entity: &EntityBody) -> String {
    match &entity.shape {
        Some(shape) => format!("形状 {}", shape.kind.type_name()),
        None if entity.asset_hash.is_some() => "模型".to_owned(),
        None => "无几何".to_owned(),
    }
}

fn entity_line(entity: &EntityBody) -> String {
    let kind = match entity.kind {
        EntityKind::Structure => "结构",
        EntityKind::Object => "物体",
        EntityKind::Template => "模板",
    };
    let mut line = format!("  - {} {kind}", entity.entity_id);
    if let Some(label) = &entity.label {
        let _ = write!(line, "「{label}」");
    }
    let _ = write!(
        line,
        "，{}，范围 {} – {} 米",
        shape_name(entity),
        vec3(entity.bounds.min),
        vec3(entity.bounds.max)
    );
    if let Some(anchor) = &entity.anchor_id {
        let _ = write!(line, "，锚点 {anchor}");
    }
    line
}

fn anchor_line(anchor: &AnchorBody) -> String {
    let kind = serde_json::to_value(anchor.kind)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default();
    let visibility = match anchor.visibility {
        metaverse_core::model::DataVisibility::Public => "公开",
        metaverse_core::model::DataVisibility::Internal => "内部",
    };
    let mut line = format!("  - {} {kind} {visibility}", anchor.anchor_id);
    if let Some(label) = &anchor.label {
        let _ = write!(line, "「{label}」");
    }
    if let Some(grid) = &anchor.grid_box {
        let _ = write!(line, "，盒子 {:?}", grid.to_array());
    }
    if let Some(position) = anchor.position {
        let _ = write!(line, "，位置 {} 米", vec3(position));
    }
    line
}

fn block_name(palette: &[PaletteBlock], id: u16) -> String {
    match id {
        1 => "空气覆盖(1)".to_owned(),
        _ => palette.iter().find(|block| block.id == id).map_or_else(
            || format!("未知({id})"),
            |block| format!("{}({id})", block.name),
        ),
    }
}

/// 统计区域内各方块的格子数。
fn histogram(chunks: &[(ChunkKey, Chunk)], boxes: &[GridBox]) -> BTreeMap<u16, u64> {
    let mut counts = BTreeMap::new();
    for (key, chunk) in chunks {
        let base = chunk_box(key);
        for region in boxes {
            let Some(part) = base.intersection(region) else {
                continue;
            };
            for y in part.min[1]..part.max[1] {
                for z in part.min[2]..part.max[2] {
                    for x in part.min[0]..part.max[0] {
                        let local = [x - base.min[0], y - base.min[1], z - base.min[2]];
                        if let Ok(block) =
                            chunk.get(local[0] as usize, local[1] as usize, local[2] as usize)
                        {
                            if block != 0 {
                                *counts.entry(block).or_insert(0) += 1;
                            }
                        }
                    }
                }
            }
        }
    }
    counts
}

/// 组装区域内容。找不到区域返回 404。
pub async fn region_content(
    repo: &Repo,
    grant: &Grant,
    region_id: &str,
    seq: u64,
    at: Timestamp,
) -> Result<RegionContent, ApiError> {
    let manifest = repo.manifest_at(grant, seq).await?;
    let layout = repo.layout(grant, manifest.regions_hash.as_deref()).await?;
    let region = layout
        .regions
        .iter()
        .find(|region| region.id == region_id)
        .cloned()
        .ok_or_else(ApiError::not_found)?;
    let palette = parse_palette(
        &repo
            .palette_blocks(grant, manifest.palette_hash.as_deref())
            .await?,
    )
    .unwrap_or_default();
    let hashes: Vec<&str> = manifest
        .entities
        .values()
        .chain(manifest.anchors.values())
        .map(String::as_str)
        .collect();
    let bodies = repo.record_bodies(grant, &hashes).await?;
    let parse = |hash: &String| -> Option<Value> { bodies.get(hash).cloned() };

    let mut text = String::new();
    let kind_name = match region.kind {
        RegionKind::Physical => "实体区",
        RegionKind::Virtual => "虚拟区",
    };
    let _ = writeln!(
        text,
        "空间 {} · 区域 {}{}（{kind_name}）· seq {seq}（{}）",
        grant.space_id(),
        region.id,
        region
            .name
            .as_ref()
            .map(|n| format!("「{n}」"))
            .unwrap_or_default(),
        at
    );
    let _ = writeln!(
        text,
        "坐标：y 轴向上，单位米；格子 = {GRID_UNIT} 米，盒子是半开区间。"
    );
    let _ = writeln!(text, "范围（格）：");
    for grid in &region.boxes {
        let _ = writeln!(text, "  - {}", box_text(grid));
    }
    let plots: Vec<_> = layout
        .plots
        .iter()
        .filter(|plot| plot.region_id == region.id)
        .collect();
    if region.kind == RegionKind::Virtual {
        let _ = writeln!(text, "地块 {} 个：", plots.len());
        for plot in plots.iter().take(MAX_LINES) {
            let boxes: Vec<String> = plot.boxes.iter().map(box_text).collect();
            let _ = writeln!(
                text,
                "  - {}{}：{}",
                plot.id,
                plot.name
                    .as_ref()
                    .map(|n| format!("「{n}」"))
                    .unwrap_or_default(),
                boxes.join("；")
            );
        }
    }

    // 物件按图层分组。
    let mut by_layer: BTreeMap<Layer, Vec<EntityBody>> = BTreeMap::new();
    let mut unreadable = 0usize;
    for hash in manifest.entities.values() {
        let Some(value) = parse(hash) else {
            unreadable += 1;
            continue;
        };
        let Ok(entity) = serde_json::from_value::<EntityBody>(value) else {
            unreadable += 1;
            continue;
        };
        let inside = entity.region_id.as_deref() == Some(region.id.as_str())
            || (entity.kind != EntityKind::Template
                && entity
                    .footprint()
                    .is_ok_and(|grid| intersects_any(&grid, &region.boxes)));
        if inside {
            by_layer.entry(entity.layer).or_default().push(entity);
        }
    }
    // 区块按图层分组，并统计方块用量。
    let mut chunk_keys: BTreeMap<Layer, Vec<(ChunkKey, String)>> = BTreeMap::new();
    for (key, hash) in &manifest.chunks {
        if intersects_any(&chunk_box(key), &region.boxes) {
            chunk_keys
                .entry(key.layer)
                .or_default()
                .push((*key, hash.clone()));
        }
    }
    for (layer, title) in [
        (Layer::Rebuilt, "重建层（AI 按扫描轮廓重建，只由任务写入）"),
        (Layer::Ext, "扩展层（人和 AI 的修改）"),
    ] {
        let _ = writeln!(text, "{title}：");
        let entities = by_layer.remove(&layer).unwrap_or_default();
        let _ = writeln!(text, "  物件 {} 个", entities.len());
        for entity in entities.iter().take(MAX_LINES) {
            let _ = writeln!(text, "  {}", entity_line(entity));
        }
        if entities.len() > MAX_LINES {
            let _ = writeln!(text, "    ……另有 {} 个未列出", entities.len() - MAX_LINES);
        }
        let keys = chunk_keys.remove(&layer).unwrap_or_default();
        let _ = writeln!(text, "  方块区块 {} 个（32³ 格）", keys.len());
        if !keys.is_empty() && keys.len() <= MAX_HISTOGRAM_CHUNKS {
            let wanted: Vec<&str> = keys.iter().map(|(_, h)| h.as_str()).collect();
            let stored = repo.chunk_data(grant, &wanted).await?;
            let chunks: Vec<(ChunkKey, Chunk)> = keys
                .iter()
                .filter_map(|(key, hash)| {
                    let data = stored.get(hash)?;
                    Chunk::decompress(&data.data)
                        .ok()
                        .map(|chunk| (*key, chunk))
                })
                .collect();
            let counts = histogram(&chunks, &region.boxes);
            if !counts.is_empty() {
                let usage: Vec<String> = counts
                    .iter()
                    .map(|(id, count)| format!("{} {count} 格", block_name(&palette, *id)))
                    .collect();
                let _ = writeln!(text, "  方块用量：{}", usage.join("，"));
            }
        } else if keys.len() > MAX_HISTOGRAM_CHUNKS {
            let _ = writeln!(text, "  （区块太多，未统计方块用量）");
        }
    }
    if unreadable > 0 {
        let _ = writeln!(text, "（{unreadable} 个物件记录无法解析，未列出）");
    }

    // 锚点。
    let mut anchors = Vec::new();
    for hash in manifest.anchors.values() {
        let Some(anchor) = parse(hash).and_then(|v| serde_json::from_value::<AnchorBody>(v).ok())
        else {
            continue;
        };
        let inside = match anchor.footprint() {
            Ok(AnchorFootprint::Cells(grid)) => intersects_any(&grid, &region.boxes),
            _ => false,
        };
        if inside {
            anchors.push(anchor);
        }
    }
    let _ = writeln!(text, "锚点 {} 个：", anchors.len());
    for anchor in anchors.iter().take(MAX_LINES) {
        let _ = writeln!(text, "{}", anchor_line(anchor));
    }
    if anchors.len() > MAX_LINES {
        let _ = writeln!(text, "  ……另有 {} 个未列出", anchors.len() - MAX_LINES);
    }
    if !palette.is_empty() {
        let names: Vec<String> = palette
            .iter()
            .map(|block| format!("{}={}", block.id, block.name))
            .collect();
        let _ = writeln!(text, "方块表（编号=名称）：{}", names.join("，"));
    }
    Ok(RegionContent {
        kind: region.kind,
        text,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn histogram_counts_only_cells_inside_the_region() {
        let mut chunk = Chunk::empty();
        chunk.set(0, 0, 0, 2).unwrap();
        chunk.set(5, 0, 0, 2).unwrap();
        chunk.set(6, 0, 0, 3).unwrap();
        let key = ChunkKey {
            layer: Layer::Ext,
            cx: 0,
            cy: 0,
            cz: 0,
        };
        let region = [GridBox::from_array([0, 0, 0, 6, 1, 1]).unwrap()];
        let counts = histogram(&[(key, chunk)], &region);
        assert_eq!(counts.get(&2), Some(&2));
        assert_eq!(counts.get(&3), None);
        assert!(box_text(&region[0]).contains("0.3×0.05×0.05"));
    }
}
