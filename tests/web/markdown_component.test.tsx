// @vitest-environment jsdom
import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Markdown } from "../../src/web/components/Markdown.js";

afterEach(cleanup);

describe("<Markdown> DOM rendering", () => {
  it("renders every block kind as semantic elements", () => {
    const { container } = render(
      <Markdown
        text={[
          "# H1",
          "## H2",
          "### H3",
          "para **bold** *it* `code` [ok](https://a.test)",
          "- u1",
          "- u2",
          "1. o1",
          "2. o2",
          "> quote",
          "---",
          "```py",
          "print(1)",
          "```",
          "```",
          "bare",
          "```",
        ].join("\n")}
      />,
    );
    expect(container.querySelector("h1")?.textContent).toBe("H1");
    expect(container.querySelector("h2")?.textContent).toBe("H2");
    expect(container.querySelector("h3")?.textContent).toBe("H3");
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("em")?.textContent).toBe("it");
    expect(container.querySelectorAll("ul li")).toHaveLength(2);
    expect(container.querySelectorAll("ol li")).toHaveLength(2);
    expect(container.querySelector("blockquote")?.textContent).toBe("quote");
    expect(container.querySelector("hr")).not.toBeNull();
    expect(container.querySelector("pre code.lang-py")?.textContent).toBe("print(1)");
    const bare = container.querySelectorAll("pre code");
    expect(bare[1]?.getAttribute("class")).toBeNull();
    const a = container.querySelector("a")!;
    expect(a.getAttribute("href")).toBe("https://a.test");
    expect(a.getAttribute("rel")).toBe("noreferrer noopener");
    expect(a.getAttribute("target")).toBe("_blank");
  });

  it("renders untrusted HTML and javascript: links as inert text", () => {
    const { container } = render(
      <Markdown text={'<img src=x onerror="window.pwned=1"> [x](javascript:alert(1)) <script>window.pwned=2</script>'} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("<img src=x");
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
  });

  it("re-parses when the text prop changes", () => {
    const { container, rerender } = render(<Markdown text="# one" />);
    expect(container.querySelector("h1")?.textContent).toBe("one");
    rerender(<Markdown text="## two" />);
    expect(container.querySelector("h1")).toBeNull();
    expect(container.querySelector("h2")?.textContent).toBe("two");
  });
});
