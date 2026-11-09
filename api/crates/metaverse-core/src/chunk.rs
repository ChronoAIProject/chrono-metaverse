//! 区块编码（设计 4.2、SHAPES 4）。
//!
//! - 区块是 32×32×32 个 `u16` 方块编号，下标 `index = x + 32·(z + 32·y)`；
//! - 规范字节：按下标顺序写小端 `u16`，共 65,536 字节；
//! - 区块哈希：`sha256(0x01 ‖ 规范字节)` 的小写十六进制，`0x01` 是格式版本；
//! - 存储：zlib（deflate）压缩，哈希按未压缩的规范字节算。压缩结果不要求
//!   各语言逐字节一致，只要求能解回同一份规范字节。

use std::io::{Read, Write};

use flate2::{read::ZlibDecoder, write::ZlibEncoder, Compression};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::model::Layer;
use crate::to_hex;

pub const CHUNK_SIZE: usize = 32;
pub const CHUNK_CELLS: usize = CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE;
pub const CHUNK_BYTES: usize = CHUNK_CELLS * 2;
/// 区块哈希里的格式版本字节。
pub const CHUNK_FORMAT_VERSION: u8 = 0x01;

/// 0：空，或者扩展层里"不覆盖"。
pub const BLOCK_EMPTY: u16 = 0;
/// 1：空气覆盖，只在扩展层有效，用来删掉下层的方块。
pub const BLOCK_AIR: u16 = 1;
/// 方块表的编号从 2 开始。
pub const FIRST_PALETTE_BLOCK: u16 = 2;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ChunkError {
    #[error("规范字节必须正好 65536 字节")]
    Length,
    #[error("压缩数据无法解压")]
    Corrupt,
    #[error("格子坐标超出 0..32")]
    Coordinate,
}

/// 一个区块的方块编号。
#[derive(Clone, PartialEq, Eq)]
pub struct Chunk {
    cells: Vec<u16>,
}

impl std::fmt::Debug for Chunk {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Chunk")
            .field("non_zero", &self.non_zero_count())
            .finish()
    }
}

impl Default for Chunk {
    fn default() -> Self {
        Self::empty()
    }
}

/// 区块内的下标。坐标超出 0..32 时返回 `None`。
pub fn cell_index(x: usize, y: usize, z: usize) -> Option<usize> {
    (x < CHUNK_SIZE && y < CHUNK_SIZE && z < CHUNK_SIZE)
        .then_some(x + CHUNK_SIZE * (z + CHUNK_SIZE * y))
}

impl Chunk {
    pub fn empty() -> Self {
        Self {
            cells: vec![BLOCK_EMPTY; CHUNK_CELLS],
        }
    }

    pub fn get(&self, x: usize, y: usize, z: usize) -> Result<u16, ChunkError> {
        let index = cell_index(x, y, z).ok_or(ChunkError::Coordinate)?;
        Ok(self.cells[index])
    }

    pub fn set(&mut self, x: usize, y: usize, z: usize, block: u16) -> Result<(), ChunkError> {
        let index = cell_index(x, y, z).ok_or(ChunkError::Coordinate)?;
        self.cells[index] = block;
        Ok(())
    }

    pub fn cells(&self) -> &[u16] {
        &self.cells
    }

    /// 按下标直接改写（下标见 [`cell_index`]）。长度固定为 32768。
    pub fn cells_mut(&mut self) -> &mut [u16] {
        &mut self.cells
    }

    /// 全 0 的区块不进清单（设计 4.2）。
    pub fn is_empty(&self) -> bool {
        self.cells.iter().all(|cell| *cell == BLOCK_EMPTY)
    }

    pub fn non_zero_count(&self) -> usize {
        self.cells
            .iter()
            .filter(|cell| **cell != BLOCK_EMPTY)
            .count()
    }

    pub fn canonical_bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(CHUNK_BYTES);
        for cell in &self.cells {
            bytes.extend_from_slice(&cell.to_le_bytes());
        }
        bytes
    }

    pub fn from_canonical_bytes(bytes: &[u8]) -> Result<Self, ChunkError> {
        if bytes.len() != CHUNK_BYTES {
            return Err(ChunkError::Length);
        }
        Ok(Self {
            cells: bytes
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect(),
        })
    }

    pub fn hash(&self) -> String {
        chunk_hash(&self.canonical_bytes())
    }

    /// zlib 压缩后的存储字节。
    pub fn compress(&self) -> Vec<u8> {
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
        encoder
            .write_all(&self.canonical_bytes())
            .expect("写入内存不会失败");
        encoder.finish().expect("写入内存不会失败")
    }

    /// 解压存储字节。解压结果最多读 65,537 字节，超出或不足都判为损坏，
    /// 所以恶意构造的压缩炸弹不会耗尽内存。
    pub fn decompress(compressed: &[u8]) -> Result<Self, ChunkError> {
        let mut decoder = ZlibDecoder::new(compressed).take(CHUNK_BYTES as u64 + 1);
        let mut bytes = Vec::with_capacity(CHUNK_BYTES);
        decoder
            .read_to_end(&mut bytes)
            .map_err(|_| ChunkError::Corrupt)?;
        if bytes.len() != CHUNK_BYTES {
            return Err(ChunkError::Corrupt);
        }
        Self::from_canonical_bytes(&bytes)
    }
}

/// `sha256(0x01 ‖ 规范字节)` 的小写十六进制。
pub fn chunk_hash(canonical_bytes: &[u8]) -> String {
    let mut digest = Sha256::new();
    digest.update([CHUNK_FORMAT_VERSION]);
    digest.update(canonical_bytes);
    to_hex(&digest.finalize())
}

/// 区块的位置：图层 + 区块坐标（格坐标整除 32）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct ChunkKey {
    pub layer: Layer,
    pub cx: i32,
    pub cy: i32,
    pub cz: i32,
}

/// 格坐标 → (区块坐标, 区块内坐标)。负坐标按向下取整处理。
pub fn locate_cell(cell: [i64; 3]) -> ([i32; 3], [usize; 3]) {
    let size = CHUNK_SIZE as i64;
    let chunk = cell.map(|v| v.div_euclid(size) as i32);
    let local = cell.map(|v| v.rem_euclid(size) as usize);
    (chunk, local)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_and_byte_order() {
        assert_eq!(cell_index(1, 0, 0), Some(1));
        assert_eq!(cell_index(0, 0, 1), Some(32));
        assert_eq!(cell_index(0, 1, 0), Some(1024));
        assert_eq!(cell_index(31, 31, 31), Some(CHUNK_CELLS - 1));
        assert_eq!(cell_index(32, 0, 0), None);
        let mut chunk = Chunk::empty();
        chunk.set(0, 1, 0, 0x0302).unwrap();
        let bytes = chunk.canonical_bytes();
        assert_eq!(bytes.len(), CHUNK_BYTES);
        assert_eq!(&bytes[2048..2050], &[0x02, 0x03]);
    }

    #[test]
    fn empty_chunk_hash_and_round_trip() {
        let empty = Chunk::empty();
        assert!(empty.is_empty());
        let mut hasher = Sha256::new();
        hasher.update([1u8]);
        hasher.update(vec![0u8; CHUNK_BYTES]);
        assert_eq!(empty.hash(), to_hex(&hasher.finalize()));
        let mut chunk = Chunk::empty();
        chunk.set(3, 4, 5, 7).unwrap();
        chunk.set(31, 31, 31, BLOCK_AIR).unwrap();
        let restored = Chunk::decompress(&chunk.compress()).unwrap();
        assert_eq!(restored, chunk);
        assert_eq!(restored.hash(), chunk.hash());
        assert_ne!(chunk.hash(), empty.hash());
    }

    #[test]
    fn corrupt_and_oversized_payloads_are_rejected() {
        assert_eq!(Chunk::decompress(b"not zlib"), Err(ChunkError::Corrupt));
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(&vec![0u8; CHUNK_BYTES + 2]).unwrap();
        assert_eq!(
            Chunk::decompress(&encoder.finish().unwrap()),
            Err(ChunkError::Corrupt)
        );
        assert_eq!(
            Chunk::from_canonical_bytes(&[0u8; 10]),
            Err(ChunkError::Length)
        );
    }

    #[test]
    fn negative_cells_locate_by_floor_division() {
        assert_eq!(locate_cell([-1, 0, 33]), ([-1, 0, 1], [31, 0, 1]));
        assert_eq!(locate_cell([-32, -33, 0]), ([-1, -2, 0], [0, 31, 0]));
    }
}
