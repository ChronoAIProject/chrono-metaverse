//! 方块表（设计 4.3）：通用方块、解析、发布时分配正式编号。
//!
//! - 每个空间创建时自动带上一套通用方块（第一次提交的 `paletteHash`）；
//! - 编号只增不改，0、1 保留，通用方块从 2 开始；
//! - 草稿里新增的方块用临时编号，发布时按最新的方块表分配正式编号（[`assign_final_ids`]）。

use std::collections::BTreeMap;

use metaverse_core::chunk::BLOCK_AIR;
use metaverse_core::ops::{BlockKind, PaletteBlock};
use serde_json::Value;

use crate::repo::ProvisionalBlock;

/// 通用方块：(名称, 类型, 颜色)。顺序决定编号（从 2 开始），上线后只能在末尾追加。
const BUILTIN: &[(&str, BlockKind, [u8; 3])] = &[
    ("stone", BlockKind::Solid, [128, 128, 128]),
    ("concrete", BlockKind::Solid, [180, 180, 176]),
    ("brick", BlockKind::Solid, [168, 74, 52]),
    ("wood", BlockKind::Solid, [150, 111, 51]),
    ("wood-dark", BlockKind::Solid, [92, 64, 36]),
    ("plaster-white", BlockKind::Solid, [236, 234, 228]),
    ("tile-white", BlockKind::Solid, [242, 242, 238]),
    ("marble", BlockKind::Solid, [224, 222, 216]),
    ("metal", BlockKind::Solid, [170, 174, 180]),
    ("metal-dark", BlockKind::Solid, [60, 62, 66]),
    ("glass", BlockKind::Glass, [200, 228, 240]),
    ("glass-tinted", BlockKind::Glass, [90, 110, 120]),
    ("fabric-red", BlockKind::Solid, [170, 40, 44]),
    ("fabric-blue", BlockKind::Solid, [40, 70, 150]),
    ("grass", BlockKind::Solid, [96, 160, 64]),
    ("soil", BlockKind::Solid, [110, 80, 50]),
    ("sand", BlockKind::Solid, [220, 200, 150]),
    ("water", BlockKind::Liquid, [60, 120, 200]),
    ("leaves", BlockKind::Foliage, [60, 130, 50]),
    ("light", BlockKind::Emissive, [255, 244, 214]),
];

/// 通用方块表。
pub fn builtin_palette() -> Vec<PaletteBlock> {
    BUILTIN
        .iter()
        .enumerate()
        .map(|(index, (name, kind, color))| PaletteBlock {
            id: BLOCK_AIR + 1 + index as u16,
            name: (*name).to_owned(),
            kind: *kind,
            color: Some(*color),
            texture: None,
            tags: vec!["builtin".to_owned()],
        })
        .collect()
}

/// 解析存储的方块列表。
pub fn parse_palette(blocks: &Value) -> Result<Vec<PaletteBlock>, String> {
    serde_json::from_value(blocks.clone()).map_err(|error| format!("方块表格式不对：{error}"))
}

/// 方块表的存储形式。
pub fn palette_value(blocks: &[PaletteBlock]) -> Value {
    serde_json::to_value(blocks).unwrap_or(Value::Array(Vec::new()))
}

/// 新方块（带正式编号）和"临时编号 → 正式编号"的映射。
pub type FinalIds = (Vec<PaletteBlock>, BTreeMap<u16, u16>);

/// 发布时给草稿新增的方块分配正式编号：追加在最新方块表之后。
/// 返回新方块（带正式编号）和"临时编号 → 正式编号"的映射；名称与最新方块表重复时返回冲突的名称。
pub fn assign_final_ids(
    head: &[PaletteBlock],
    provisional: &[ProvisionalBlock],
) -> Result<FinalIds, Vec<String>> {
    let clashes: Vec<String> = provisional
        .iter()
        .filter(|block| head.iter().any(|existing| existing.name == block.name))
        .map(|block| block.name.clone())
        .collect();
    if !clashes.is_empty() {
        return Err(clashes);
    }
    let mut next = head
        .iter()
        .map(|b| b.id)
        .max()
        .unwrap_or(BLOCK_AIR)
        .max(BLOCK_AIR);
    let mut ordered: Vec<&ProvisionalBlock> = provisional.iter().collect();
    ordered.sort_by_key(|block| block.id);
    let mut added = Vec::new();
    let mut mapping = BTreeMap::new();
    for block in ordered {
        next = next
            .checked_add(1)
            .ok_or_else(|| vec![block.name.clone()])?;
        mapping.insert(block.id, next);
        added.push(PaletteBlock {
            id: next,
            name: block.name.clone(),
            kind: block.block.kind,
            color: block.block.color,
            texture: block.block.texture.clone(),
            tags: block.block.tags.clone(),
        });
    }
    Ok((added, mapping))
}

#[cfg(test)]
mod tests {
    use super::*;
    use metaverse_core::ops::BlockDef;

    #[test]
    fn builtin_ids_start_at_two_and_names_are_unique() {
        let palette = builtin_palette();
        assert_eq!(palette[0].id, 2);
        assert_eq!(palette[0].name, "stone");
        let mut names: Vec<_> = palette.iter().map(|b| b.name.clone()).collect();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), palette.len());
        for block in &palette {
            assert!(block.color.is_some());
        }
        let back = parse_palette(&palette_value(&palette)).unwrap();
        assert_eq!(back, palette);
    }

    #[test]
    fn final_ids_follow_head_and_detect_name_clashes() {
        let head = builtin_palette();
        let last = head.last().unwrap().id;
        let block = |name: &str, id: u16| ProvisionalBlock {
            name: name.into(),
            id,
            block: BlockDef {
                name: name.into(),
                kind: BlockKind::Solid,
                color: Some([1, 2, 3]),
                texture: None,
                tags: vec![],
            },
        };
        let (added, mapping) =
            assign_final_ids(&head, &[block("b2", last + 2), block("b1", last + 1)]).unwrap();
        assert_eq!(added[0].name, "b1");
        assert_eq!(mapping[&(last + 1)], last + 1);
        assert_eq!(mapping[&(last + 2)], last + 2);
        // 时间线上方块表又追加过：临时编号要换掉。
        let mut longer = head.clone();
        longer.push(PaletteBlock {
            id: last + 1,
            name: "scan-1".into(),
            kind: BlockKind::Solid,
            color: Some([0, 0, 0]),
            texture: None,
            tags: vec![],
        });
        let (_, mapping) = assign_final_ids(&longer, &[block("b1", last + 1)]).unwrap();
        assert_eq!(mapping[&(last + 1)], last + 2);
        assert_eq!(
            assign_final_ids(&head, &[block("stone", last + 1)]).unwrap_err(),
            vec!["stone".to_owned()]
        );
    }
}
