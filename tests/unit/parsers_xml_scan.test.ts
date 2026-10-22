import { describe, expect, it } from "vitest";
import { scanAttributes, scanXml, XmlLimitError, XML_MAX_DEPTH, type XmlHandlers } from "../../src/core/parsers/xmlScan.js";

interface Recorded {
  events: string[];
  attrs: Record<string, Array<[string, string]>>;
}

function scan(xml: string, stopAfter = Number.POSITIVE_INFINITY): Recorded {
  const rec: Recorded = { events: [], attrs: {} };
  let checks = 0;
  const handlers: XmlHandlers = {
    start(uri, local, attrs) {
      rec.events.push(`<${uri}|${local}>`);
      rec.attrs[local] = [...attrs()];
    },
    end(uri, local) {
      rec.events.push(`</${uri}|${local}>`);
    },
    text(raw, isCdata) {
      rec.events.push(`${isCdata ? "cdata" : "text"}:${raw}`);
    },
  };
  scanXml(xml, handlers, () => (checks += 1) > stopAfter);
  return rec;
}

describe("scanAttributes", () => {
  it("reads double- and single-quoted values with surrounding whitespace, without decoding entities", () => {
    expect(scanAttributes(`  a = "1"\n\tb='two &amp; <3'  c="" `)).toEqual([
      ["a", "1"],
      ["b", "two &amp; <3"],
      ["c", ""],
    ]);
  });

  it("keeps duplicates in order (the caller decides which wins)", () => {
    expect(scanAttributes(`a="1" a="2"`)).toEqual([
      ["a", "1"],
      ["a", "2"],
    ]);
  });

  it("starts at the requested offset", () => {
    expect(scanAttributes(`skip="x" keep="y"`, 9)).toEqual([["keep", "y"]]);
  });

  it("ignores bare tokens, unquoted values and a stray equals sign, and keeps scanning", () => {
    expect(scanAttributes(`bare a=unquoted b="ok" =oops c='fine'`)).toEqual([
      ["b", "ok"],
      ["c", "fine"],
    ]);
  });

  it("drops a nameless quoted value but keeps the rest", () => {
    expect(scanAttributes(`="orphan" k="v"`)).toEqual([["k", "v"]]);
  });

  it("stops at an unterminated quote and returns what was already read", () => {
    expect(scanAttributes(`a="1" b="never closed c="3"`)).toEqual([
      ["a", "1"],
      ["b", "never closed c="],
    ]);
    expect(scanAttributes(`a="1" b='open`)).toEqual([["a", "1"]]);
  });

  it("handles empty input, whitespace only, and a name with a trailing equals at the end", () => {
    expect(scanAttributes("")).toEqual([]);
    expect(scanAttributes(" \t\r\n ")).toEqual([]);
    expect(scanAttributes("a=")).toEqual([]);
    expect(scanAttributes("a =  ")).toEqual([]);
  });
});

describe("scanXml tokens", () => {
  it("reports elements with resolved namespaces, text and nesting in document order", () => {
    const r = scan(`<r xmlns="urn:d" xmlns:p="urn:p">a<p:x k="v">b</p:x><y/>c</r>tail`);
    expect(r.events).toEqual([
      "<urn:d|r>",
      "text:a",
      "<urn:p|x>",
      "text:b",
      "</urn:p|x>",
      "<urn:d|y>",
      "</urn:d|y>",
      "text:c",
      "</urn:d|r>",
      "text:tail",
    ]);
    expect(r.attrs["x"]).toEqual([["k", "v"]]);
  });

  it("an unbound prefix and an unprefixed element outside any default namespace have an empty URI; xml: is predeclared", () => {
    const r = scan(`<q:a/><b/><xml:lang/>`);
    expect(r.events).toEqual(["<|a>", "</|a>", "<|b>", "</|b>", "<http://www.w3.org/XML/1998/namespace|lang>", "</http://www.w3.org/XML/1998/namespace|lang>"]);
  });

  it("emits CDATA as raw text flagged cdata (including empty CDATA) and never parses it as markup", () => {
    const r = scan(`<a><![CDATA[<not-a-tag> & stuff]]><![CDATA[]]></a>`);
    expect(r.events).toEqual(["<|a>", "cdata:<not-a-tag> & stuff", "cdata:", "</|a>"]);
  });

  it("skips comments, processing instructions and declarations such as DOCTYPE", () => {
    const r = scan(`<?xml version="1.0"?><!-- <fake/> --><!DOCTYPE a [<!ELEMENT a ANY>]><a>t</a>`);
    // The declaration scanner ends at the first '>' (nothing is resolved); the
    // leftover internal-subset tail is plain text and never an element.
    expect(r.events.filter((e) => /^<[^/]/.test(e))).toEqual(["<|a>"]);
    expect(r.events).toContain("text:t");
    expect(r.events.join("")).not.toContain("fake");
  });

  it("a quoted '>' inside an attribute value does not end the tag", () => {
    const r = scan(`<a href="x>y" t='1>2'>hi</a>`);
    expect(r.attrs["a"]).toEqual([
      ["href", "x>y"],
      ["t", "1>2"],
    ]);
    expect(r.events).toContain("text:hi");
  });

  it("a stray closing tag with an empty stack is ignored", () => {
    const r = scan(`</lonely><a/>`);
    expect(r.events).toEqual(["<|a>", "</|a>"]);
  });

  it("truncated constructs end the scan quietly without throwing or inventing events", () => {
    expect(scan(`<a>x<!-- never closed`).events).toEqual(["<|a>", "text:x"]);
    expect(scan(`<a>x<![CDATA[never closed`).events).toEqual(["<|a>", "text:x"]);
    expect(scan(`<a>x<?pi never closed`).events).toEqual(["<|a>", "text:x"]);
    expect(scan(`<a>x<!DOCTYPE never closed`).events).toEqual(["<|a>", "text:x"]);
    expect(scan(`<a>x<b attr="never closed`).events).toEqual(["<|a>", "text:x"]);
    expect(scan(`<a>x<b`).events).toEqual(["<|a>", "text:x"]);
  });

  it("namespace declarations on a self-closing element are scoped to it; prefix redeclaration restores the outer binding", () => {
    const r = scan(`<r xmlns:p="urn:1"><a xmlns:p="urn:2"><p:in/></a><p:out/><s xmlns:p="urn:3"/><p:after/></r>`);
    const starts = r.events.filter((e) => /^<[^/]/.test(e));
    expect(starts).toEqual(["<|r>", "<|a>", "<urn:2|in>", "<urn:1|out>", "<|s>", "<urn:1|after>"]);
  });

  it("attributes are parsed lazily and only when asked", () => {
    let calls = 0;
    scanXml(`<a x="1"/>`, { start: () => calls++, end() {}, text() {} }, () => false);
    expect(calls).toBe(1);
    const maps: Map<string, string>[] = [];
    scanXml(`<a x="1" y="2"/>`, { start: (_u, _l, attrs) => maps.push(attrs(), attrs()), end() {}, text() {} }, () => false);
    expect(maps[0]!.get("y")).toBe("2");
    expect(maps[1]!.get("x")).toBe("1");
  });

  it("the stop callback ends the scan before the next token", () => {
    const r = scan(`<a>1</a><b>2</b><c>3</c>`, 3);
    expect(r.events.some((e) => e.includes("|c>"))).toBe(false);
    expect(r.events.some((e) => e.includes("|a>"))).toBe(true);
  });

  it("depth exactly at the cap is accepted; one deeper throws XmlLimitError", () => {
    expect(() => scan("<a>".repeat(XML_MAX_DEPTH))).not.toThrow();
    expect(() => scan("<a>".repeat(XML_MAX_DEPTH + 1))).toThrow(XmlLimitError);
    expect(new XmlLimitError().message).toBe("XML nesting or tag too large");
  });

  it("an unterminated tag longer than the 64 KiB cap throws instead of scanning to the end", () => {
    expect(() => scan(`<a ${"x".repeat(70_000)}`)).toThrow(XmlLimitError);
    // Shorter than the cap and unterminated: quiet end.
    expect(() => scan(`<a ${"x".repeat(1_000)}`)).not.toThrow();
  });
});
