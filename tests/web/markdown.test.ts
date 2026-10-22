import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown } from "../../src/web/markdown.js";

describe("parseMarkdown block structure", () => {
  it("returns no blocks for empty or whitespace-only input", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("  \n\t\n")).toEqual([]);
  });

  it("normalizes CRLF and CR line endings", () => {
    const blocks = parseMarkdown("one\r\ntwo\rthree\n\nfour");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({
      kind: "paragraph",
      children: [{ kind: "text", value: "one two three" }],
    });
  });

  it("parses headings of levels 1-3 and leaves #### as a paragraph", () => {
    const blocks = parseMarkdown("# One\n## Two\n### Three\n#### Four");
    expect(blocks.map((b) => (b.kind === "heading" ? b.level : b.kind))).toEqual([1, 2, 3, "paragraph"]);
  });

  it("does not treat '#word' without a space as a heading", () => {
    expect(parseMarkdown("#hashtag")[0]?.kind).toBe("paragraph");
  });

  it("parses fenced code with and without language, keeping content verbatim", () => {
    const blocks = parseMarkdown("```ts\nconst a = <b>1</b>;\n  indented\n```\n```\nplain\n```");
    expect(blocks).toEqual([
      { kind: "code", language: "ts", value: "const a = <b>1</b>;\n  indented" },
      { kind: "code", language: null, value: "plain" },
    ]);
  });

  it("tolerates an unterminated fence by consuming to the end", () => {
    const blocks = parseMarkdown("```js\nnever closed\nstill code");
    expect(blocks).toEqual([{ kind: "code", language: "js", value: "never closed\nstill code" }]);
  });

  it("parses dividers made of --- or ***", () => {
    expect(parseMarkdown("---\n***\n-----").map((b) => b.kind)).toEqual(["divider", "divider", "divider"]);
  });

  it("joins consecutive blockquote lines", () => {
    const blocks = parseMarkdown("> first\n>second\n> third");
    expect(blocks).toEqual([
      { kind: "blockquote", children: [{ kind: "text", value: "first second third" }] },
    ]);
  });

  it("parses unordered lists with - and * markers and indentation", () => {
    const blocks = parseMarkdown("- a\n* b\n  - c");
    expect(blocks).toHaveLength(1);
    const list = blocks[0]!;
    expect(list.kind).toBe("list");
    if (list.kind === "list") {
      expect(list.ordered).toBe(false);
      expect(list.items).toHaveLength(3);
    }
  });

  it("parses ordered lists", () => {
    const blocks = parseMarkdown("1. one\n2. two\n10. ten");
    const list = blocks[0]!;
    expect(list.kind === "list" && list.ordered).toBe(true);
    expect(list.kind === "list" && list.items.length).toBe(3);
  });

  it("ends a paragraph at the next block start without a blank line", () => {
    const blocks = parseMarkdown("para line\n# heading\ntext\n- item\nmore\n1. n\n> q\n---\n```\nx\n```");
    expect(blocks.map((b) => b.kind)).toEqual([
      "paragraph",
      "heading",
      "paragraph",
      "list",
      "paragraph",
      "list",
      "blockquote",
      "divider",
      "code",
    ]);
  });
});

describe("parseInline", () => {
  it("parses inline code and keeps markup inside it literal", () => {
    expect(parseInline("a `**x**` b")).toEqual([
      { kind: "text", value: "a " },
      { kind: "code", value: "**x**" },
      { kind: "text", value: " b" },
    ]);
  });

  it("keeps an unterminated backtick as text through the end", () => {
    expect(parseInline("tick ` open")).toEqual([
      { kind: "text", value: "tick " },
      { kind: "text", value: "` open" },
    ]);
  });

  it("parses bold with ** and __ and italic with * and _, including nesting", () => {
    expect(parseInline("**b**")).toEqual([{ kind: "bold", children: [{ kind: "text", value: "b" }] }]);
    expect(parseInline("__b__")).toEqual([{ kind: "bold", children: [{ kind: "text", value: "b" }] }]);
    expect(parseInline("*i*")).toEqual([{ kind: "italic", children: [{ kind: "text", value: "i" }] }]);
    expect(parseInline("_i_")).toEqual([{ kind: "italic", children: [{ kind: "text", value: "i" }] }]);
    const nested = parseInline("**bold *it***");
    expect(nested[0]?.kind).toBe("bold");
  });

  it("treats an unmatched emphasis marker as plain text", () => {
    expect(parseInline("2 * 3")).toEqual([
      { kind: "text", value: "2 " },
      { kind: "text", value: "*" },
      { kind: "text", value: " 3" },
    ]);
  });

  it("allows only http, https and mailto links", () => {
    for (const href of ["http://a.test/x", "https://a.test/x", "HTTPS://A.TEST", "mailto:me@a.test"]) {
      const nodes = parseInline(`[label](${href})`);
      expect(nodes).toEqual([{ kind: "link", href, children: [{ kind: "text", value: "label" }] }]);
    }
  });

  it("never creates a link for dangerous or relative schemes", () => {
    for (const href of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "data:text/html;base64,AAAA",
      "vbscript:x",
      "file:///etc/passwd",
      "//evil.test/x",
      "/relative",
      " javascript:alert(1)",
    ]) {
      const nodes = parseInline(`[click](${href})`);
      const flat = JSON.stringify(nodes);
      expect(flat).not.toContain('"kind":"link"');
    }
  });

  it("falls back to text when the link is malformed", () => {
    expect(JSON.stringify(parseInline("[no close"))).not.toContain("link");
    expect(JSON.stringify(parseInline("[a](unterminated"))).not.toContain("link");
    expect(JSON.stringify(parseInline("[a] (spaced)"))).not.toContain("link");
  });

  it("does not interpret raw HTML", () => {
    const nodes = parseInline("<script>alert(1)</script>");
    expect(nodes).toEqual([{ kind: "text", value: "<script>alert(1)</script>" }]);
  });
});
