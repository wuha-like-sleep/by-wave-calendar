// LegalPage.swift
// Renders bundled Markdown-formatted legal text (LegalContent.privacy /
// .terms) as a scrollable native page. Uses SwiftUI's AttributedString
// markdown parser (iOS 15+) which handles headings, bold, italic,
// inline links, lists and code blocks well enough for our purposes —
// no third-party Markdown dependency needed.
//
// We split the source on blank lines to render each "block" with
// appropriate font sizing for headings (lines starting with #).

import SwiftUI

struct LegalPage: View {
    let title: String
    let markdownSource: String

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                ForEach(blocks, id: \.id) { block in
                    block.view
                }
            }
            .padding(.horizontal, 22)
            .padding(.vertical, 18)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
    }

    /// Pre-parse the source into typed blocks so the body builder stays
    /// declarative and we don't recompute on every layout pass.
    private var blocks: [LegalBlock] {
        var result: [LegalBlock] = []
        // Treat blank lines as separators; each chunk is one block.
        let chunks = markdownSource
            .split(separator: "\n\n", omittingEmptySubsequences: true)
            .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        for (i, chunk) in chunks.enumerated() {
            result.append(LegalBlock(id: "block-\(i)", raw: chunk))
        }
        return result
    }
}

private struct LegalBlock: Identifiable {
    let id: String
    let raw: String

    @ViewBuilder
    var view: some View {
        if raw.hasPrefix("# ") {
            // H1 — page title (rendered inline since the navigationTitle
            // already shows it, but keeping for visual weight).
            Text(raw.dropFirst(2))
                .font(.title.bold())
                .padding(.top, 4)
        } else if raw.hasPrefix("## ") {
            Text(raw.dropFirst(3))
                .font(.title3.weight(.semibold))
                .padding(.top, 6)
        } else if raw.hasPrefix("### ") {
            Text(raw.dropFirst(4))
                .font(.body.weight(.semibold))
                .padding(.top, 4)
        } else if raw.hasPrefix("---") {
            Divider()
        } else if raw.contains("\n- ") || raw.hasPrefix("- ") {
            // Bulleted list — split on newlines, render each item as a
            // row with a leading dot. AttributedString markdown can do
            // this too but loses fine-grained control over indent.
            let items = raw.components(separatedBy: "\n").filter { $0.hasPrefix("- ") }
            VStack(alignment: .leading, spacing: 6) {
                ForEach(items, id: \.self) { line in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("•").foregroundStyle(.secondary)
                        Text(inlineMarkdown(String(line.dropFirst(2))))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        } else {
            // Plain paragraph — inline markdown (links, bold, code).
            Text(inlineMarkdown(raw))
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// AttributedString markdown parser handles **bold**, *italic*,
    /// `code`, [link](url), and reference-style links. Falls back to
    /// the raw string on parse failure so we never show "" content.
    private func inlineMarkdown(_ s: String) -> AttributedString {
        do {
            // .inlineOnlyPreservingWhitespace keeps line breaks inside
            // a paragraph (e.g. when source uses trailing \ for soft
            // wrap) and avoids the parser eating leading whitespace.
            var attr = try AttributedString(markdown: s, options: AttributedString.MarkdownParsingOptions(
                interpretedSyntax: .inlineOnlyPreservingWhitespace,
            ))
            // Style links — default is system blue which clashes with
            // our brand tint. Replacing the foreground color preserves
            // the underline.
            for run in attr.runs {
                if run.link != nil {
                    attr[run.range].foregroundColor = .accentColor
                }
            }
            return attr
        } catch {
            return AttributedString(s)
        }
    }
}
