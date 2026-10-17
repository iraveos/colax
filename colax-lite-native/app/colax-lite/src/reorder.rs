//! Drag-reorder for the login views (Task 8.5).
//!
//! Port of `useLoginReorder` in `views.tsx` L165-435 and `moveLogin` in
//! `App.tsx` L1061-1086.
//!
//! The gesture itself lives in Slint (`list-row` and `card-face`), because
//! that is where the pointer is. What lives here is the part the browser used
//! `elementFromPoint` for: *which slot is the pointer over?*
//!
//! Slint has no cross-sibling hit-testing -- a `TouchArea` that took the press
//! keeps every move until release, and there is no way to ask what is under
//! the pointer. So the answer is arithmetic instead: all three reorderable
//! views are uniform (List rows are a fixed height, Flow rows are the same
//! rows, Grid cells are one cell size), and the dragged row knows its own
//! rectangle. Rust keeps that rectangle and the packing constants, replays the
//! layout for every candidate card, and picks the nearest one. Group headers
//! are the one wrinkle, and the card model already carries them.
//!
//! What the TS gets from the DOM and this does not: a ghost clone, edge
//! auto-scroll, and the 400ms click suppression. The drag shows the source row
//! dimmed and a bright insertion bar at the target instead of a ghost, and the
//! click is swallowed by the row itself (`swallow`). Auto-scroll is not
//! implemented: it needs the enclosing `ListView`'s viewport, which a delegate
//! cannot reach.

use slint::{ComponentHandle, Model};

use crate::items;
use crate::settings_ops;
use crate::MainWindow;
use crate::Shared;

/// One in-flight drag: where it started, how the view is packed, and the
/// pointer's own starting point. Everything is logical pixels (Slint
/// `absolute-position`, `/1px`), the same units the prefs' card geometry uses.
#[derive(Clone, Debug)]
pub struct Drag {
    pub from: usize,
    pub count: usize,
    /// The pressed card's top-left and size, in window coordinates.
    pub origin_x: f32,
    pub origin_y: f32,
    pub item_w: f32,
    pub item_h: f32,
    /// The pointer, where the press landed.
    pub press_x: f32,
    pub press_y: f32,
    /// The dead space between cards: 2px in List, 0 in Flow, 10 in Grid.
    pub gap: f32,
    /// Grid cells sit in rows of `cols`, so the slot reads both axes.
    pub cols: usize,
    pub grid: bool,
    /// `headers[i]` is true when card `i` is preceded by a List letter header.
    /// Flow draws no headers, and Grid has no rows to head.
    pub headers: Vec<bool>,
}

impl Drag {
    /// The top of card `i`, replayed from the pressed card's own rectangle.
    /// Only *differences* matter, so whatever the enclosing list has scrolled
    /// to cancels out.
    fn top_of(&self, i: usize) -> f32 {
        let mut y = self.origin_y;
        if i >= self.from {
            for j in self.from + 1..=i {
                y += self.item_h + self.gap;
                if self.headers.get(j).copied().unwrap_or(false) {
                    y += HEADER_H + self.gap;
                }
            }
        } else {
            for j in i + 1..=self.from {
                y -= self.item_h + self.gap;
                if self.headers.get(j).copied().unwrap_or(false) {
                    y -= HEADER_H + self.gap;
                }
            }
        }
        y
    }

    /// The left of grid cell `i`, replayed the same way.
    fn left_of(&self, i: usize) -> f32 {
        let from_col = (self.from % self.cols) as i32;
        let col = (i % self.cols) as i32;
        self.origin_x + (col - from_col) as f32 * (self.item_w + self.gap)
    }

    fn cell_top(&self, i: usize) -> f32 {
        let from_row = (self.from / self.cols) as i32;
        let row = (i / self.cols) as i32;
        self.origin_y + (row - from_row) as f32 * (self.item_h + self.gap)
    }

    /// The slot aimed at: a card id and whether the drop lands after it.
    ///
    /// List and Flow read the pointer against the card's vertical half, which
    /// is `slotOf`'s one-dimensional branch. Grid reads both axes: below the
    /// middle band inserts after, and inside the band left/right decides
    /// (`views.tsx` L307-312).
    pub fn target_at(&self, px: f32, py: f32) -> (usize, bool) {
        // The card's own top-left, dragged by the pointer.
        let virtual_top = self.origin_y + (py - self.press_y);
        let virtual_left = self.origin_x + (px - self.press_x);

        if !self.grid {
            let mut best = self.from;
            let mut best_dist = f32::MAX;
            for i in 0..self.count {
                let dist = (virtual_top - self.top_of(i)).abs();
                if dist < best_dist {
                    best_dist = dist;
                    best = i;
                }
            }
            return (best, virtual_top > self.top_of(best));
        }

        let mut best = self.from;
        let mut best_dist = f32::MAX;
        for i in 0..self.count {
            let dx = virtual_left - self.left_of(i);
            let dy = virtual_top - self.cell_top(i);
            let dist = dx * dx + dy * dy;
            if dist < best_dist {
                best_dist = dist;
                best = i;
            }
        }
        // The band rule, against the cell the pointer is actually over.
        let dx = px - (self.left_of(best) + self.item_w / 2.0);
        let dy = py - (self.cell_top(best) + self.item_h / 2.0);
        let after = dy > self.item_h / 4.0
            || (dy.abs() <= self.item_h / 4.0 && dx > 0.0);
        (best, after)
    }

    /// The insertion bar, as `(x, y, w, h)` in window coordinates: flat and
    /// full-width between List/Flow rows, upright on a Grid cell's edge.
    pub fn bar_for(&self, target: usize, after: bool) -> (f32, f32, f32, f32) {
        if !self.grid {
            let y = self.top_of(target) + if after { self.item_h - 1.0 } else { -1.0 };
            return (self.origin_x, y, self.item_w, 2.0);
        }
        let x = self.left_of(target) + if after { self.item_w - 1.0 } else { -1.0 };
        (x, self.cell_top(target), 2.0, self.item_h)
    }
}

/// A List group header's height (`if (card.group != "")` in `main.slint`).
const HEADER_H: f32 = 28.0;

fn push_drop(ui: &MainWindow, drag: &Drag, target: usize, after: bool) {
    let (x, y, w, h) = drag.bar_for(target, after);
    ui.set_reorder_drop_x(x);
    ui.set_reorder_drop_y(y);
    ui.set_reorder_drop_w(w);
    ui.set_reorder_drop_h(h);
    ui.set_reorder_drop_visible(true);
}

/// A press has been held long enough to become a drag. The card reports its
/// own rectangle; everything else is replayable from it.
pub fn begin(
    ui: &MainWindow,
    state: &Shared,
    index: usize,
    px: f32,
    py: f32,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
) {
    let cards = ui.get_cards();
    let count = cards.row_count();
    if index >= count || w <= 0.0 || h <= 0.0 {
        return;
    }
    let view = ui.get_vault_view().to_string();
    let grid = view == "grid";
    // Only List draws the letter headers; Flow shows the same rows without
    // them, so their 28px is not in the Flow layout at all.
    let headers = if view == "basic" {
        cards.iter().map(|card| !card.group.is_empty()).collect()
    } else {
        vec![false; count]
    };
    let drag = Drag {
        from: index,
        count,
        origin_x: x,
        origin_y: y,
        item_w: w,
        item_h: h,
        press_x: px,
        press_y: py,
        gap: if grid {
            10.0
        } else if view == "basic" {
            2.0
        } else {
            0.0
        },
        cols: ui.get_grid_cols().max(1) as usize,
        grid,
        headers,
    };
    state.borrow_mut().reorder_drop = None;
    push_drop(ui, &drag, index, false);
    state.borrow_mut().reorder_drag = Some(drag);
}

/// The pointer moved while a drag is in flight: recompute the slot and move
/// the bar. Over the dragged card itself the bar is hidden, exactly as the TS
/// clears its indicator for `id === dragging.current`.
pub fn moved(ui: &MainWindow, state: &Shared, px: f32, py: f32) {
    let Some(drag) = state.borrow().reorder_drag.clone() else {
        return;
    };
    let (target, after) = drag.target_at(px, py);
    if target == drag.from {
        ui.set_reorder_drop_visible(false);
        state.borrow_mut().reorder_drop = None;
        return;
    }
    push_drop(ui, &drag, target, after);
    state.borrow_mut().reorder_drop = Some((target, after));
}

/// The pointer was released (or the gesture was cancelled). A committed drag
/// writes the new manual order; a cancelled one just puts the bar away.
pub fn finish(ui: &MainWindow, state: &Shared, commit: bool) {
    let drag = state.borrow_mut().reorder_drag.take();
    let drop = state.borrow_mut().reorder_drop.take();
    ui.set_reorder_drop_visible(false);
    let (Some(drag), Some((target, after)), true) = (drag, drop, commit) else {
        return;
    };
    if target == drag.from || target >= drag.count {
        return;
    }

    // The view's flat order, which is what `toIndex` is measured against.
    let visible: Vec<String> = ui
        .get_cards()
        .iter()
        .map(|card| card.id.to_string())
        .collect();
    if drag.from >= visible.len() || target >= visible.len() {
        return;
    }
    let moved = visible[drag.from].clone();
    let target_id = visible[target].clone();
    let rest: Vec<String> = visible
        .iter()
        .filter(|id| **id != moved)
        .cloned()
        .collect();
    let to_index = match rest.iter().position(|id| *id == target_id) {
        Some(ti) => ti + usize::from(after),
        None => rest.len(),
    };

    // `byTitle` in App.tsx L1063: the title-sorted tail the seeding uses.
    let (current, by_title, first_manual) = {
        let guard = state.borrow();
        let prefs = items::prefs_from(guard.engine.preferences());
        let mut all: Vec<(String, String)> = guard
            .engine
            .items()
            .unwrap_or_default()
            .iter()
            .map(|item| {
                (
                    item.id.clone(),
                    if item.title.is_empty() {
                        "~".to_string()
                    } else {
                        item.title.to_lowercase()
                    },
                )
            })
            .collect();
        all.sort_by(|a, b| a.1.cmp(&b.1));
        (
            prefs.manual_order.clone(),
            all.into_iter().map(|(id, _)| id).collect::<Vec<_>>(),
            prefs.sort != "manual",
        )
    };

    let next = colax_core::move_manual_order(
        &current,
        &visible,
        &by_title,
        &moved,
        to_index as i32,
    );
    // A drop that changes nothing (onto itself, or before its own successor)
    // saves nothing -- least of all a toast claiming something happened.
    if !first_manual && next == current {
        return;
    }
    settings_ops::write(ui, state, |prefs| {
        prefs.manual_order = next;
        if prefs.sort != "manual" {
            prefs.sort = "manual".to_string();
        }
        true
    });
    if first_manual {
        crate::notice(ui, "Custom order saved — sorting switched to Custom");
    }
}
