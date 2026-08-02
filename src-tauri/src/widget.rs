use serde::Serialize;
use serde_json::Value;

const MAX_VISIBLE_ITEMS: usize = 4;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WidgetSnapshot {
    pub(crate) date: String,
    pub(crate) has_plan: bool,
    pub(crate) unavailable: bool,
    pub(crate) title: String,
    pub(crate) reminder: String,
    pub(crate) done: usize,
    pub(crate) total: usize,
    pub(crate) items: Vec<String>,
}

impl WidgetSnapshot {
    pub(crate) fn empty(date: &str) -> Self {
        Self {
            date: date.to_string(),
            has_plan: false,
            unavailable: false,
            title: "Today".to_string(),
            reminder: String::new(),
            done: 0,
            total: 0,
            items: Vec::new(),
        }
    }

    #[cfg(target_os = "android")]
    pub(crate) fn unavailable(date: &str) -> Self {
        Self {
            unavailable: true,
            ..Self::empty(date)
        }
    }
}

pub(crate) fn snapshot_from_plan(date: &str, plan: Option<&Value>) -> WidgetSnapshot {
    let Some(plan) = plan else {
        return WidgetSnapshot::empty(date);
    };

    let mut all_items = Vec::new();
    if let Some(items) = plan.get("items").and_then(Value::as_array) {
        flatten_items(items, &mut all_items);
    }

    let total = all_items.len();
    let done = all_items.iter().filter(|(_, done)| *done).count();
    let items = all_items
        .into_iter()
        .filter_map(|(text, done)| (!done).then_some(text))
        .take(MAX_VISIBLE_ITEMS)
        .collect();

    WidgetSnapshot {
        date: date.to_string(),
        has_plan: true,
        unavailable: false,
        title: plan
            .get("title")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|title| !title.is_empty())
            .unwrap_or("Today's plan")
            .to_string(),
        reminder: plan
            .get("dailyReminder")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_string(),
        done,
        total,
        items,
    }
}

fn flatten_items(items: &[Value], output: &mut Vec<(String, bool)>) {
    for item in items {
        let text = item
            .get("text")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        if !text.is_empty() {
            output.push((
                text.to_string(),
                item.get("done").and_then(Value::as_bool).unwrap_or(false),
            ));
        }
        if let Some(children) = item.get("children").and_then(Value::as_array) {
            flatten_items(children, output);
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::snapshot_from_plan;

    #[test]
    fn widget_snapshot_flattens_pending_items_and_counts_progress() {
        let plan = json!({
            "title": "  Launch day  ",
            "dailyReminder": "  Ship calmly  ",
            "items": [
                {
                    "text": "Done first",
                    "done": true,
                    "children": [
                        { "text": "Nested pending", "done": false, "children": [] }
                    ]
                },
                { "text": "Second", "done": false, "children": [] },
                { "text": "", "done": false, "children": [] },
                { "text": "Third", "done": false, "children": [] },
                { "text": "Fourth", "done": false, "children": [] },
                { "text": "Fifth hidden", "done": false, "children": [] }
            ]
        });

        let snapshot = snapshot_from_plan("2026-08-01", Some(&plan));

        assert!(snapshot.has_plan);
        assert_eq!(snapshot.title, "Launch day");
        assert_eq!(snapshot.reminder, "Ship calmly");
        assert_eq!(snapshot.done, 1);
        assert_eq!(snapshot.total, 6);
        assert_eq!(
            snapshot.items,
            ["Nested pending", "Second", "Third", "Fourth"]
        );
    }

    #[test]
    fn widget_snapshot_handles_a_missing_plan() {
        let snapshot = snapshot_from_plan("2026-08-01", None);

        assert!(!snapshot.has_plan);
        assert!(!snapshot.unavailable);
        assert_eq!(snapshot.title, "Today");
        assert!(snapshot.items.is_empty());
    }
}
