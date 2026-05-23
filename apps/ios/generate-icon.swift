#!/usr/bin/env swift
// generate-icon.swift — renders the ByWave Calendar app icon to PNG.
// Output: 1024×1024 png at the path passed as the first arg.
//
// Run: swift apps/ios/generate-icon.swift apps/ios/.../icon-1024.png
//
// Design: purple gradient square, with a simplified white "calendar"
// glyph (rounded body + two staples + horizontal divider). Tuned to
// look balanced when iOS masks it into a rounded square / circle.

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

// Body — rounded rectangle, centered, occupying middle 55%
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

// Horizontal divider line under the staples
let dividerY = bodyY + bodyH - 140
ctx.move(to: CGPoint(x: bodyX + 24, y: dividerY))
ctx.addLine(to: CGPoint(x: bodyX + bodyW - 24, y: dividerY))
ctx.strokePath()

// Write PNG
guard let cgImage = ctx.makeImage() else { exit(1) }
let rep = NSBitmapImageRep(cgImage: cgImage)
guard let pngData = rep.representation(using: .png, properties: [:]) else { exit(1) }

let url = URL(fileURLWithPath: outputPath)
try pngData.write(to: url)
print("wrote \(pngData.count) bytes to \(outputPath)")
