//! 全局定位网格（设计第 2 节、SHAPES 1）。
//!
//! 网格只用于定位、区域和地块边界、锚点吸附、占用索引；形状的尺寸和位置都是
//! 连续值，不吸附到网格。区域和地块是若干轴对齐盒子，单位是格，写成
//! `[x0, y0, z0, x1, y1, z1]`，按半开区间理解：盒子包含 `x0 ≤ x < x1` 的格子。

use serde::{de, Deserialize, Deserializer, Serialize, Serializer};

/// 网格单位，米。全系统统一，上线后不可改。
pub const GRID_UNIT: f64 = 0.05;

/// 盒子坐标的绝对值上限（格）。2^30 格约 5 万公里，足够任何空间，
/// 同时保证体积计算不会溢出。
pub const MAX_GRID_COORD: i64 = 1 << 30;

/// 米换算成格时，离整数这么近就当作整数，避免 `0.15 / 0.05 = 2.9999999999999996`
/// 这类浮点误差把边界算偏一格。
const SNAP_EPSILON: f64 = 1e-6;

/// 米 → 格（连续值）。
pub fn metres_to_grid(metres: f64) -> f64 {
    metres / GRID_UNIT
}

/// 格 → 米。
pub fn grid_to_metres(cells: i64) -> f64 {
    cells as f64 * GRID_UNIT
}

fn snapped(value: f64) -> Option<f64> {
    let rounded = value.round();
    ((value - rounded).abs() < SNAP_EPSILON).then_some(rounded)
}

/// 不大于该位置的格坐标（接近整数时先吸附）。
pub fn floor_to_grid(metres: f64) -> i64 {
    let cells = metres_to_grid(metres);
    snapped(cells).unwrap_or_else(|| cells.floor()) as i64
}

/// 不小于该位置的格坐标（接近整数时先吸附）。
pub fn ceil_to_grid(metres: f64) -> i64 {
    let cells = metres_to_grid(metres);
    snapped(cells).unwrap_or_else(|| cells.ceil()) as i64
}

/// 最近的格坐标（锚点吸附用）。
pub fn round_to_grid(metres: f64) -> i64 {
    metres_to_grid(metres).round() as i64
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum GridError {
    #[error("盒子的每一维都必须满足 min < max")]
    Empty,
    #[error("盒子坐标超出范围（绝对值不超过 2^30 格）")]
    OutOfRange,
}

/// 轴对齐的格子盒子，半开区间 `[min, max)`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct GridBox {
    pub min: [i64; 3],
    pub max: [i64; 3],
}

impl GridBox {
    pub fn new(min: [i64; 3], max: [i64; 3]) -> Result<Self, GridError> {
        let candidate = Self { min, max };
        candidate.validate()?;
        Ok(candidate)
    }

    pub fn from_array(value: [i64; 6]) -> Result<Self, GridError> {
        Self::new(
            [value[0], value[1], value[2]],
            [value[3], value[4], value[5]],
        )
    }

    pub fn to_array(self) -> [i64; 6] {
        [
            self.min[0],
            self.min[1],
            self.min[2],
            self.max[0],
            self.max[1],
            self.max[2],
        ]
    }

    pub fn validate(&self) -> Result<(), GridError> {
        if self
            .min
            .iter()
            .chain(self.max.iter())
            .any(|v| v.abs() > MAX_GRID_COORD)
        {
            return Err(GridError::OutOfRange);
        }
        if (0..3).any(|axis| self.min[axis] >= self.max[axis]) {
            return Err(GridError::Empty);
        }
        Ok(())
    }

    /// 格子数。
    pub fn volume(&self) -> u128 {
        (0..3)
            .map(|axis| (self.max[axis] - self.min[axis]).max(0) as u128)
            .product()
    }

    pub fn size(&self) -> [i64; 3] {
        [
            self.max[0] - self.min[0],
            self.max[1] - self.min[1],
            self.max[2] - self.min[2],
        ]
    }

    pub fn contains_cell(&self, cell: [i64; 3]) -> bool {
        (0..3).all(|axis| self.min[axis] <= cell[axis] && cell[axis] < self.max[axis])
    }

    pub fn contains_box(&self, other: &GridBox) -> bool {
        (0..3).all(|axis| self.min[axis] <= other.min[axis] && other.max[axis] <= self.max[axis])
    }

    /// 是否有共同的格子（只碰到边界不算）。
    pub fn intersects(&self, other: &GridBox) -> bool {
        (0..3).all(|axis| self.min[axis] < other.max[axis] && other.min[axis] < self.max[axis])
    }

    pub fn intersection(&self, other: &GridBox) -> Option<GridBox> {
        if !self.intersects(other) {
            return None;
        }
        let mut min = [0; 3];
        let mut max = [0; 3];
        for axis in 0..3 {
            min[axis] = self.min[axis].max(other.min[axis]);
            max[axis] = self.max[axis].min(other.max[axis]);
        }
        Some(GridBox { min, max })
    }

    /// 同时包住两个盒子的最小盒子。
    pub fn bounding_union(&self, other: &GridBox) -> GridBox {
        let mut min = [0; 3];
        let mut max = [0; 3];
        for axis in 0..3 {
            min[axis] = self.min[axis].min(other.min[axis]);
            max[axis] = self.max[axis].max(other.max[axis]);
        }
        GridBox { min, max }
    }

    pub fn translated(&self, offset: [i64; 3]) -> Result<GridBox, GridError> {
        let mut min = self.min;
        let mut max = self.max;
        for axis in 0..3 {
            min[axis] = min[axis]
                .checked_add(offset[axis])
                .ok_or(GridError::OutOfRange)?;
            max[axis] = max[axis]
                .checked_add(offset[axis])
                .ok_or(GridError::OutOfRange)?;
        }
        GridBox::new(min, max)
    }

    /// `self` 减去 `other` 后剩下的部分，拆成最多 6 个互不重叠的盒子。
    pub fn subtract(&self, other: &GridBox) -> Vec<GridBox> {
        let Some(cut) = self.intersection(other) else {
            return vec![*self];
        };
        let mut pieces = Vec::new();
        let mut rest = *self;
        for axis in 0..3 {
            if rest.min[axis] < cut.min[axis] {
                let mut piece = rest;
                piece.max[axis] = cut.min[axis];
                pieces.push(piece);
                rest.min[axis] = cut.min[axis];
            }
            if cut.max[axis] < rest.max[axis] {
                let mut piece = rest;
                piece.min[axis] = cut.max[axis];
                pieces.push(piece);
                rest.max[axis] = cut.max[axis];
            }
        }
        pieces
    }

    /// 盒子在米坐标下占的范围。
    pub fn to_metres(&self) -> Aabb {
        Aabb {
            min: self.min.map(grid_to_metres),
            max: self.max.map(grid_to_metres),
        }
    }
}

/// `target` 是否完全落在 `cover` 这组盒子的并集里（精确判断）。
pub fn covered_by(target: &GridBox, cover: &[GridBox]) -> bool {
    let mut remaining = vec![*target];
    for piece in cover {
        remaining = remaining
            .iter()
            .flat_map(|part| part.subtract(piece))
            .collect();
        if remaining.is_empty() {
            return true;
        }
        // 碎片数有上限：盒子数通常只有几个，超过就保守地判为不在范围内。
        if remaining.len() > 4096 {
            return false;
        }
    }
    remaining.is_empty()
}

/// 两组盒子是否有重叠。
pub fn any_overlap(left: &[GridBox], right: &[GridBox]) -> bool {
    left.iter().any(|a| right.iter().any(|b| a.intersects(b)))
}

impl Serialize for GridBox {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_array().serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for GridBox {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = <[i64; 6]>::deserialize(deserializer)?;
        GridBox::from_array(raw).map_err(de::Error::custom)
    }
}

/// 米坐标下的轴对齐包围盒（闭区间）。形状和物件的 `bounds` 用它。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Aabb {
    pub min: [f64; 3],
    pub max: [f64; 3],
}

impl Aabb {
    pub fn from_points(points: impl IntoIterator<Item = [f64; 3]>) -> Option<Aabb> {
        let mut iter = points.into_iter();
        let first = iter.next()?;
        let mut result = Aabb {
            min: first,
            max: first,
        };
        for point in iter {
            result.include(point);
        }
        Some(result)
    }

    pub fn include(&mut self, point: [f64; 3]) {
        for (axis, value) in point.iter().enumerate() {
            self.min[axis] = self.min[axis].min(*value);
            self.max[axis] = self.max[axis].max(*value);
        }
    }

    pub fn union(&self, other: &Aabb) -> Aabb {
        let mut result = *self;
        result.include(other.min);
        result.include(other.max);
        result
    }

    pub fn is_valid(&self) -> bool {
        self.min
            .iter()
            .chain(self.max.iter())
            .all(|v| v.is_finite())
            && (0..3).all(|axis| self.min[axis] <= self.max[axis])
    }

    /// 是否包住另一个包围盒（允许 `tolerance` 米的误差）。
    pub fn contains(&self, other: &Aabb, tolerance: f64) -> bool {
        (0..3).all(|axis| {
            self.min[axis] - tolerance <= other.min[axis]
                && other.max[axis] <= self.max[axis] + tolerance
        })
    }

    pub fn corners(&self) -> [[f64; 3]; 8] {
        let (a, b) = (self.min, self.max);
        [
            [a[0], a[1], a[2]],
            [b[0], a[1], a[2]],
            [a[0], b[1], a[2]],
            [b[0], b[1], a[2]],
            [a[0], a[1], b[2]],
            [b[0], a[1], b[2]],
            [a[0], b[1], b[2]],
            [b[0], b[1], b[2]],
        ]
    }

    /// 覆盖这个包围盒的格子盒子：min 向下取整、max 向上取整；
    /// 某一维厚度为 0 时（平面、点），按占一格处理。
    pub fn grid_cover(&self) -> Result<GridBox, GridError> {
        if !self.is_valid() {
            return Err(GridError::Empty);
        }
        let mut min = [0; 3];
        let mut max = [0; 3];
        for axis in 0..3 {
            let low = metres_to_grid(self.min[axis]);
            let high = metres_to_grid(self.max[axis]);
            if !(low.abs() <= MAX_GRID_COORD as f64 && high.abs() <= MAX_GRID_COORD as f64) {
                return Err(GridError::OutOfRange);
            }
            min[axis] = floor_to_grid(self.min[axis]);
            max[axis] = ceil_to_grid(self.max[axis]).max(min[axis] + 1);
        }
        GridBox::new(min, max)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gb(v: [i64; 6]) -> GridBox {
        GridBox::from_array(v).unwrap()
    }

    #[test]
    fn metre_grid_conversion_snaps_float_noise() {
        assert_eq!(floor_to_grid(0.15), 3);
        assert_eq!(ceil_to_grid(0.15), 3);
        assert_eq!(floor_to_grid(0.151), 3);
        assert_eq!(ceil_to_grid(0.151), 4);
        assert_eq!(floor_to_grid(-0.01), -1);
        assert_eq!(round_to_grid(0.124), 2);
        assert!((grid_to_metres(20) - 1.0).abs() < 1e-12);
    }

    #[test]
    fn box_validation_and_json_form() {
        assert!(GridBox::from_array([0, 0, 0, 0, 1, 1]).is_err());
        assert!(GridBox::from_array([0, 0, 0, MAX_GRID_COORD + 1, 1, 1]).is_err());
        let b = gb([0, 0, 0, 2, 3, 4]);
        assert_eq!(b.volume(), 24);
        assert_eq!(serde_json::to_string(&b).unwrap(), "[0,0,0,2,3,4]");
        assert_eq!(serde_json::from_str::<GridBox>("[0,0,0,2,3,4]").unwrap(), b);
        assert!(serde_json::from_str::<GridBox>("[0,0,0,0,3,4]").is_err());
    }

    #[test]
    fn containment_intersection_and_subtraction() {
        let outer = gb([0, 0, 0, 10, 10, 10]);
        let inner = gb([2, 2, 2, 5, 5, 5]);
        assert!(outer.contains_box(&inner));
        assert!(!inner.contains_box(&outer));
        assert!(outer.contains_cell([9, 9, 9]));
        assert!(!outer.contains_cell([10, 0, 0]));
        let touching = gb([10, 0, 0, 12, 1, 1]);
        assert!(!outer.intersects(&touching));
        let pieces = outer.subtract(&inner);
        let total: u128 = pieces.iter().map(GridBox::volume).sum();
        assert_eq!(total, outer.volume() - inner.volume());
        for (i, a) in pieces.iter().enumerate() {
            assert!(!a.intersects(&inner));
            for b in &pieces[i + 1..] {
                assert!(!a.intersects(b));
            }
        }
    }

    #[test]
    fn union_coverage_is_exact() {
        let left = gb([0, 0, 0, 5, 4, 4]);
        let right = gb([5, 0, 0, 10, 4, 4]);
        assert!(covered_by(&gb([3, 0, 0, 7, 4, 4]), &[left, right]));
        assert!(!covered_by(&gb([3, 0, 0, 7, 5, 4]), &[left, right]));
        assert!(!covered_by(&gb([3, 0, 0, 11, 4, 4]), &[left, right]));
        assert!(!covered_by(&gb([0, 0, 0, 1, 1, 1]), &[]));
    }

    #[test]
    fn aabb_grid_cover() {
        let aabb = Aabb {
            min: [-0.01, 0.0, 0.1],
            max: [0.15, 0.0, 0.26],
        };
        assert_eq!(aabb.grid_cover().unwrap(), gb([-1, 0, 2, 3, 1, 6]));
        assert!(Aabb {
            min: [0.0; 3],
            max: [f64::NAN, 0.0, 0.0]
        }
        .grid_cover()
        .is_err());
    }
}
