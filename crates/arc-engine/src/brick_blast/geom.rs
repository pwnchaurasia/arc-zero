//! Fixed-point geometry for ball collisions. Every function is pure integer maths.

use super::trig_table::{COS, SIN, TRIG_SCALE};
use super::{Shape, AIM_MAX, AIM_MIN, BLOCK_INSET, CELL, MIN_VY, SPEED};
use crate::isqrt;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct V {
    pub x: i64,
    pub y: i64,
}

impl V {
    pub const fn new(x: i64, y: i64) -> Self {
        Self { x, y }
    }
    fn sub(self, o: Self) -> Self {
        Self::new(self.x - o.x, self.y - o.y)
    }
    fn dot(self, o: Self) -> i64 {
        self.x * o.x + self.y * o.y
    }
    fn cross(self, o: Self) -> i64 {
        self.x * o.y - self.y * o.x
    }
    pub fn len2(self) -> i64 {
        self.dot(self)
    }
}

/// Block outline inside its cell (inset by `BLOCK_INSET`). Returns vertices and count.
pub(super) fn polygon(shape: Shape, row: usize, col: usize) -> ([V; 4], usize) {
    let cell = i64::from(CELL);
    let inset = i64::from(BLOCK_INSET);
    let (x0, y0) = (col as i64 * cell + inset, row as i64 * cell + inset);
    let (x1, y1) = (
        (col as i64 + 1) * cell - inset,
        (row as i64 + 1) * cell - inset,
    );
    let (tl, tr, bl, br) = (
        V::new(x0, y0),
        V::new(x1, y0),
        V::new(x0, y1),
        V::new(x1, y1),
    );
    match shape {
        Shape::Square => ([tl, tr, br, bl], 4),
        Shape::TriBl => ([bl, tl, br, br], 3),
        Shape::TriBr => ([br, bl, tr, tr], 3),
        Shape::TriTl => ([tl, tr, bl, bl], 3),
        Shape::TriTr => ([tr, br, tl, tl], 3),
    }
}

fn closest_on_segment(p: V, a: V, b: V) -> V {
    let ab = b.sub(a);
    let den = ab.len2();
    let t = p.sub(a).dot(ab);
    if t <= 0 || den == 0 {
        a
    } else if t >= den {
        b
    } else {
        V::new(a.x + ab.x * t / den, a.y + ab.y * t / den)
    }
}

/// Closest point on the polygon outline to `p`, and whether `p` lies inside it.
pub(super) fn closest_on_polygon(p: V, poly: &[V]) -> (V, bool) {
    let n = poly.len();
    let mut best = poly[0];
    let mut best_d = i64::MAX;
    let (mut pos, mut neg) = (false, false);
    for i in 0..n {
        let (a, b) = (poly[i], poly[(i + 1) % n]);
        let c = closest_on_segment(p, a, b);
        let d = p.sub(c).len2();
        if d < best_d {
            best_d = d;
            best = c;
        }
        let side = b.sub(a).cross(p.sub(a));
        pos |= side > 0;
        neg |= side < 0;
    }
    (best, !(pos && neg))
}

/// Scales a velocity back to `SPEED` and keeps it from going near-horizontal.
pub(super) fn renormalize(vx: i64, vy: i64) -> (i32, i32) {
    let speed = i64::from(SPEED);
    let len = i64::try_from(isqrt(u64::try_from(vx * vx + vy * vy).unwrap_or(0))).unwrap_or(0);
    if len == 0 {
        return (0, -SPEED);
    }
    let (mut nx, mut ny) = (vx * speed / len, vy * speed / len);
    let min_vy = i64::from(MIN_VY);
    if ny.abs() < min_vy {
        ny = if ny < 0 { -min_vy } else { min_vy };
        let side = i64::try_from(isqrt(
            u64::try_from(speed * speed - min_vy * min_vy).unwrap_or(0),
        ))
        .unwrap_or(0);
        nx = if nx < 0 { -side } else { side };
    }
    (to_i32(nx), to_i32(ny))
}

/// Reflects `v` about the surface whose normal (not necessarily unit) is `n`.
pub(super) fn reflect(v: (i32, i32), n: V) -> (i32, i32) {
    let (vx, vy) = (i64::from(v.0), i64::from(v.1));
    let nn = n.len2();
    if nn == 0 {
        return (-v.0, -v.1);
    }
    let dot = vx * n.x + vy * n.y;
    renormalize(vx - 2 * dot * n.x / nn, vy - 2 * dot * n.y / nn)
}

/// Launch velocity for an aim (tenths of a degree). Screen y grows downward.
pub(super) fn aim_velocity(aim: u16) -> (i32, i32) {
    let i = usize::from(aim.clamp(AIM_MIN, AIM_MAX));
    let speed = i64::from(SPEED);
    (
        to_i32(i64::from(COS[i]) * speed / TRIG_SCALE),
        to_i32(-i64::from(SIN[i]) * speed / TRIG_SCALE),
    )
}

/// Rotates a velocity by `tenths` of a degree (positive = counter-clockwise on screen).
pub(super) fn rotate(v: (i32, i32), tenths: i32) -> (i32, i32) {
    let i = usize::try_from(tenths.unsigned_abs())
        .unwrap_or(0)
        .min(1800);
    let c = i64::from(COS[i]);
    let s = i64::from(SIN[i]) * i64::from(tenths.signum());
    let (x, y) = (i64::from(v.0), i64::from(v.1));
    // Screen y points down, so counter-clockwise uses (+s) on x and (-s) on y.
    renormalize((x * c + y * s) / TRIG_SCALE, (-x * s + y * c) / TRIG_SCALE)
}

pub(super) fn to_i32(v: i64) -> i32 {
    i32::try_from(v).unwrap_or(if v < 0 { i32::MIN } else { i32::MAX })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn straight_up_aim_points_up() {
        let (vx, vy) = aim_velocity(900);
        assert_eq!(vx, 0);
        assert_eq!(vy, -SPEED);
    }

    #[test]
    fn reflect_off_flat_floor_flips_vy() {
        let v = aim_velocity(450);
        let r = reflect((v.0, -v.1), V::new(0, -100));
        assert_eq!(r.0, v.0);
        assert_eq!(r.1, v.1);
    }

    #[test]
    fn speed_is_preserved_within_rounding() {
        for aim in (AIM_MIN..=AIM_MAX).step_by(37) {
            let v = rotate(aim_velocity(aim), 123);
            let len = isqrt(u64::try_from(i64::from(v.0).pow(2) + i64::from(v.1).pow(2)).unwrap());
            assert!(
                (i64::try_from(len).unwrap() - i64::from(SPEED)).abs() <= 2,
                "aim {aim}: {len}"
            );
        }
    }

    #[test]
    fn inside_detection_for_triangle() {
        let (poly, n) = polygon(Shape::TriBl, 0, 0);
        let near_corner = V::new(i64::from(CELL) / 5, i64::from(CELL) * 4 / 5);
        let far_corner = V::new(i64::from(CELL) * 4 / 5, i64::from(CELL) / 5);
        assert!(closest_on_polygon(near_corner, &poly[..n]).1);
        assert!(!closest_on_polygon(far_corner, &poly[..n]).1);
    }
}
