# Retro themes

## Mac System 1

Use the bitmap letterforms of Chicago 12 for interface text and Geneva 9 for content, not modern outline Geneva or a generic sans-serif. ChiKareGo2 and FindersKeepers are Giles Booth's pixel recreations. The font files are bundled, and the browser audit verifies the rendered sidebar font, including the Balance heading. Monaco is Jamie Place's bitmap reconstruction. Attribution is in `public/fonts/LICENSE-Mac-Bitmap.txt`.

Sources: [ChiKareGo2](https://www.pentacom.jp/pentacom/bitfontmaker2/gallery/?id=3780), [FindersKeepers](https://www.pentacom.jp/pentacom/bitfontmaker2/gallery/?id=3809), [Monaco](https://fontstruct.com/fontstructions/show/753435), [System.css font builds](https://github.com/sakofchit/system.css/tree/main/fonts), and the [Computer History Museum's 1984 Macintosh reference](https://www.computerhistory.org/revolution/personal-computers/17/303/1200).

Only desktop gaps show the dither pattern. Text sits on opaque window surfaces. Shared selection fills stay pale because controls pair them with dark accent text; explicitly inverted tabs and navigation set both foreground and background. Never set a black selection background globally without checking every control that consumes it. Keep bitmap strike-throughs thin enough to read the letters underneath.

## Windows XP

The reference is the default blue Luna scheme: a stepped blue caption gradient, warm `#ece9d8` dialog faces, rounded upper corners, Tahoma controls, Trebuchet MS captions, amber focus edges, and green command accents. The wallpaper is the original Bliss bitmap, converted losslessly to PNG. Navigation uses original Windows icon images rather than recolored modern paths. Dialogs have the separate one-pixel Luna frame edges, warm dialog faces, 30px captions and XP.css’s pixel-path close button, including hover and pressed states. Command buttons remain neutral; green Start-button coloring is not applied to every primary action.

Sources: [Microsoft's Luna history](https://devblogs.microsoft.com/oldnewthing/20040331-00/?p=39953), [Microsoft's Tahoma documentation](https://learn.microsoft.com/en-us/typography/font-list/tahoma), and [XP.css's window and control implementation](https://github.com/botoxparty/XP.css/tree/main/themes/XP). Its license is included under `public/theme-licenses/XP.css.txt`.

## Windows Vista

The reference is Vista Aero: blue-green glass, reflected highlights, white content surfaces, glowing caption text, glossy controls, red caption close buttons, and Segoe UI. Glass blur is confined to the sidebar and caption surfaces. The wallpaper is the original Vista widescreen Aurora (`img36.jpg`). Navigation uses native 16px Vista ICO frames. The modal frame is a single glass surface with an inset opaque client area, an uninterrupted caption and top-aligned 47 × 19 close button. Glass, reflections and button backgrounds are recreated in CSS; the Aero close glyph is pixel artwork from 7.css, not a modern stroke icon. Neither the viewport background nor inherited CSS variables animate.

Sources: [Microsoft's Vista reviewer guide](https://download.microsoft.com/documents/uk/press/product/windowsvista/windowsvista_revgd_lr.pdf), [Segoe UI documentation](https://learn.microsoft.com/en-us/typography/font-list/segoe-ui), and [the period Windows typography guidelines](https://learn.microsoft.com/en-us/windows/win32/uxguide/vis-fonts). Vista's regular UI face is Segoe UI, not Segoe branding or Segoe UI Variable. [7.css](https://github.com/khang-nd/7.css) is a secondary implementation reference for glass drawing; Vista's visual reference remains the original Aero guide.

The public repository includes [Microsoft Selawik 1.01](https://github.com/microsoft/Selawik/releases/tag/1.01), Microsoft's open-source Segoe UI fallback, under the SIL Open Font License. Segoe UI itself is not redistributed. A licensed local copy can be loaded from the ignored `public/fonts/local/` directory. On the owner's Mac the development app can use the Segoe UI WOFF files already supplied by the installed Office app. Do not publish them or pretend the Selawik fallback is the original Vista font.

The dark appearances are adaptations for Balance; those operating systems' default looks were light. Historical theme IDs are permanent, including retired Windows 98. Keep the TypeScript catalog, Rust Random catalog, macOS widget palettes, and Android palette generator aligned.

## Asset provenance and visual review

[windows-theme-assets.json](windows-theme-assets.json) records every wallpaper, icon and caption asset, its source, conversion and SHA-256. Original Windows imagery retains Microsoft's rights; the archive describes personal, educational and archival use. The application code license does not relicense this artwork. XP.css and 7.css licenses are included separately. The old vector wallpaper studies have been removed.

The browser audit uses generated planner data only. For XP and Vista it captures Today, Settings, Lists, Notes, the shortcuts dialog, search, and close-button normal/hover/pressed states in both appearances. Check those actual screenshots after changing shared modal CSS: passing click tests alone does not establish visual fidelity. The close button must still dismiss each dialog; content begins directly below the caption and stays inside the client frame. Headerless dialogs receive caption space without shifting normal dialog bodies down twice.

Mac System 1's bitmap fonts and readability audit remain unchanged. Dark mode is an adaptation rather than a historical Windows appearance. No ROM or Windows executable is needed or run by Balance.
