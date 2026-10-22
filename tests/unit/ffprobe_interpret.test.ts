// Synthetic ffprobe JSON through the pure interpreter: no process, no file.
import { describe, expect, it } from "vitest";
import { interpretProbeJson } from "../../src/core/parsers/ffprobe.js";

const mp4Format = (duration?: unknown) => ({
  format_name: "mov,mp4,m4a,3gp,3g2,mj2",
  ...(duration === undefined ? {} : { duration }),
});
const video = (extra: object = {}) => ({ codec_type: "video", codec_name: "h264", width: 160, height: 90, ...extra });
const audio = (extra: object = {}) => ({ codec_type: "audio", codec_name: "aac", ...extra });

describe("interpretProbeJson", () => {
  it("a valid file validates and the policy duration is the largest of container and streams", () => {
    const r = interpretProbeJson(
      { format: mp4Format("1.000000"), streams: [video({ duration: "1.5" }), audio({ duration: "1.0" })] },
      "video/mp4",
    );
    expect(r.reason).toBeNull();
    expect(r.normalized_mime).toBe("video/mp4");
    expect(r.duration_seconds).toBe(1.5);
  });

  it("a missing or invalid CONTAINER duration is refused even when streams report valid durations", () => {
    for (const container of [undefined, "N/A", "0", "-3", "abc", String(24 * 3600 + 1)]) {
      const r = interpretProbeJson(
        { format: mp4Format(container), streams: [video({ duration: "5.0" }), audio({ duration: "5.0" })] },
        "video/mp4",
      );
      expect(r.reason, String(container)).toBe("duration not reported or invalid");
      expect(r.normalized_mime).toBeNull();
      expect(r.duration_seconds).toBeNull();
    }
  });

  it("a stream that reports an invalid duration (including over 24 h) fails validation", () => {
    for (const bad of ["N/A", "0", "-1", "nope", String(24 * 3600 + 1), 90_000]) {
      const r = interpretProbeJson(
        { format: mp4Format("1.0"), streams: [video(), audio({ duration: bad })] },
        "video/mp4",
      );
      expect(r.reason, String(bad)).toBe("stream duration invalid");
      expect(r.normalized_mime).toBeNull();
      expect(r.streams).toEqual([]);
    }
    // A stream with NO duration key is fine (WebM and many MP4 tracks omit it).
    const ok = interpretProbeJson({ format: mp4Format("1.0"), streams: [video(), audio()] }, "video/mp4");
    expect(ok.reason).toBeNull();
  });

  it("more than 8 raw streams is refused before any filtering", () => {
    const nine = [video(), ...Array.from({ length: 7 }, () => audio()), { codec_type: "subtitle", codec_name: "mov_text" }];
    expect(nine).toHaveLength(9);
    const r = interpretProbeJson({ format: mp4Format("1.0"), streams: nine }, "video/mp4");
    expect(r.reason).toBe("more than 8 streams");
    expect(r.normalized_mime).toBeNull();
    expect(r.streams).toEqual([]);
    const eight = interpretProbeJson({ format: mp4Format("1.0"), streams: nine.slice(0, 8) }, "video/mp4");
    expect(eight.reason).toBeNull();
  });

  it("an unnamed audio/video codec makes the file unvalidated", () => {
    const r = interpretProbeJson(
      { format: mp4Format("1.0"), streams: [video(), { codec_type: "audio" }] },
      "video/mp4",
    );
    expect(r.reason).toBe("unidentified stream codec");
  });
});
