// @vitest-environment jsdom
// Entry-point wiring: main.tsx mounts the App into #app under StrictMode and
// fails loudly when the root element is missing. react-dom/client is
// intercepted so the real App tree (and its network calls) never runs here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const render = vi.fn();
const createRoot = vi.fn(() => ({ render }));

vi.mock("react-dom/client", () => ({ createRoot }));
vi.mock("../../src/web/App.js", () => ({ App: () => null }));

beforeEach(() => {
  vi.resetModules();
  render.mockClear();
  createRoot.mockClear();
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("main entry", () => {
  it("mounts the app into #app inside React.StrictMode", async () => {
    const root = document.createElement("div");
    root.id = "app";
    document.body.appendChild(root);
    await import("../../src/web/main.js");
    expect(createRoot).toHaveBeenCalledWith(root);
    expect(render).toHaveBeenCalledTimes(1);
    const tree = render.mock.calls[0]![0] as { type: unknown; props: { children: { type: unknown } } };
    expect(String(tree.type)).toContain("react.strict_mode");
    expect(typeof tree.props.children.type).toBe("function");
  });

  it("throws a clear error when #app is missing", async () => {
    await expect(import("../../src/web/main.js")).rejects.toThrow("missing #app root");
    expect(createRoot).not.toHaveBeenCalled();
  });
});
