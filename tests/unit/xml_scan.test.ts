import { describe, expect, it } from "vitest";
import { scanAttributes, scanXml, XmlLimitError, XML_MAX_DEPTH } from "../../src/core/parsers/xmlScan.js";

function uris(xml: string, names: string[]): Record<string, string[]> {
  const seen: Record<string, string[]> = {};
  scanXml(
    xml,
    {
      start(uri, local) {
        if (names.includes(local)) (seen[local] ??= []).push(uri);
      },
      end() {},
      text() {},
    },
    () => false,
  );
  return seen;
}

describe("xmlScan namespace scoping", () => {
  it("restores bindings in reverse order: a duplicate xmlns:p on one element restores the OUTER value", () => {
    // The tokenizer must stay correct on malformed duplicate declarations.
    const xml =
      '<root xmlns:p="urn:outer"><a xmlns:p="urn:one" xmlns:p="urn:two"><p:inner/></a><p:after/></root>';
    const seen = uris(xml, ["inner", "after"]);
    expect(seen["inner"]).toEqual(["urn:two"]);
    expect(seen["after"]).toEqual(["urn:outer"]);
  });

  it("same for a self-closing element and for a prefix not previously bound", () => {
    const sc = uris('<root xmlns:p="urn:outer"><a xmlns:p="urn:x" xmlns:p="urn:y"/><p:after/></root>', ["after"]);
    expect(sc["after"]).toEqual(["urn:outer"]);
    const fresh = uris('<root><a xmlns:q="urn:x" xmlns:q="urn:y"/><q:after/></root>', ["after"]);
    expect(fresh["after"]).toEqual([""]);
  });

  it("the default namespace scopes to its element", () => {
    const seen = uris('<r xmlns="urn:d"><a xmlns="urn:e"><b/></a><c/></r>', ["b", "c"]);
    expect(seen["b"]).toEqual(["urn:e"]);
    expect(seen["c"]).toEqual(["urn:d"]);
  });
});

describe("xmlScan bounds", () => {
  it("a 60 KB attribute run below the tag cap finishes quickly (no quadratic scanning)", () => {
    const run = "a".repeat(60_000);
    const xml = `<w:p xmlns:w="urn:w" ${run} xmlns:x="y"><w:t>hi</w:t></w:p>`;
    const t0 = performance.now();
    let starts = 0;
    scanXml(xml, { start: () => (starts += 1), end() {}, text() {} }, () => false);
    expect(starts).toBe(2);
    expect(performance.now() - t0).toBeLessThan(250);
    const t1 = performance.now();
    scanAttributes(run + '="v" ' + run);
    expect(performance.now() - t1).toBeLessThan(250);
  });

  it("a tag over 64 KiB and nesting over the depth cap throw XmlLimitError", () => {
    expect(() =>
      scanXml(`<a ${"b".repeat(70_000)}>`, { start() {}, end() {}, text() {} }, () => false),
    ).toThrow(XmlLimitError);
    expect(() =>
      scanXml("<a>".repeat(XML_MAX_DEPTH + 1), { start() {}, end() {}, text() {} }, () => false),
    ).toThrow(XmlLimitError);
  });
});
