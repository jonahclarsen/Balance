import AppKit

private func originalImageType(_ data: Data) -> String? {
    if data.starts(with: [137, 80, 78, 71, 13, 10, 26, 10]) { return "image/png" }
    if data.starts(with: [255, 216, 255]) { return "image/jpeg" }
    if data.starts(with: Array("GIF8".utf8)) { return "image/gif" }
    if data.starts(with: Array("RIFF".utf8)), data.count >= 12,
       data.subdata(in: 8..<12) == Data("WEBP".utf8) { return "image/webp" }
    return nil
}

// RTFD carries attachment bytes that WebKit's paste event does not expose.
// Export through AppKit, replacing attachments before HTML serialization so
// the result is self-contained (never file:// links to temporary attachments).
func noteClipboardHTML(_ attributed: NSAttributedString) throws -> String {
    let copy = NSMutableAttributedString(attributedString: attributed)
    var replacements: [(NSRange, String, String)] = []
    attributed.enumerateAttribute(.attachment, in: NSRange(location: 0, length: attributed.length)) { value, range, _ in
        guard let attachment = value as? NSTextAttachment else { return }
        let bytes = attachment.fileWrapper?.regularFileContents ?? attachment.contents
        let image = bytes.flatMap { NSImage(data: $0) } ?? attachment.image
        guard let image else { return }
        let payload: Data
        let mime: String
        if let bytes, let type = originalImageType(bytes) {
            payload = bytes; mime = type
        } else {
            guard let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
                  let png = bitmap.representation(using: .png, properties: [:]) else { return }
            payload = png; mime = "image/png"
        }
        let size = attachment.bounds.size.width > 0 ? attachment.bounds.size : image.size
        let width = max(1, min(30000, Int(size.width)))
        let height = max(1, min(30000, Int(size.height)))
        let token = "BALANCEATTACHMENT" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
        let html = "<img src=\"data:\(mime);base64,\(payload.base64EncodedString())\" width=\"\(width)\" height=\"\(height)\">"
        replacements.append((range, token, html))
    }
    for (range, token, _) in replacements.reversed() {
        copy.replaceCharacters(in: range, with: token)
        copy.removeAttribute(.attachment, range: NSRange(location: range.location, length: token.utf16.count))
    }
    let data = try copy.data(from: NSRange(location: 0, length: copy.length), documentAttributes: [
        .documentType: NSAttributedString.DocumentType.html,
        .characterEncoding: String.Encoding.utf8.rawValue,
    ])
    var html = String(decoding: data, as: UTF8.self)
    for (_, token, image) in replacements { html = html.replacingOccurrences(of: token, with: image) }
    return html
}

@_cdecl("balance_note_clipboard_html")
public func balanceNoteClipboardHTML() -> UnsafeMutablePointer<CChar>? {
    let pasteboard = NSPasteboard.general
    let attributed: NSAttributedString?
    if let data = pasteboard.data(forType: .rtfd) {
        attributed = NSAttributedString(rtfd: data, documentAttributes: nil)
    } else if let data = pasteboard.data(forType: .rtf) {
        attributed = NSAttributedString(rtf: data, documentAttributes: nil)
    } else { return nil }
    guard let attributed, let html = try? noteClipboardHTML(attributed) else { return nil }
    return strdup(html)
}

@_cdecl("balance_free_note_clipboard_html")
public func balanceFreeNoteClipboardHTML(_ pointer: UnsafeMutablePointer<CChar>?) { free(pointer) }
