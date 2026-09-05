# Images

Paste a copied image or drop an image file into a content editor. Notes, plan
items, day-template options, list-template items, and other rich-text content
share the same behavior. Pasted web passages retain their supported text
formatting and omit external images. There is no insert button or caption field.

New images start with Wrap left, allowing multiple lines of text beside them.
Click an image to select it and reveal corner resize handles and
Wrap left / Wrap right / Inline controls. Inline treats the image as a character
on one line, with a small margin around it. Wrapped images remain
anchored to their position in the containing text item, which contains their
height; they move with that item and text above it. Drag to another text position
or item to move the anchor; Alt-drag copies it. Display resizing preserves aspect
ratio and never re-encodes the stored bytes. Double-click opens a window-filling
viewer; Escape or clicking the dimmed background closes it.

## Compression

Images at or below 1,000,000 bytes retain the clipboard's original encoding.
Larger images open a preview with scale (1–100%) and WebP quality (1–100).
Initial quality is 80. Initial scale is 100% unless the shorter side exceeds
1,500 pixels, then it is the nearest whole percentage bringing that side to
1,500 pixels, bounded by the slider range.

The large preview and magnified detail show the encoded result. Click the main
preview to choose a detail; hold Show original to compare at the same position.
Size, dimensions, and savings update after encoding. Enter pastes the current
result when ready; Command+Enter (Control+Enter elsewhere) preserves the
original. Imported images must be smaller than 6,000,000 bytes (6 MB).
At or above that limit, Paste original and its shortcut are unavailable;
reduce scale or quality until the encoded result is below the limit to paste.
Escape cancels. A cancellable worker runs the bundled WebP WASM codec
locally, including on WebKit, whose canvas encoder does not provide WebP.
Nothing is uploaded for compression. Animated originals retain their animation;
WebP compression produces a still frame.

## Persistence and sync

The `images` collection holds immutable, SHA-256-addressed image assets inside
the encrypted database. Rich-text HTML contains only the asset id, display
width/height, and layout. The first reference and bytes persist atomically.
Generating templates copies references and presentation, not the image bytes;
replacing a template image leaves existing generated items unchanged. Like
other app data, operations and retained history add temporary storage overhead.
Backups include the entire database, including images.

Checkpoint collection scans current content (including archives and trash) and
retained undo/redo references before dropping unused assets. The resulting
checkpoint propagates deletion to other devices when they sync. An offline
reference outside a checkpoint's covered frontier restores its locally retained
bytes and republishes them under a separate operation author, without racing
queued frontend sequence numbers. Existing independent backups retain their
contents; old encrypted relay generations expire under the relay's retention
policy. Physical database space is reclaimed by normal database maintenance.

Sync protocol v5 protects image-bearing state from older writers. Update paired
devices together. The new relay reader accepts existing v4 envelopes during
upgrade; newly written v5 envelopes require the new app.

Sync uses the internet relay. Large operations use the existing chunked
checkpoint endpoint, so no relay deployment is required.
A background pass may download one checkpoint larger than its ordinary delta
budget so images do not require opening the app to get past that budget.
Android URI clipboard imports are bounded at 128 MiB to limit native memory use.

## Verification

`tests/visual/images.spec.ts` exercises synthetic image editing and compression
in Chromium, WebKit, and mobile layouts. The native sync tests cover shared
assets, retained undo, collection, an offline reference crossing collection,
and content-hash verification.
Android is built and smoke-tested only in the Android workflow.
