// A small, strictly linear XML tokenizer for the Office extractors. It builds
// no DOM, resolves no entity, DTD or external reference, and never evaluates
// anything: it only reports elements (namespace URI + local name), their
// attributes on request, and character data.
//
// Bounds (all enforced while scanning, never after):
//   - element depth at most 256, so scoped prefix state stays O(1) per element;
//   - a single tag at most 64 KiB;
//   - every scan advances monotonically; attribute and namespace handling is a
//     hand-written scanner, not a backtracking regular expression.
// Exceeding a bound throws `XmlLimitError`; the caller refuses the document.

export const XML_MAX_DEPTH = 256;
export const XML_MAX_TAG_CHARS = 64 * 1024;

export class XmlLimitError extends Error {
  constructor() {
    super("XML nesting or tag too large");
    this.name = "XmlLimitError";
  }
}

export interface XmlHandlers {
  start(uri: string, local: string, attrs: () => Map<string, string>): void;
  end(uri: string, local: string): void;
  text(raw: string, isCdata: boolean): void;
}

function isWs(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r";
}

/** Linear attribute scanner. Entities in values are NOT decoded. */
export function scanAttributes(s: string, from = 0): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const n = s.length;
  let i = from;
  while (i < n) {
    while (i < n && isWs(s[i]!)) i += 1;
    if (i >= n) break;
    const nameStart = i;
    while (i < n && !isWs(s[i]!) && s[i] !== "=") i += 1;
    const name = s.slice(nameStart, i);
    while (i < n && isWs(s[i]!)) i += 1;
    if (s[i] !== "=") {
      // A bare token without a value: nothing to record; progress is
      // guaranteed because the name loop consumed at least one character.
      if (i === nameStart) i += 1;
      continue;
    }
    i += 1;
    while (i < n && isWs(s[i]!)) i += 1;
    const quote = s[i];
    if (quote !== '"' && quote !== "'") {
      if (i < n) i += 1;
      continue;
    }
    const close = s.indexOf(quote, i + 1);
    if (close < 0) break;
    if (name) out.push([name, s.slice(i + 1, close)]);
    i = close + 1;
  }
  return out;
}

const XML_NS = "http://www.w3.org/XML/1998/namespace";

interface Frame {
  uri: string;
  local: string;
  // Prefix bindings this element overrode, restored on close.
  saved: Array<[string, string | undefined]> | null;
}

export function scanXml(xml: string, h: XmlHandlers, stop: () => boolean): void {
  const stack: Frame[] = [];
  const bindings = new Map<string, string>([["xml", XML_NS]]);
  const n = xml.length;
  let i = 0;

  // Undo an element's prefix bindings in REVERSE order of declaration, so a
  // duplicate `xmlns:p` on one element restores the value that was in force
  // before the element, not the element's own first binding.
  const restore = (saved: Frame["saved"]): void => {
    if (!saved) return;
    for (let k = saved.length - 1; k >= 0; k -= 1) {
      const [prefix, prev] = saved[k]!;
      if (prev === undefined) bindings.delete(prefix);
      else bindings.set(prefix, prev);
    }
  };

  while (i < n && !stop()) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) {
      h.text(xml.slice(i), false);
      break;
    }
    if (lt > i) h.text(xml.slice(i, lt), false);
    if (xml.startsWith("<!--", lt)) {
      const e = xml.indexOf("-->", lt + 4);
      if (e < 0) break;
      i = e + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const e = xml.indexOf("]]>", lt + 9);
      if (e < 0) break;
      h.text(xml.slice(lt + 9, e), true);
      i = e + 3;
      continue;
    }
    if (xml.startsWith("<?", lt)) {
      const e = xml.indexOf("?>", lt + 2);
      if (e < 0) break;
      i = e + 2;
      continue;
    }
    if (xml.startsWith("<!", lt)) {
      const e = xml.indexOf(">", lt + 2);
      if (e < 0) break;
      i = e + 1;
      continue;
    }
    // Find the closing '>' while honouring quoted attribute values.
    let j = lt + 1;
    let quote = "";
    while (j < n) {
      if (j - lt > XML_MAX_TAG_CHARS) throw new XmlLimitError();
      const c = xml[j]!;
      if (quote) {
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'") quote = c;
      else if (c === ">") break;
      j += 1;
    }
    if (j >= n) break;
    i = j + 1;
    if (xml[lt + 1] === "/") {
      const frame = stack.pop();
      if (frame) {
        restore(frame.saved);
        h.end(frame.uri, frame.local);
      }
      continue;
    }
    const selfClosing = xml[j - 1] === "/";
    const bodyEnd = selfClosing ? j - 1 : j;
    let k = lt + 1;
    while (k < bodyEnd && !isWs(xml[k]!)) k += 1;
    const qname = xml.slice(lt + 1, k);
    const attrSource = xml.slice(k, bodyEnd);
    let saved: Frame["saved"] = null;
    let attrCache: Array<[string, string]> | null = null;
    const attrList = (): Array<[string, string]> => (attrCache ??= scanAttributes(attrSource));
    if (attrSource.indexOf("xmlns") >= 0) {
      for (const [name, value] of attrList()) {
        let prefix: string | null = null;
        if (name === "xmlns") prefix = "";
        else if (name.startsWith("xmlns:")) prefix = name.slice(6);
        if (prefix === null) continue;
        (saved ??= []).push([prefix, bindings.get(prefix)]);
        bindings.set(prefix, value);
      }
    }
    const colon = qname.indexOf(":");
    const prefix = colon < 0 ? "" : qname.slice(0, colon);
    const local = colon < 0 ? qname : qname.slice(colon + 1);
    const uri = bindings.get(prefix) ?? "";
    const attrs = (): Map<string, string> => new Map(attrList());
    h.start(uri, local, attrs);
    if (selfClosing) {
      restore(saved);
      h.end(uri, local);
    } else {
      if (stack.length >= XML_MAX_DEPTH) throw new XmlLimitError();
      stack.push({ uri, local, saved });
    }
  }
}
