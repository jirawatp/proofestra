// Minimal, safe-by-construction Markdown renderer. Tokenizes a bounded set of
// Markdown features (paragraphs, headings, lists, inline code, bold/italic,
// code fences, blockquotes, links) and emits a tree of plain-text nodes the
// React component renders without `dangerouslySetInnerHTML`. All text is
// treated as untrusted: raw HTML is ignored, and link URLs are restricted to
// http://, https://, and mailto: schemes.

export type InlineNode =
  | { kind: "text"; value: string }
  | { kind: "code"; value: string }
  | { kind: "bold"; children: InlineNode[] }
  | { kind: "italic"; children: InlineNode[] }
  | { kind: "link"; href: string; children: InlineNode[] };

export type BlockNode =
  | { kind: "paragraph"; children: InlineNode[] }
  | { kind: "heading"; level: 1 | 2 | 3; children: InlineNode[] }
  | { kind: "code"; language: string | null; value: string }
  | { kind: "list"; ordered: boolean; items: InlineNode[][] }
  | { kind: "blockquote"; children: InlineNode[] }
  | { kind: "divider" };

const SAFE_SCHEMES = /^(https?:|mailto:)/i;

export function parseMarkdown(markdown: string): BlockNode[] {
  const blocks: BlockNode[] = [];
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim() || null;
      const buffer: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.startsWith("```")) {
        buffer.push(lines[i]!);
        i += 1;
      }
      if (i < lines.length) i += 1; // closing fence
      blocks.push({ kind: "code", language: lang, value: buffer.join("\n") });
      continue;
    }
    if (/^#{1,3}\s/.test(line)) {
      const match = /^(#{1,3})\s+(.*)$/.exec(line)!;
      blocks.push({ kind: "heading", level: match[1]!.length as 1 | 2 | 3, children: parseInline(match[2]!) });
      i += 1;
      continue;
    }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push({ kind: "divider" });
      i += 1;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const buffer: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) {
        buffer.push(lines[i]!.replace(/^>\s?/, ""));
        i += 1;
      }
      blocks.push({ kind: "blockquote", children: parseInline(buffer.join(" ")) });
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: InlineNode[][] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]!)) {
        items.push(parseInline(lines[i]!.replace(/^\s*[-*]\s+/, "")));
        i += 1;
      }
      blocks.push({ kind: "list", ordered: false, items });
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: InlineNode[][] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i]!)) {
        items.push(parseInline(lines[i]!.replace(/^\s*\d+\.\s+/, "")));
        i += 1;
      }
      blocks.push({ kind: "list", ordered: true, items });
      continue;
    }
    const paragraphLines: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== "" && !isBlockStart(lines[i]!)) {
      paragraphLines.push(lines[i]!);
      i += 1;
    }
    blocks.push({ kind: "paragraph", children: parseInline(paragraphLines.join(" ")) });
  }
  return blocks;
}

function isBlockStart(line: string): boolean {
  return (
    line.startsWith("```") ||
    /^#{1,3}\s/.test(line) ||
    /^(-{3,}|\*{3,})\s*$/.test(line) ||
    /^>\s?/.test(line) ||
    /^\s*[-*]\s+/.test(line) ||
    /^\s*\d+\.\s+/.test(line)
  );
}

export function parseInline(input: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let i = 0;
  const push = (node: InlineNode): void => {
    nodes.push(node);
  };
  while (i < input.length) {
    const char = input[i]!;
    if (char === "`") {
      const end = input.indexOf("`", i + 1);
      if (end === -1) {
        push({ kind: "text", value: input.slice(i) });
        break;
      }
      push({ kind: "code", value: input.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (char === "[") {
      const close = input.indexOf("]", i + 1);
      if (close !== -1 && input[close + 1] === "(") {
        const parenClose = input.indexOf(")", close + 2);
        if (parenClose !== -1) {
          const label = input.slice(i + 1, close);
          const href = input.slice(close + 2, parenClose).trim();
          if (SAFE_SCHEMES.test(href)) {
            push({ kind: "link", href, children: parseInline(label) });
            i = parenClose + 1;
            continue;
          }
        }
      }
    }
    if (char === "*" || char === "_") {
      const double = input[i + 1] === char;
      const marker = double ? char + char : char;
      const end = input.indexOf(marker, i + marker.length);
      if (end !== -1) {
        const inner = input.slice(i + marker.length, end);
        if (double) {
          push({ kind: "bold", children: parseInline(inner) });
        } else {
          push({ kind: "italic", children: parseInline(inner) });
        }
        i = end + marker.length;
        continue;
      }
    }
    // Default: accumulate plain text until next special character.
    let j = i;
    while (j < input.length && !isInlineSpecial(input[j]!)) j += 1;
    if (j === i) j += 1;
    push({ kind: "text", value: input.slice(i, j) });
    i = j;
  }
  return nodes;
}

function isInlineSpecial(char: string): boolean {
  return char === "`" || char === "*" || char === "_" || char === "[";
}
