#!/usr/bin/env swift
// generate-icon.swift — renders the ByWave Calendar app icon to PNG.
// Output: 1024×1024 png at the path passed as the first arg.
//
// Run: swift apps/ios/generate-icon.swift apps/ios/.../icon-1024.png
//
// Design (v2): purple gradient square, with a white calendar glyph
// (rounded body + two top staples + horizontal divider) containing
// a stylized wave (~~~) inside — the "Wave" in ByWave. Wave is drawn
// as a smooth cubic-bezier so it reads cleanly even when iOS masks
// the icon down to ~60pt in the multitask switcher.

import Foundation
import AppKit
import CoreGraphics

let args = CommandLine.arguments
guard args.count >= 2 else {
    FileHandle.standardError.write("usage: generate-icon.swift <output.png>\n".data(using: .utf8)!)
    exit(1)
}
let outputPath = args[1]

let size: CGFloat = 1024
let cs = CGColorSpace(name: CGColorSpace.sRGB)!

guard let ctx = CGContext(
    data: nil,
    width: Int(size),
    height: Int(size),
    bitsPerComponent: 8,
    bytesPerRow: 0,
    space: cs,
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue,
) else { exit(1) }

// Background gradient — same direction + colors as the boot splash logo.
// Indigo (#4F46E5) top-left → violet (#7C3AED) bottom-right matches
// the brand "indigo" palette token the server defaults to. The splash
// screen in iOS APP uses the same gradient, so the cold-launch
// transition (app icon → splash) looks like one continuous animation
// rather than two abrupt shifts.
let colors = [
    CGColor(srgbRed: 0.31, green: 0.27, blue: 0.90, alpha: 1.0),
    CGColor(srgbRed: 0.49, green: 0.23, blue: 0.93, alpha: 1.0),
] as CFArray
let gradient = CGGradient(colorsSpace: cs, colors: colors, locations: nil)!
ctx.drawLinearGradient(
    gradient,
    start: CGPoint(x: 0, y: size),
    end: CGPoint(x: size, y: 0),
    options: [],
)

// White calendar glyph — strokes only, no fill. Inspired by SF Symbol "calendar".
ctx.setStrokeColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1.0))
ctx.setLineWidth(46)
ctx.setLineCap(.round)
ctx.setLineJoin(.round)

// Body — rounded rectangle, centered, occupying middle ~55%
let bodyW: CGFloat = 560
let bodyH: CGFloat = 500
let bodyX = (size - bodyW) / 2
let bodyY: CGFloat = 270   // CoreGraphics origin is bottom-left
let bodyRect = CGRect(x: bodyX, y: bodyY, width: bodyW, height: bodyH)
let bodyPath = CGPath(roundedRect: bodyRect, cornerWidth: 64, cornerHeight: 64, transform: nil)
ctx.addPath(bodyPath)
ctx.strokePath()

// Two staples on top (the calendar's "rings")
let stapleHalfLen: CGFloat = 80
let stapleTop = bodyY + bodyH - 60
let stapleBot = bodyY + bodyH + stapleHalfLen
ctx.move(to: CGPoint(x: bodyX + 150, y: stapleTop))
ctx.addLine(to: CGPoint(x: bodyX + 150, y: stapleBot))
ctx.strokePath()
ctx.move(to: CGPoint(x: bodyX + bodyW - 150, y: stapleTop))
ctx.addLine(to: CGPoint(x: bodyX + bodyW - 150, y: stapleBot))
ctx.strokePath()

// Horizontal divider line under the staples — separates the "month
// header" zone from the body where dates would normally sit.
let dividerY = bodyY + bodyH - 140
ctx.move(to: CGPoint(x: bodyX + 24, y: dividerY))
ctx.addLine(to: CGPoint(x: bodyX + bodyW - 24, y: dividerY))
ctx.strokePath()

// ---- The date number — main brand mark inside the calendar body. ----
// Borrows from iOS Calendar's icon language: a huge bold numeral
// centered in the content area under the divider. Static "23" so it
// doesn't go stale (Apple uses a private API to update theirs daily;
// third-party apps can't, so a moving target would just be wrong all
// year). 23 is intentional — both digits are visually balanced
// (no narrow "1" or wide "8") and reads cleanly at every iOS icon
// scale from 60pt to the App Store 1024.
let contentTop    = dividerY            // under the divider
let contentBottom = bodyY               // calendar's bottom edge
let contentMidY   = (contentTop + contentBottom) / 2
let bodyMidX      = bodyX + bodyW / 2

let dateString = "23" as NSString
let dateFontSize: CGFloat = 280
let dateFont = NSFont.systemFont(ofSize: dateFontSize, weight: .heavy)
let dateAttrs: [NSAttributedString.Key: Any] = [
    .font: dateFont,
    .foregroundColor: NSColor.white,
]
let dateSize = dateString.size(withAttributes: dateAttrs)

// Apple's Quartz coords have origin at bottom-left. We center horizontally
// AND vertically inside the calendar's content area. The text bounding
// box reports the glyph's ascent + descent, so subtract half its height
// from the midpoint to get the draw origin.
let drawOrigin = CGPoint(
    x: bodyMidX - dateSize.width / 2,
    y: contentMidY - dateSize.height / 2 + 14,  // optical lift — digits feel low otherwise
)

// NSString.draw routes through the current NSGraphicsContext, not the
// CGContext we've been using for vector strokes. Bridge by pushing a
// new NSGraphicsContext that wraps our existing CGContext for the
// duration of the text draw.
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
dateString.draw(at: drawOrigin, withAttributes: dateAttrs)
NSGraphicsContext.restoreGraphicsState()

// Write PNG
guard let cgImage = ctx.makeImage() else { exit(1) }
let rep = NSBitmapImageRep(cgImage: cgImage)
guard let pngData = rep.representation(using: .png, properties: [:]) else { exit(1) }

let url = URL(fileURLWithPath: outputPath)
try pngData.write(to: url)
print("wrote \(pngData.count) bytes to \(outputPath)")
