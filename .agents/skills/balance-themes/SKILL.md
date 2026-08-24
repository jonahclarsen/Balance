---
name: balance-themes
description: Add, modify, rename, hide, retire, or remove Balance color themes across the app and native widgets. Use whenever work touches theme presets, theme CSS, Random theme eligibility, widget palettes, or historical day-theme rendering.
---

# Balance themes

Preserve historical days when changing Balance themes.

- Never delete a theme ID, renderer, CSS variables, or native widget palette. Historical day records may reference that ID forever.
- To remove a theme from current use, retire it: hide it from the settings picker and exclude it from Random mode while keeping every renderer and palette intact.
- Never rename or reuse a theme ID. Change the display name instead.
- Keep the web, macOS widget, and generated Android widget palettes aligned when modifying a theme.
- Keep Random selection based only on active themes, while normalization and historical rendering continue accepting retired themes.
- Add or update tests proving retired themes remain renderable and unknown future theme IDs are preserved with a safe visual fallback.
- Retain the code comments beside each theme catalog or palette that explain this compatibility requirement.
