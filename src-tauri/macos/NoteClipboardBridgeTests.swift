import AppKit

@main
struct NoteClipboardBridgeTests {
    static func main() throws {
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 8, pixelsHigh: 4,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        memset(bitmap.bitmapData!, 200, bitmap.bytesPerRow * bitmap.pixelsHigh)
        let png = bitmap.representation(using: .png, properties: [:])!
        let note = NSMutableAttributedString(string: "Synthetic title\n", attributes: [.font: NSFont.boldSystemFont(ofSize: 20)])
        note.append(NSAttributedString(string: "Before ", attributes: [.font: NSFont.systemFont(ofSize: 13), .underlineStyle: 1]))
        for index in 0..<2 {
            let wrapper = FileWrapper(regularFileWithContents: png)
            wrapper.preferredFilename = "synthetic-\(index).png"
            let attachment = NSTextAttachment(fileWrapper: wrapper)
            note.append(NSAttributedString(attachment: attachment))
            note.append(NSAttributedString(string: index == 0 ? " Between " : " After"))
        }
        let rtfd = note.rtfd(from: NSRange(location: 0, length: note.length), documentAttributes: [:])!
        let decoded = NSAttributedString(rtfd: rtfd, documentAttributes: nil)!
        let html = try noteClipboardHTML(decoded)
        precondition(html.components(separatedBy: "data:image/png;base64,").count == 3)
        precondition(html.components(separatedBy: png.base64EncodedString()).count == 3)
        precondition(html.contains("Synthetic title") && html.contains("20.0px"))
        precondition(html.contains("underline") && html.contains("Before"))
        precondition(!html.contains("file://") && !html.contains("BALANCEATTACHMENT"))
        let before = html.range(of: "Before")!.lowerBound
        let middle = html.range(of: "Between")!.lowerBound
        let after = html.range(of: "After")!.lowerBound
        let images = html.ranges(of: "data:image/png;base64,")
        precondition(before < images[0].lowerBound && images[0].lowerBound < middle)
        precondition(middle < images[1].lowerBound && images[1].lowerBound < after)
        print("Synthetic RTFD formatting and multiple attachment conversion passed")
    }
}
