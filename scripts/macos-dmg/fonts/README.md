# Installer artwork fonts

The balance.jonah.art fonts as set in `/admin` (headings: Rubik 700; body:
Geist Mono 400), downloaded as TrueType from Google Fonts for CoreText. Both are
under the SIL Open Font License. `draw-background.swift` registers them only in
its own process and rasterizes the text into the background; they are not
copied into the disk image or the app.
