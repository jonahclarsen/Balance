# Retro themes

## Mac System 1

Use the bitmap letterforms of Chicago 12 for interface text and Geneva 9 for content, not modern outline Geneva or a generic sans-serif. ChiKareGo2 and FindersKeepers are Giles Booth's pixel recreations. The font files are bundled, and the browser audit verifies the rendered sidebar font, including the Balance heading. Monaco is Jamie Place's bitmap reconstruction. Attribution is in `public/fonts/LICENSE-Mac-Bitmap.txt`.

Sources: [ChiKareGo2](https://www.pentacom.jp/pentacom/bitfontmaker2/gallery/?id=3780), [FindersKeepers](https://www.pentacom.jp/pentacom/bitfontmaker2/gallery/?id=3809), [Monaco](https://fontstruct.com/fontstructions/show/753435), [System.css font builds](https://github.com/sakofchit/system.css/tree/main/fonts), and the [Computer History Museum's 1984 Macintosh reference](https://www.computerhistory.org/revolution/personal-computers/17/303/1200).

In wide windows the app draws the window's title bar: six rules, the title "Balance", the close box on the left and the zoom box on the right. The 1984 Finder had only the close box; the zoom box arrived with the Mac Plus, and Balance needs it for full screen. Minimize is ⌘M.

Only desktop gaps show the dither pattern. Text sits on opaque window surfaces. Shared selection fills stay pale because controls pair them with dark accent text; explicitly inverted tabs and navigation set both foreground and background. Never set a black selection background globally without checking every control that consumes it. Keep bitmap strike-throughs thin enough to read the letters underneath.

## Windows XP and Vista

These two themes are drawn from the systems' own files, not recreated in CSS. XP's controls come from SP3's `luna.msstyles` and `shellstyle.dll`, Vista's from RTM's `aero.msstyles` (6.0.6000), plus their icons and cursors. Nine-grid margins, frame order and colors come from the same files: `NORMALBLUE_INI` for Luna, the `VARIANT` property table for Aero. CSS `border-image` is Windows' nine-grid, so a slice value in `src/aero-luna-themes.css` is the theme's `SizingMargins` reordered to top, right, bottom, left. Change one only against the source.

`aero.msstyles` stores premultiplied alpha, so its PNGs look dark if used directly; the slicer converts them. Windows 10 also ships an `aero.msstyles`. Check a file's version resource before trusting it.

**The window.** The app window is drawn as one XP or Vista window filling the native window, with no desktop around it: a caption across the top from `WindowCaption.svelte`, a frame on the other sides, panes inside. The caption shows the current view, so page headers hide a title that only repeats it. These themes run at webview zoom 1 rather than Balance's 1.1, because bitmaps only stay crisp at whole-pixel scales.

**Luna.** The left pane is the Start menu, stacked into one column: the user pane with `chess.bmp` in its tile, the orange rule, the white program list with 32px icons, the pale-blue places (Settings, Search, Add idea, with their 24px icons) and the Log Off bar holding Generate day behind the green All Programs arrow. Every part is its `StartPanel` bitmap at its own `SizingMargins`; the menu's frame and the places column's edge are pixel colors from those bitmaps. Hot items fill flat `#316ac5`, as the menu did. The user name is Franklin Gothic Medium when installed; it can't be redistributed, so the public build falls back to Libre Franklin Medium (SIL OFL, `public/fonts/LibreFranklin-OFL.txt`).

**Aero.** The left pane is the Start menu: explorer.exe's picture frame over `usertile7`, places on the smoky glass with the place-list selection frame, the white program list cropped from the composited panel, and the Start Search box at the bottom. Its art comes from Vista SP2's `aero.msstyles` (6.0.6002), which matches RTM for these parts, with premultiplied alpha converted. Page headers are Explorer's command bar. Vista's glass in the window frame is `aurora-glass.jpg`, a pre-blurred copy of the wallpaper, so typing and scrolling never recomposite a live `backdrop-filter`. Dialogs use live blur because they are short-lived. The caption title sits on the theme's own text-glow image.

**Window buttons.** XP, Vista and System 1 draw their own caption buttons in wide windows, and macOS's traffic lights are hidden while they show (`window_buttons.rs`). They do what the traffic lights do: Close closes, Minimize minimizes (leaving full screen first, since macOS can't minimize a full-screen window), and Maximize or the zoom box toggles full screen, showing Restore while full screen. They are disabled in a browser. Narrow windows hide the caption and keep the traffic lights.

**Control Panel.** Settings is Control Panel, filling the client area. A task pane against the left frame lists every rendered section and jumps to it without animating, as Explorer did; `ControlPanelTasks.svelte` builds it from the `data-cp` sections, so platform-only sections need no second list. Only XP and Vista render it. XP is Category View: the Luna task pane beside `shellstyle.dll`'s `#6375d6` category list and monitor watermark, white Tahoma Bold titles with 32px applet icons. Vista is Control Panel Home: the navigation pane's `#416fa6`-to-`#6cb96e` fill and shell32's swoosh, Segoe UI 12pt `#006e12` titles and 48px icons. Other themes never show the pane.

**Checked rows.** These keep Balance's green or the color from Settings, so they can't be bitmaps. Luna uses the task-pane header's left-to-right fade. Aero uses the geometry and stops of Explorer's selection frame.

**Scrollbars.** Parts are selected without a `:root` prefix because Chromium ignores `:vertical` and `:horizontal` in a selector with a combinator. The bitmaps arrive through variables, and the parts do nothing in other themes because only these two turn on `::-webkit-scrollbar`. macOS browsers never draw scrollbar buttons, so the arrows are painted on the bar and don't respond to clicks. Playwright screenshots usually leave scrollbars blank: launch without `--hide-scrollbars` and hover the bar to see them.

**Dark appearance.** Neither system had one. XP wears Microsoft's black Royale Noir chrome from `ui-noir/`; its controls were light on Windows too, so they keep black text. Vista darkens the glass tint and content surfaces. Both only adapt Balance's own surfaces.

**Fonts.** Tahoma and Trebuchet MS come from macOS. Vista's face is Segoe UI, which isn't redistributed: a licensed local copy loads from the ignored `public/fonts/local/`, on the owner's Mac from Office's WOFF files. The public repository falls back to [Microsoft Selawik 1.01](https://github.com/microsoft/Selawik/releases/tag/1.01) under the SIL Open Font License.

## Wii Sports

Balance drawn as one of the game's menu screens (2006), from the disc's own files rather than recreated in CSS. `scripts/wii-sports-theme-assets/build.py` reads an extracted disc (RSPE01) as data: Yaz0 and U8 archives, TPL textures and the BREFT pointer pack. It writes `public/themes/wiisports` and the provenance record. Sizes, colors and motion come from the layouts beside those textures (`sportsTop_00`, `menuFrame_00`, `messageWindowW_00`, `trainingResult_00`, `playerSelect_00`, `cPadCursor_00` and their `.brlan` animations) and from 1080p captures of the running game.

**The frame.** `WiiSportsFrame.svelte` draws the white bars above and below the blue field in wide windows. The grey tab on the top bar's lower edge names the view, as `menuFrame_00`'s caption does, and the wordmark sits where the game's logo does. The rules along the bars are `ist_menuLine_00`. The bottom bar carries the sidebar's own tagline in the caption tab where the game writes "Back", and its day and goal counts in the black and blue player-name tab; both are the sidebar's elements moved with `position: fixed`, so the bars must not get a `z-index` that would trap them underneath. IMAX hides the frame. macOS keeps its traffic lights, which sit on the top bar above the tab. Phones keep the usual header.

**The field.** The game renders its swooshes from a 3D model (`menu_BG_model`), so the background is the one drawn part: an SVG of rings in the captured blues.

**Buttons.** Every push button is `ist_button_04` as a nine-grid. Under the pointer, focused, pressed in or primary, it takes the selected colour, which is the texture multiplied by (0.676, 0.965, 1.0), measured from the game. The sidebar is the main menu's column of buttons: they grow with the window's height as the game's do, the one under the pointer swells and its brightness dips and returns over 80 frames (`sportsTop_00_activeButton_00`), and the current view wears the pad cursor, `cPadCursor_00`'s four grey corners. Only a hovered button gets a filter; a filter on every button would give each its own surface. Theme and appearance cards are `ist_button_06`, the striped tile of the training menu. Tabs are player select's `ist_tab_00`.

**Windows.** The workspace, Goal Rhythm and every dialog are the white message window: a thick white rim, a thin grey line inside it, and faint scanlines. Text never sits straight on the blue except in dark navy; the game only puts white lettering on its grey tabs and dark panels. Page headers are `trainingResult_00`'s teal title bar.

**The pointer.** On desktop the cursor is nw4r's pointing hand in player one's blue. Like the game it keeps its shape over buttons. Text keeps the I-beam so the caret can be placed, and drag handles get the pack's open hand and fist.

**Contrast.** Three of the game's colours fail 4.5:1 under white lettering at this size and are nudged to the nearest that passes: the caption tab's grey (128 to 118), the title bar's teal (0,150,170 to 10,127,145) and the name tab's blue (0,140,255 to 0,112,214, light appearance only). Focus is a navy ring, which shows on the blue and on the white.

**Dark appearance.** The game has none, so night borrows its darkest screens: player select's navy panels with their blue line, and the black system window. The night button and tile faces are recolors of the same textures; the record marks them as not in the game.

**Font.** The game's face is FOT-NewRodin Pro DB, drawn here from one weight for every weight as the game does. It isn't redistributed: a licensed local copy loads from the ignored `public/fonts/local/NewRodin-DB.woff2`, and the public build falls back to [M PLUS 1](https://github.com/coz-m/MPLUS_FONTS) at weight 560 under the SIL Open Font License (`public/fonts/MPLUS1-OFL.txt`). Rodin's line gap is a full em and its curly quotes, dashes and ellipsis are full-width Japanese forms, so the `@font-face` rules give both faces Latin line metrics, scale them to set about as wide as the faces Balance was laid out for, and restrict them to Latin letters.

**Widgets.** The macOS and Android widgets use the theme's palette on the ordinary card, not a drawn frame.

[wii-sports-theme-assets.json](wii-sports-theme-assets.json) records every texture, its archive path, conversion and SHA-256. Wii Sports artwork remains Nintendo's; the application code license does not relicense it.

Historical theme IDs are permanent, including retired Windows 98. Keep the TypeScript catalog, Rust Random catalog, macOS widget palettes and Android palette generator aligned.

## Widgets

macOS and Android widgets draw each retro theme as a window: its caption, dialog face, list well, checkbox and progress bar. `src-tauri/widget-fonts` holds the bundled fonts, losslessly converted to TrueType because Android can't load WOFF2; their licenses are in `public/fonts`. macOS uses its own Tahoma and Trebuchet MS for XP. Tahoma can't be redistributed, so Android's XP widget uses the system sans-serif.

macOS clips every widget to its own large rounded rectangle, and apps can't change that shape. The windows are therefore inset on their desktop (Bliss, Aurora, the dither or teal), so the clip falls on the desktop and each window keeps its own corners: XP's rounded top, Vista's small radius, square Windows 98 and System 1. The widget copies of Bliss and Aurora are recorded in `windows-theme-assets.json`. Android launchers don't clip these widgets, so there the window is the whole widget.

## Asset provenance and visual review

[windows-theme-assets.json](windows-theme-assets.json) records every wallpaper, icon, cursor and control bitmap, its source, conversion and SHA-256. Original Windows imagery retains Microsoft's rights; the archive sources describe personal, educational and archival use. The application code license does not relicense this artwork. `scripts/windows-theme-assets/` holds the extraction and slicing scripts, which only read those files as data.

The browser audit uses generated planner data only. Check real screenshots after changing shared CSS, in both appearances: passing click tests do not establish visual fidelity. The theme stylesheet loads after `app.css`, so it wins specificity ties with shared rules.

Mac System 1's bitmap fonts and readability audit remain unchanged. No ROM, disc image or Windows executable is needed or run by Balance.
