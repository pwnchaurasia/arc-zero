//! TraceOut pictures (decision 2026-11-04: every level from 4 forms one, like the
//! reference apps). Each is a silhouette built from simple shapes in code, no art
//! files: `inside(name, x, y)` with x across -1..1 and y up -1.4..1.4 (boards are
//! about 1.4 times taller than wide, so the shapes keep their proportions).

/// In the order they first appear: bold, chunky shapes on the small early boards,
/// thinner details (spikes, handles, ears) once boards are big enough to draw them.
pub const PICTURES: [&str; 20] = [
    "heart",
    "apple",
    "house",
    "ghost",
    "mushroom",
    "fish",
    "bell",
    "cat",
    "cup",
    "diamond",
    "rabbit",
    "tree",
    "paw",
    "butterfly",
    "crown",
    "moon",
    "leaf",
    "rocket",
    "star",
    "umbrella",
];

fn ellipse(x: f64, y: f64, cx: f64, cy: f64, rx: f64, ry: f64) -> bool {
    let (dx, dy) = ((x - cx) / rx, (y - cy) / ry);
    dx * dx + dy * dy <= 1.0
}

fn circle(x: f64, y: f64, cx: f64, cy: f64, r: f64) -> bool {
    ellipse(x, y, cx, cy, r, r)
}

fn rect(x: f64, y: f64, x0: f64, y0: f64, x1: f64, y1: f64) -> bool {
    (x0..=x1).contains(&x) && (y0..=y1).contains(&y)
}

/// Even-odd point-in-polygon.
fn poly(x: f64, y: f64, pts: &[(f64, f64)]) -> bool {
    let mut inside = false;
    let mut j = pts.len() - 1;
    for i in 0..pts.len() {
        let (xi, yi) = pts[i];
        let (xj, yj) = pts[j];
        if (yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

fn star(x: f64, y: f64, cx: f64, cy: f64, outer: f64, inner: f64) -> bool {
    let pts: Vec<(f64, f64)> = (0..10)
        .map(|k| {
            let a = std::f64::consts::FRAC_PI_2 + f64::from(k) * std::f64::consts::PI / 5.0;
            let r = if k % 2 == 0 { outer } else { inner };
            (cx + r * a.cos(), cy + r * a.sin())
        })
        .collect();
    poly(x, y, &pts)
}

/// Whether `(x, y)` lies inside picture `name` (unknown names fill everything).
#[must_use]
pub fn inside(name: &str, x: f64, y: f64) -> bool {
    match name {
        "heart" => {
            let (x, y) = (x * 1.15, y * 0.95 + 0.15);
            (x * x + y * y - 1.0).powi(3) - x * x * y.powi(3) <= 0.0
        }
        "star" => star(x, y, 0.0, -0.05, 1.05, 0.55),
        "apple" => {
            circle(x, y, -0.33, -0.2, 0.68)
                || circle(x, y, 0.33, -0.2, 0.68)
                || rect(x, y, -0.1, 0.4, 0.1, 0.95)
                || ellipse(x, y, 0.32, 0.75, 0.3, 0.14)
        }
        "house" => {
            rect(x, y, -0.75, -1.25, 0.75, 0.15)
                || poly(x, y, &[(-1.0, 0.1), (0.0, 1.15), (1.0, 0.1)])
                || rect(x, y, 0.4, 0.4, 0.62, 1.05)
        }
        "mushroom" => {
            (y >= 0.0 && ellipse(x, y, 0.0, 0.0, 1.0, 1.0))
                || rect(x, y, -0.35, -1.25, 0.35, 0.05)
                || ellipse(x, y, 0.0, -1.25, 0.5, 0.15)
        }
        "fish" => {
            ellipse(x, y, -0.2, 0.0, 0.72, 0.62)
                || poly(x, y, &[(0.4, 0.0), (1.0, 0.55), (1.0, -0.55)])
                || poly(x, y, &[(-0.35, 0.5), (0.05, 0.95), (0.15, 0.45)])
        }
        "cat" => {
            ellipse(x, y, 0.0, -0.75, 0.8, 0.62)
                || circle(x, y, 0.0, 0.25, 0.62)
                || poly(x, y, &[(-0.6, 0.45), (-0.5, 1.2), (-0.1, 0.75)])
                || poly(x, y, &[(0.6, 0.45), (0.5, 1.2), (0.1, 0.75)])
        }
        "tree" => {
            rect(x, y, -0.18, -1.35, 0.18, -0.65)
                || poly(x, y, &[(-1.0, -0.75), (0.0, 0.1), (1.0, -0.75)])
                || poly(x, y, &[(-0.8, -0.15), (0.0, 0.7), (0.8, -0.15)])
                || poly(x, y, &[(-0.6, 0.45), (0.0, 1.3), (0.6, 0.45)])
        }
        "bell" => {
            ellipse(x, y, 0.0, 0.25, 0.68, 0.95)
                || poly(
                    x,
                    y,
                    &[(-0.68, 0.0), (-0.98, -0.75), (0.98, -0.75), (0.68, 0.0)],
                )
                || circle(x, y, 0.0, -1.0, 0.24)
                || circle(x, y, 0.0, 1.22, 0.14)
        }
        "cup" => {
            rect(x, y, -0.8, -0.85, 0.45, 0.65)
                || (circle(x, y, 0.62, -0.1, 0.42) && !circle(x, y, 0.62, -0.1, 0.2))
                || ellipse(x, y, -0.15, -1.0, 1.0, 0.2)
                || ellipse(x, y, -0.3, 1.0, 0.1, 0.22)
                || ellipse(x, y, 0.0, 1.15, 0.1, 0.22)
        }
        "rabbit" => {
            circle(x, y, 0.0, -0.55, 0.68)
                || ellipse(x, y, -0.32, 0.6, 0.2, 0.68)
                || ellipse(x, y, 0.32, 0.6, 0.2, 0.68)
                || ellipse(x, y, 0.0, -1.2, 0.45, 0.18)
        }
        "crown" => {
            rect(x, y, -0.95, -0.85, 0.95, -0.15)
                || poly(
                    x,
                    y,
                    &[
                        (-0.95, -0.2),
                        (-0.95, 0.7),
                        (-0.48, 0.15),
                        (0.0, 0.95),
                        (0.48, 0.15),
                        (0.95, 0.7),
                        (0.95, -0.2),
                    ],
                )
                || circle(x, y, -0.95, 0.78, 0.14)
                || circle(x, y, 0.0, 1.05, 0.16)
                || circle(x, y, 0.95, 0.78, 0.14)
        }
        "ghost" => {
            let body = circle(x, y, 0.0, 0.25, 0.85) || rect(x, y, -0.85, -1.1, 0.85, 0.25);
            // A wavy hem: bites taken out of the bottom edge.
            let hem = [-0.57, 0.0, 0.57]
                .iter()
                .any(|cx| circle(x, y, *cx, -1.18, 0.2));
            body && !hem
        }
        "umbrella" => {
            // A dome with scalloped edges, a shaft and a hooked handle.
            (y >= 0.1
                && circle(x, y, 0.0, 0.1, 1.0)
                && ![-0.66, 0.0, 0.66]
                    .iter()
                    .any(|cx| circle(x, y, *cx, 0.1, 0.33)))
                || rect(x, y, -0.14, -1.05, 0.14, 0.15)
                || (circle(x, y, -0.3, -1.05, 0.44)
                    && !circle(x, y, -0.3, -1.05, 0.16)
                    && y <= -1.05)
        }
        "butterfly" => {
            ellipse(x, y, -0.5, 0.45, 0.48, 0.6)
                || ellipse(x, y, 0.5, 0.45, 0.48, 0.6)
                || ellipse(x, y, -0.4, -0.5, 0.38, 0.48)
                || ellipse(x, y, 0.4, -0.5, 0.38, 0.48)
                || ellipse(x, y, 0.0, 0.0, 0.12, 0.95)
        }
        "rocket" => {
            ellipse(x, y, 0.0, 0.2, 0.42, 1.15)
                || poly(x, y, &[(-0.4, -0.25), (-0.85, -0.95), (-0.3, -0.75)])
                || poly(x, y, &[(0.4, -0.25), (0.85, -0.95), (0.3, -0.75)])
                || poly(x, y, &[(-0.2, -0.9), (0.0, -1.35), (0.2, -0.9)])
        }
        "paw" => {
            ellipse(x, y, 0.0, -0.55, 0.62, 0.52)
                || ellipse(x, y, -0.68, 0.15, 0.24, 0.3)
                || ellipse(x, y, -0.25, 0.6, 0.24, 0.32)
                || ellipse(x, y, 0.25, 0.6, 0.24, 0.32)
                || ellipse(x, y, 0.68, 0.15, 0.24, 0.3)
        }
        "moon" => circle(x, y, 0.0, 0.0, 1.0) && !circle(x, y, 0.45, 0.3, 0.82),
        "leaf" => {
            (circle(x, y, -0.55, 0.0, 1.05) && circle(x, y, 0.55, 0.0, 1.05) && y > -1.0)
                || rect(x, y, -0.12, -1.3, 0.12, -0.8)
        }
        "diamond" => poly(
            x,
            y,
            &[
                (-1.0, 0.45),
                (-0.55, 0.95),
                (0.55, 0.95),
                (1.0, 0.45),
                (0.0, -1.2),
            ],
        ),
        _ => true,
    }
}
