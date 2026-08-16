use serde::Serialize;
use serde_json::Value;

const MAX_VISIBLE_ITEMS: usize = 10;
const DEFAULT_THEME_ID: &str = "violet";

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
    pub(crate) item_depths: Vec<usize>,
    pub(crate) item_times: Vec<String>,
    pub(crate) theme_id: String,
}

impl WidgetSnapshot {
    #[cfg(target_os = "android")]
    pub(crate) fn empty(date: &str) -> Self {
        Self::empty_for_theme(date, DEFAULT_THEME_ID)
    }

    fn empty_for_theme(date: &str, theme_id: &str) -> Self {
        Self {
            date: date.to_string(),
            has_plan: false,
            unavailable: false,
            title: "Today".to_string(),
            reminder: String::new(),
            done: 0,
            total: 0,
            items: Vec::new(),
            item_depths: Vec::new(),
            item_times: Vec::new(),
            theme_id: normalize_theme_id(theme_id).to_string(),
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

pub(crate) fn snapshot_from_plan(
    date: &str,
    plan: Option<&Value>,
    theme_id: &str,
) -> WidgetSnapshot {
    let Some(plan) = plan else {
        return WidgetSnapshot::empty_for_theme(date, theme_id);
    };

    let mut all_items = Vec::new();
    if let Some(items) = plan.get("items").and_then(Value::as_array) {
        flatten_items(items, 0, &mut all_items);
    }

    let total = all_items.len();
    let done = all_items.iter().filter(|(_, done, _, _)| *done).count();
    let pending = all_items
        .into_iter()
        .filter(|(_, done, _, _)| !done)
        .take(MAX_VISIBLE_ITEMS)
        .collect::<Vec<_>>();
    let items = pending.iter().map(|(text, _, _, _)| text.clone()).collect();
    let item_depths = pending.iter().map(|(_, _, depth, _)| *depth).collect();
    let item_times = pending.into_iter().map(|(_, _, _, time)| time).collect();

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
        item_depths,
        item_times,
        theme_id: normalize_theme_id(theme_id).to_string(),
    }
}

fn normalize_theme_id(theme_id: &str) -> &str {
    match theme_id {
        "forest" | "ocean" | "violet" | "sunset" | "berry" | "pink" | "mint" | "midnight" => {
            theme_id
        }
        _ => DEFAULT_THEME_ID,
    }
}

fn flatten_items(items: &[Value], depth: usize, output: &mut Vec<(String, bool, usize, String)>) {
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
                depth,
                item_time_label(item),
            ));
        }
        if let Some(children) = item.get("children").and_then(Value::as_array) {
            flatten_items(children, depth + 1, output);
        }
    }
}

fn item_time_label(item: &Value) -> String {
    if item
        .get("timeHidden")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return String::new();
    }

    let Some(start) = item.get("startMinutes").and_then(Value::as_i64) else {
        return String::new();
    };
    let Some(end) = item.get("endMinutes").and_then(Value::as_i64) else {
        return String::new();
    };
    format!("{}–{}", format_minutes(start), format_minutes(end))
}

fn format_minutes(minutes: i64) -> String {
    let normalized = minutes.rem_euclid(24 * 60);
    let hours = normalized / 60;
    let minutes = normalized % 60;
    let suffix = if hours >= 12 { "pm" } else { "am" };
    let hour = match hours % 12 {
        0 => 12,
        hour => hour,
    };
    if minutes == 0 {
        format!("{hour}{suffix}")
    } else {
        format!("{hour}:{minutes:02}{suffix}")
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
                        {
                            "text": "Nested pending",
                            "done": false,
                            "startMinutes": 540,
                            "endMinutes": 615,
                            "children": []
                        }
                    ]
                },
                {
                    "text": "Second",
                    "done": false,
                    "startMinutes": 660,
                    "endMinutes": 720,
                    "timeHidden": true,
                    "children": []
                },
                { "text": "", "done": false, "children": [] },
                { "text": "Third", "done": false, "children": [] },
                { "text": "Fourth", "done": false, "children": [] },
                { "text": "Fifth", "done": false, "children": [] },
                { "text": "Sixth", "done": false, "children": [] },
                { "text": "Seventh", "done": false, "children": [] },
                { "text": "Eighth", "done": false, "children": [] },
                { "text": "Ninth", "done": false, "children": [] },
                { "text": "Tenth", "done": false, "children": [] },
                { "text": "Eleventh hidden", "done": false, "children": [] }
            ]
        });

        let snapshot = snapshot_from_plan("2026-08-01", Some(&plan), "ocean");

        assert!(snapshot.has_plan);
        assert_eq!(snapshot.title, "Launch day");
        assert_eq!(snapshot.reminder, "Ship calmly");
        assert_eq!(snapshot.done, 1);
        assert_eq!(snapshot.total, 12);
        assert_eq!(
            snapshot.items,
            [
                "Nested pending",
                "Second",
                "Third",
                "Fourth",
                "Fifth",
                "Sixth",
                "Seventh",
                "Eighth",
                "Ninth",
                "Tenth",
            ]
        );
        assert_eq!(snapshot.item_depths, [1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        assert_eq!(snapshot.theme_id, "ocean");
        assert_eq!(serde_json::to_value(&snapshot).unwrap()["themeId"], "ocean");
        assert_eq!(
            snapshot.item_times,
            ["9am–10:15am", "", "", "", "", "", "", "", "", ""]
        );
    }

    #[test]
    fn widget_snapshot_handles_a_missing_plan() {
        let snapshot = snapshot_from_plan("2026-08-01", None, "unknown");

        assert!(!snapshot.has_plan);
        assert!(!snapshot.unavailable);
        assert_eq!(snapshot.title, "Today");
        assert!(snapshot.items.is_empty());
        assert!(snapshot.item_depths.is_empty());
        assert!(snapshot.item_times.is_empty());
        assert_eq!(snapshot.theme_id, "violet");
    }
}
