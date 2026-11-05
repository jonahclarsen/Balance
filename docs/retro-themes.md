# Retro themes

## Mac System 1

Use the bitmap letterforms of Chicago 12 for interface text and Geneva 9 for content, not modern outline Geneva or a generic sans-serif. ChiKareGo2 and FindersKeepers are Giles Booth's pixel recreations. The font files are bundled, and the browser audit verifies the rendered sidebar font, including the Balance heading. Monaco is Jamie Place's bitmap reconstruction. Attribution is in `public/fonts/LICENSE-Mac-Bitmap.txt`.

Sources: [ChiKareGo2](https://www.pentacom.jp/pentacom/bitfontmaker2/gallery/?id=3780), [FindersKeepers](https://www.pentacom.jp/pentacom/bitfontmaker2/gallery/?id=3809), [Monaco](https://fontstruct.com/fontstructions/show/753435), [System.css font builds](https://github.com/sakofchit/system.css/tree/main/fonts), and the [Computer History Museum's 1984 Macintosh reference](https://www.computerhistory.org/revolution/personal-computers/17/303/1200).

Only desktop gaps show the dither pattern. Text sits on opaque window surfaces. Shared selection fills stay pale because controls pair them with dark accent text; explicitly inverted tabs and navigation set both foreground and background. Never set a black selection background globally without checking every control that consumes it. Keep bitmap strike-throughs thin enough to read the letters underneath.

## Windows XP and Vista

These two themes are drawn from the systems' own files, not recreated in CSS. XP's controls come from SP3's `luna.msstyles` and `shellstyle.dll`, Vista's from RTM's `aero.msstyles` (6.0.6000), plus their icons and cursors. Nine-grid margins, frame order and colors come from the same files: `NORMALBLUE_INI` for Luna, the `VARIANT` property table for Aero. CSS `border-image` is Windows' nine-grid, so a slice value in `src/aero-luna-themes.css` is the theme's `SizingMargins` reordered to top, right, bottom, left. Change one only against the source.

`aero.msstyles` stores premultiplied alpha, so its PNGs look dark if used directly; the slicer converts them. Windows 10 also ships an `aero.msstyles`. Check a file's version resource before trusting it.

**The window.** The whole app is one window with the desktop showing around it: a caption across the top from `WindowCaption.svelte`, a frame on the other sides, panes inside. The caption shows the current view, so page headers hide a title that only repeats it. Maximize drives IMAX mode. Minimize and Close act on the real window and are disabled in a browser. These themes run at webview zoom 1 rather than Balance's 1.1, because bitmaps only stay crisp at whole-pixel scales.

**Luna.** The left pane is Explorer's task pane: `shellstyle.dll`'s header strips and chevrons over its own gradient and link colors. The chevrons are decoration; the cards don't collapse. Selection fills flat `#316ac5`.

**Aero.** The left pane is Explorer's navigation pane with the real selection frames, and page headers are its command bar. Vista's glass in the window frame is `aurora-glass.jpg`, a pre-blurred copy of the wallpaper, so typing and scrolling never recomposite a live `backdrop-filter`. Dialogs use live blur because they are short-lived. The caption title sits on the theme's own text-glow image.

**Checked rows.** These keep Balance's green or the color from Settings, so they can't be bitmaps. Luna uses the task-pane header's left-to-right fade. Aero uses the geometry and stops of Explorer's selection frame.

**Scrollbars.** Parts are selected without a `:root` prefix because Chromium ignores `:vertical` and `:horizontal` in a selector with a combinator. The bitmaps arrive through variables, and the parts do nothing in other themes because only these two turn on `::-webkit-scrollbar`. macOS browsers never draw scrollbar buttons, so the arrows are painted on the bar and don't respond to clicks. Playwright screenshots usually leave scrollbars blank: launch without `--hide-scrollbars` and hover the bar to see them.

**Dark appearance.** Neither system had one. XP wears Microsoft's black Royale Noir chrome from `ui-noir/`; its controls were light on Windows too, so they keep black text. Vista darkens the glass tint and content surfaces. Both only adapt Balance's own surfaces.

**Fonts.** Tahoma and Trebuchet MS come from macOS. Vista's face is Segoe UI, which isn't redistributed: a licensed local copy loads from the ignored `public/fonts/local/`, on the owner's Mac from Office's WOFF files. The public repository falls back to [Microsoft Selawik 1.01](https://github.com/microsoft/Selawik/releases/tag/1.01) under the SIL Open Font License.

Historical theme IDs are permanent, including retired Windows 98. Keep the TypeScript catalog, Rust Random catalog, macOS widget palettes and Android palette generator aligned.

## Widgets

macOS and Android widgets draw each retro theme as a window: its caption, dialog face, list well, checkbox and progress bar. `src-tauri/widget-fonts` holds the bundled fonts, losslessly converted to TrueType because Android can't load WOFF2; their licenses are in `public/fonts`. macOS uses its own Tahoma and Trebuchet MS for XP. Tahoma can't be redistributed, so Android's XP widget uses the system sans-serif.

macOS clips every widget to its own large rounded rectangle, and apps can't change that shape. The windows are therefore inset on their desktop (Bliss, Aurora, the dither or teal), so the clip falls on the desktop and each window keeps its own corners: XP's rounded top, Vista's small radius, square Windows 98 and System 1. The widget copies of Bliss and Aurora are recorded in `windows-theme-assets.json`. Android launchers don't clip these widgets, so there the window is the whole widget.

## Asset provenance and visual review

[windows-theme-assets.json](windows-theme-assets.json) records every wallpaper, icon, cursor and control bitmap, its source, conversion and SHA-256. Original Windows imagery retains Microsoft's rights; the archive sources describe personal, educational and archival use. The application code license does not relicense this artwork. `scripts/windows-theme-assets/` holds the extraction and slicing scripts, which only read those files as data.

The browser audit uses generated planner data only. Check real screenshots after changing shared CSS, in both appearances: passing click tests do not establish visual fidelity. The theme stylesheet loads after `app.css`, so it wins specificity ties with shared rules.

Mac System 1's bitmap fonts and readability audit remain unchanged. No ROM or Windows executable is needed or run by Balance.
