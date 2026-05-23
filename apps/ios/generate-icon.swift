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

// ---- The wave — main brand mark inside the calendar body. ----
// One smooth S-curve (single crest on the left, single trough on the
// right) that spans the calendar's content area below the divider.
// Picked over a date number because the wave directly echoes the
// brand name (ByWave). Single big swell, not multiple ripples — at
// small icon sizes (Spotlight, multitask switcher) multiple wiggles
// smush into a noisy blob.
let contentTop    = dividerY                  // under the divider
let contentBottom = bodyY                     // calendar's bottom edge
let contentMidY   = (contentTop + contentBottom) / 2
let waveLeft  = bodyX + 80
let waveRight = bodyX + bodyW - 80
let waveAmp:  CGFloat = 90                    // peak ↔ trough offset

ctx.setLineWidth(58)
ctx.move(to: CGPoint(x: waveLeft, y: contentMidY))

let segWidth = (waveRight - waveLeft) / 2
let cp1 = CGPoint(x: waveLeft + segWidth * 0.45, y: contentMidY + waveAmp)
let cp2 = CGPoint(x: waveLeft + segWidth - segWidth * 0.45, y: contentMidY + waveAmp)
ctx.addCurve(
    to: CGPoint(x: waveLeft + segWidth, y: contentMidY),
    control1: cp1, control2: cp2,
)
let cp3 = CGPoint(x: waveLeft + segWidth + segWidth * 0.45, y: contentMidY - waveAmp)
let cp4 = CGPoint(x: waveRight - segWidth * 0.45, y: contentMidY - waveAmp)
ctx.addCurve(
    to: CGPoint(x: waveRight, y: contentMidY),
    control1: cp3, control2: cp4,
)
ctx.strokePath()

// Write PNG
guard let cgImage = ctx.makeImage() else { exit(1) }
let rep = NSBitmapImageRep(cgImage: cgImage)
guard let pngData = rep.representation(using: .png, properties: [:]) else { exit(1) }

let url = URL(fileURLWithPath: outputPath)
try pngData.write(to: url)
print("wrote \(pngData.count) bytes to \(outputPath)")
