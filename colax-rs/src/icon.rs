//! Vector icons, drawn rather than typed.
//!
//! The Electron build used inline SVGs; the native port can't rely on an icon
//! font being installed, and a missing glyph shows as a box. Every icon here is
//! a handful of lines and arcs at the requested size, so it stays crisp at 12px
//! in a button and at 22px in the rail.

use egui::{vec2, Color32, Painter, Pos2, Rect, Rounding, Shape, Stroke};

pub fn draw(painter: &Painter, name: &str, rect: Rect, color: Color32, width: f32) {
    let stroke = Stroke::new(width.max(1.0), color);
    let center = rect.center();
    let size = rect.width().min(rect.height());
    let r = size * 0.5;
    let line = |from: Pos2, to: Pos2| painter.add(Shape::line_segment([from, to], stroke));
    let polyline = |points: Vec<Pos2>| painter.add(Shape::line(points, stroke));
    let circle = |center: Pos2, radius: f32| painter.add(Shape::circle_stroke(center, radius, stroke));
    let square = |center: Pos2, half: f32, rounding: f32| {
        painter.rect_stroke(
            Rect::from_center_size(center, vec2(half * 2.0, half * 2.0)),
            Rounding::same(rounding),
            stroke,
        )
    };

    match name {
        "search" => {
            circle(center - vec2(r * 0.18, r * 0.18), r * 0.55);
            line(center + vec2(r * 0.24, r * 0.24), center + vec2(r * 0.72, r * 0.72));
        }
        "plus" => {
            line(center - vec2(r * 0.6, 0.0), center + vec2(r * 0.6, 0.0));
            line(center - vec2(0.0, r * 0.6), center + vec2(0.0, r * 0.6));
        }
        "close" => {
            line(center - vec2(r * 0.5, r * 0.5), center + vec2(r * 0.5, r * 0.5));
            line(center + vec2(r * 0.5, -r * 0.5), center + vec2(-r * 0.5, r * 0.5));
        }
        "check" => {
            polyline(vec![center - vec2(r * 0.55, 0.0), center - vec2(r * 0.12, r * 0.45), center + vec2(r * 0.6, -r * 0.45)]);
        }
        "lock" => {
            painter.rect_stroke(
                Rect::from_center_size(center + vec2(0.0, r * 0.22), vec2(size * 0.66, size * 0.5)),
                Rounding::same(size * 0.12),
                stroke,
            );
            polyline(vec![
                center + vec2(-r * 0.36, -r * 0.05),
                center + vec2(-r * 0.36, -r * 0.36),
                center + vec2(-r * 0.18, -r * 0.62),
                center + vec2(r * 0.18, -r * 0.62),
                center + vec2(r * 0.36, -r * 0.36),
                center + vec2(r * 0.36, -r * 0.05),
            ]);
        }
        "unlock" => {
            painter.rect_stroke(
                Rect::from_center_size(center + vec2(0.0, r * 0.22), vec2(size * 0.66, size * 0.5)),
                Rounding::same(size * 0.12),
                stroke,
            );
            polyline(vec![
                center + vec2(-r * 0.36, -r * 0.05),
                center + vec2(-r * 0.36, -r * 0.36),
                center + vec2(-r * 0.18, -r * 0.62),
                center + vec2(r * 0.3, -r * 0.62),
            ]);
        }
        "key" => {
            circle(center - vec2(r * 0.35, -r * 0.35), r * 0.3);
            line(center - vec2(r * 0.14, -r * 0.14), center + vec2(r * 0.6, r * 0.6));
            line(center + vec2(r * 0.28, r * 0.28), center + vec2(r * 0.5, r * 0.06));
            line(center + vec2(r * 0.46, r * 0.46), center + vec2(r * 0.68, r * 0.24));
        }
        "star" => {
            let mut points = Vec::new();
            for index in 0..10 {
                let radius = if index % 2 == 0 { r * 0.68 } else { r * 0.3 };
                let angle = -std::f32::consts::FRAC_PI_2 + index as f32 * std::f32::consts::PI / 5.0;
                points.push(center + vec2(angle.cos(), angle.sin()) * radius);
            }
            points.push(points[0]);
            painter.add(Shape::line(points, stroke));
        }
        "grid" => {
            for x in [-1.0f32, 1.0] {
                for y in [-1.0f32, 1.0] {
                    square(center + vec2(x * r * 0.36, y * r * 0.36), r * 0.24, r * 0.08);
                }
            }
        }
        "list" => {
            for index in -1..=1 {
                let y = index as f32 * r * 0.42;
                circle(center + vec2(-r * 0.6, y), r * 0.07);
                line(center + vec2(-r * 0.32, y), center + vec2(r * 0.68, y));
            }
        }
        "cards" => {
            painter.rect_stroke(
                Rect::from_center_size(center + vec2(r * 0.12, r * 0.12), vec2(size * 0.62, size * 0.62)),
                Rounding::same(size * 0.12),
                stroke,
            );
            polyline(vec![
                center + vec2(-r * 0.5, r * 0.36),
                center + vec2(-r * 0.5, -r * 0.4),
                center + vec2(-r * 0.12, -r * 0.66),
                center + vec2(r * 0.4, -r * 0.66),
            ]);
        }
        "settings" => {
            for index in -1..=1 {
                let y = index as f32 * r * 0.45;
                line(center + vec2(-r * 0.7, y), center + vec2(r * 0.7, y));
                circle(center + vec2(index as f32 * r * 0.22, y), r * 0.14);
            }
        }
        "user" => {
            circle(center + vec2(0.0, -r * 0.3), r * 0.3);
            polyline(vec![
                center + vec2(-r * 0.66, r * 0.62),
                center + vec2(-r * 0.46, r * 0.2),
                center + vec2(0.0, r * 0.02),
                center + vec2(r * 0.46, r * 0.2),
                center + vec2(r * 0.66, r * 0.62),
            ]);
        }
        "mail" => {
            painter.rect_stroke(
                Rect::from_center_size(center, vec2(size * 0.8, size * 0.6)),
                Rounding::same(size * 0.08),
                stroke,
            );
            polyline(vec![
                center + vec2(-r * 0.4, -r * 0.3),
                center + vec2(0.0, r * 0.02),
                center + vec2(r * 0.4, -r * 0.3),
            ]);
        }
        "copy" => {
            painter.rect_stroke(
                Rect::from_center_size(center + vec2(r * 0.12, r * 0.12), vec2(size * 0.56, size * 0.56)),
                Rounding::same(size * 0.1),
                stroke,
            );
            polyline(vec![
                center + vec2(-r * 0.14, -r * 0.16),
                center + vec2(-r * 0.3, -r * 0.16),
                center + vec2(-r * 0.3, -r * 0.3),
                center + vec2(-r * 0.16, -r * 0.3),
            ]);
        }
        "eye" => {
            polyline(vec![
                center + vec2(-r * 0.7, 0.0),
                center + vec2(-r * 0.25, -r * 0.4),
                center + vec2(r * 0.25, -r * 0.4),
                center + vec2(r * 0.7, 0.0),
                center + vec2(r * 0.25, r * 0.4),
                center + vec2(-r * 0.25, r * 0.4),
                center + vec2(-r * 0.7, 0.0),
            ]);
            circle(center, r * 0.18);
        }
        "folder" => {
            polyline(vec![
                center + vec2(-r * 0.7, r * 0.5),
                center + vec2(-r * 0.7, -r * 0.45),
                center + vec2(-r * 0.2, -r * 0.45),
                center + vec2(-r * 0.05, -r * 0.25),
                center + vec2(r * 0.7, -r * 0.25),
                center + vec2(r * 0.7, r * 0.5),
                center + vec2(-r * 0.7, r * 0.5),
            ]);
        }
        "tag" => {
            polyline(vec![
                center + vec2(-r * 0.6, r * 0.6),
                center + vec2(-r * 0.6, -r * 0.1),
                center + vec2(0.0, -r * 0.62),
                center + vec2(r * 0.62, 0.0),
                center + vec2(0.0, r * 0.6),
                center + vec2(-r * 0.6, r * 0.6),
            ]);
            circle(center + vec2(-r * 0.24, -r * 0.24), r * 0.08);
        }
        "chevron" => {
            polyline(vec![
                center + vec2(-r * 0.4, -r * 0.2),
                center + vec2(0.0, r * 0.2),
                center + vec2(r * 0.4, -r * 0.2),
            ]);
        }
        "chevron-left" => {
            polyline(vec![
                center + vec2(r * 0.2, -r * 0.4),
                center + vec2(-r * 0.2, 0.0),
                center + vec2(r * 0.2, r * 0.4),
            ]);
        }
        "trash" => {
            line(center + vec2(-r * 0.55, -r * 0.45), center + vec2(r * 0.55, -r * 0.45));
            line(center + vec2(-r * 0.2, -r * 0.62), center + vec2(r * 0.2, -r * 0.62));
            polyline(vec![
                center + vec2(-r * 0.42, -r * 0.3),
                center + vec2(-r * 0.32, r * 0.6),
                center + vec2(r * 0.32, r * 0.6),
                center + vec2(r * 0.42, -r * 0.3),
            ]);
            line(center + vec2(-r * 0.12, -r * 0.2), center + vec2(-r * 0.12, r * 0.42));
            line(center + vec2(r * 0.12, -r * 0.2), center + vec2(r * 0.12, r * 0.42));
        }
        "external" => {
            painter.rect_stroke(
                Rect::from_center_size(center + vec2(-r * 0.14, r * 0.14), vec2(size * 0.62, size * 0.62)),
                Rounding::same(size * 0.08),
                stroke,
            );
            line(center + vec2(r * 0.08, -r * 0.08), center + vec2(r * 0.66, -r * 0.66));
            polyline(vec![
                center + vec2(r * 0.3, -r * 0.66),
                center + vec2(r * 0.66, -r * 0.66),
                center + vec2(r * 0.66, -r * 0.3),
            ]);
        }
        "clock" => {
            circle(center, r * 0.62);
            line(center, center + vec2(0.0, -r * 0.36));
            line(center, center + vec2(r * 0.3, r * 0.16));
        }
        "refresh" => {
            let radius = r * 0.55;
            polyline(vec![
                center + vec2(-radius, 0.0),
                center + vec2(-radius * 0.7, -radius * 0.7),
                center + vec2(0.0, -radius),
                center + vec2(radius * 0.7, -radius * 0.7),
                center + vec2(radius, 0.0),
                center + vec2(radius * 0.6, radius * 0.7),
                center + vec2(0.0, radius),
            ]);
            polyline(vec![
                center + vec2(-radius, 0.0),
                center + vec2(-radius * 0.62, -r * 0.24),
                center + vec2(-r * 0.34, -r * 0.06),
            ]);
        }
        "shield" => {
            polyline(vec![
                center + vec2(0.0, -r * 0.68),
                center + vec2(r * 0.6, -r * 0.42),
                center + vec2(r * 0.5, r * 0.2),
                center + vec2(0.0, r * 0.68),
                center + vec2(-r * 0.5, r * 0.2),
                center + vec2(-r * 0.6, -r * 0.42),
                center + vec2(0.0, -r * 0.68),
            ]);
        }
        "inbox" => {
            polyline(vec![
                center + vec2(-r * 0.68, r * 0.5),
                center + vec2(-r * 0.68, -r * 0.3),
                center + vec2(-r * 0.4, -r * 0.55),
                center + vec2(r * 0.4, -r * 0.55),
                center + vec2(r * 0.68, -r * 0.3),
                center + vec2(r * 0.68, r * 0.5),
                center + vec2(-r * 0.68, r * 0.5),
            ]);
            polyline(vec![
                center + vec2(-r * 0.68, r * 0.02),
                center + vec2(-r * 0.2, r * 0.02),
                center + vec2(0.0, r * 0.24),
                center + vec2(r * 0.2, r * 0.02),
                center + vec2(r * 0.68, r * 0.02),
            ]);
        }
        "alert" => {
            polyline(vec![
                center + vec2(0.0, -r * 0.62),
                center + vec2(r * 0.62, r * 0.5),
                center + vec2(-r * 0.62, r * 0.5),
                center + vec2(0.0, -r * 0.62),
            ]);
            line(center + vec2(0.0, -r * 0.12), center + vec2(0.0, r * 0.2));
            circle(center + vec2(0.0, r * 0.36), r * 0.05);
        }
        "dock" => {
            painter.rect_stroke(
                Rect::from_center_size(center, vec2(size * 0.8, size * 0.46)),
                Rounding::same(size * 0.18),
                stroke,
            );
            for index in -1..=1 {
                circle(center + vec2(index as f32 * r * 0.24, 0.0), r * 0.07);
            }
        }
        "channel" | "dot" => {
            circle(center, r * 0.34);
        }
        _ => {
            circle(center, r * 0.3);
        }
    }
}
