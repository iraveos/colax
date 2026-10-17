//! The manual card order: what a drag actually changes (Task 8.5).
//!
//! Port of `moveManualOrder` in `E:\acc2\src\vault\channels.ts` L404-435. The
//! interesting half is that the first drag in a view has to *seed* the order
//! from what is on screen, because a brand-new vault has never stored one.
//! Seeding from the visible ids (then the title-sorted tail) is what lets a
//! drop in one channel keep every untouched pair in the same relative place
//! everywhere else.

use std::collections::HashSet;

/// Drops one login id at a position in the current view's flat order and
/// returns the new global manual order.
///
/// `to_index` is a slot in `visible_ids` *after* removing `login_id` -- the
/// view computes it from the drop indicator, so what you aim at is what you
/// get. Ids the order has never seen are seeded first (visible ids in view
/// order, then `all_ids`), so the first drag in any view starts from what is
/// on screen and untouched pairs keep their relative positions everywhere.
/// Pass `all_ids` title-sorted so the seeded tail reads sensibly.
pub fn move_manual_order(
    current: &[String],
    visible_ids: &[String],
    all_ids: &[String],
    login_id: &str,
    to_index: i32,
) -> Vec<String> {
    let known: HashSet<&str> = all_ids.iter().map(String::as_str).collect();
    let mut base: Vec<String> = current
        .iter()
        .filter(|id| known.contains(id.as_str()) && id.as_str() != login_id)
        .cloned()
        .collect();
    for id in visible_ids {
        if id.as_str() != login_id
            && known.contains(id.as_str())
            && !base.iter().any(|known| known == id)
        {
            base.push(id.clone());
        }
    }
    for id in all_ids {
        if id.as_str() != login_id && !base.iter().any(|known| known == id) {
            base.push(id.clone());
        }
    }

    let rest: Vec<&String> = visible_ids
        .iter()
        .filter(|id| id.as_str() != login_id)
        .collect();
    let slot = to_index.clamp(0, rest.len() as i32) as usize;
    let Some(anchor) = rest.get(slot) else {
        base.push(login_id.to_string());
        return base;
    };
    match base.iter().position(|known| known == *anchor) {
        Some(at) => {
            base.insert(at, login_id.to_string());
            base
        }
        None => {
            base.push(login_id.to_string());
            base
        }
    }
}

#[cfg(test)]
mod tests {
    use super::move_manual_order;

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|id| (*id).to_string()).collect()
    }

    #[test]
    fn a_login_drag_lands_on_the_aimed_slot() {
        // View order a,b,c -- drag c before a.
        assert_eq!(
            move_manual_order(&ids(&["a", "b", "c"]), &ids(&["a", "b", "c"]), &ids(&["a", "b", "c"]), "c", 0),
            ids(&["c", "a", "b"])
        );
        // After the last row appends.
        assert_eq!(
            move_manual_order(&ids(&["a", "b", "c"]), &ids(&["a", "b", "c"]), &ids(&["a", "b", "c"]), "a", 5),
            ids(&["b", "c", "a"])
        );
    }

    #[test]
    fn the_first_drag_seeds_from_the_screen() {
        // Nothing ordered yet: the view order becomes the order, minus the move.
        assert_eq!(
            move_manual_order(&[], &ids(&["b", "a", "d"]), &ids(&["a", "b", "c", "d"]), "d", 0),
            ids(&["d", "b", "a", "c"])
        );
        // Ids outside the view stay where they were, relative order kept.
        assert_eq!(
            move_manual_order(&ids(&["x", "y"]), &ids(&["a", "b"]), &ids(&["a", "b", "x", "y"]), "b", 0),
            ids(&["x", "y", "b", "a"])
        );
    }

    #[test]
    fn unknown_and_dead_ids_never_corrupt_the_order() {
        assert_eq!(
            move_manual_order(&ids(&["a", "gone"]), &ids(&["a", "b"]), &ids(&["a", "b"]), "b", 0),
            ids(&["b", "a"])
        );
    }

    #[test]
    fn negative_and_past_the_end_slots_are_clamped() {
        // The view clamps too, but a stale indicator must not panic here.
        assert_eq!(
            move_manual_order(&ids(&["a", "b"]), &ids(&["a", "b"]), &ids(&["a", "b"]), "a", -3),
            ids(&["a", "b"])
        );
        assert_eq!(
            move_manual_order(&ids(&["a", "b"]), &ids(&["a", "b"]), &ids(&["a", "b"]), "a", 99),
            ids(&["b", "a"])
        );
    }

    #[test]
    fn dropping_before_its_own_successor_is_a_no_op() {
        // The `moveLogin` guard in App.tsx L1072 depends on this: the same
        // order in means the same order out, so nothing is saved or toasted.
        let order = ids(&["a", "b", "c"]);
        assert_eq!(
            move_manual_order(&order, &order, &order, "a", 0),
            order,
            "a drop onto itself/before b must not reorder anything"
        );
    }
}
