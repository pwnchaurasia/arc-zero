//! Deterministic game rules for the Arc Zero arcade.
//!
//! The same code is compiled to WebAssembly for the browser and to a native
//! Python extension for the API server. The server re-runs every move with this
//! crate, so it is the single source of truth for what a legal game is.
//!
//! Determinism rules (do not break them):
//! - No floating point in any simulation path. Fixed-point integers only.
//! - No `HashMap` iteration order in outputs, no system time, no OS randomness.
//! - All randomness comes from [`rng::Rng`] seeded by the caller.

pub mod brick_blast;
pub mod hash;
pub mod rng;
pub mod water_sort;

/// Integer square root (floor). Deterministic on every target.
#[must_use]
pub fn isqrt(n: u64) -> u64 {
    if n < 2 {
        return n;
    }
    // Initial guess from the bit length, then Newton iterations.
    let shift = (64 - n.leading_zeros()).div_ceil(2);
    let mut x = 1u64 << shift;
    loop {
        let y = (x + n / x) >> 1;
        if y >= x {
            return x;
        }
        x = y;
    }
}

#[cfg(test)]
mod tests {
    use super::isqrt;

    #[test]
    fn isqrt_matches_floor_sqrt() {
        for n in 0..10_000u64 {
            let r = isqrt(n);
            assert!(r * r <= n && (r + 1) * (r + 1) > n, "n={n} r={r}");
        }
        for n in [u64::from(u32::MAX), 1 << 40, (1 << 62) + 12345] {
            let r = isqrt(n);
            assert!(r * r <= n && (r + 1).checked_mul(r + 1).is_none_or(|s| s > n));
        }
    }
}
