// Discovery of trusted bounded command-line parsers that back the
// server-side attachment-extraction pipeline. The server only ever shells
// out to a FIXED, pre-discovered absolute path with a NON-SHELL `spawn`
// invocation; it never passes the user's filename to any OS call, never
// uses `exec`, never resolves a binary from `$PATH` at request time.
//
// We expose discovered binaries as BOOLEAN capability flags on the public
// `/providers` surface (per the "check only app-specific provider setup
// presence as booleans" rule): the UI can decide "PDF text extraction is
// available / unavailable" without ever learning *which* binary, which
// version, or which path powers it. Values are kept server-side only.

import fs from "node:fs";
import { spawnSync } from "node:child_process";

/**
 * Fixed candidate list for each trusted binary. The lookup is "pick the
 * first entry that exists AND passes a `-v` / `-version` probe". We
 * deliberately search a short list of KNOWN installer paths rather than
 * resolving `$PATH`; the production server has a fixed install location
 * and we would rather fail closed than accept whatever shows up on the
 * caller's path. The user's shell is never consulted.
 *
 * Each candidate list is tried once at module load; the discovered path
 * and version string are cached for the lifetime of the process. If the
 * binary disappears later the next spawn will fail cleanly with a
 * sanitized `extraction_unavailable` label — we do not re-probe.
 */
const POPPLER_PDFINFO_CANDIDATES = [
  "/opt/homebrew/bin/pdfinfo",
  "/usr/local/bin/pdfinfo",
  "/usr/bin/pdfinfo",
] as const;

const POPPLER_PDFTOTEXT_CANDIDATES = [
  "/opt/homebrew/bin/pdftotext",
  "/usr/local/bin/pdftotext",
  "/usr/bin/pdftotext",
] as const;

const FFPROBE_CANDIDATES = [
  "/opt/homebrew/bin/ffprobe",
  "/usr/local/bin/ffprobe",
  "/usr/bin/ffprobe",
] as const;

export interface DiscoveredBinary {
  path: string;
  version: string;
}

export interface BinaryToolCapabilities {
  // True iff BOTH `pdfinfo` AND `pdftotext` from the same Poppler install
  // are discoverable and respond to `-v`. The PDF extractor needs both
  // to produce a bounded page count AND bounded text.
  pdf_text_extraction: boolean;
  // True iff `ffprobe` is discoverable and responds to `-version`. Audio
  // and video native routing REQUIRES this binary — without it the
  // server refuses to admit audio/video as native (there is no safe
  // fallback for a validated duration + stream dimensions).
  media_metadata_probe: boolean;
}

interface ResolvedBinaries {
  pdfinfo: DiscoveredBinary | null;
  pdftotext: DiscoveredBinary | null;
  ffprobe: DiscoveredBinary | null;
}

let cachedBinaries: ResolvedBinaries | null = null;

function probeBinary(candidates: readonly string[], flag: string): DiscoveredBinary | null {
  for (const path of candidates) {
    try {
      const stat = fs.statSync(path);
      if (!stat.isFile()) continue;
    } catch {
      continue;
    }
    // `spawnSync` is only used ONCE at process boot, with a fixed
    // absolute path, no shell, no user input. The output is bounded by
    // a 2 KiB stdio cap and a 1 second timeout. On any failure we fall
    // through to the next candidate (or null).
    try {
      const r = spawnSync(path, [flag], {
        shell: false,
        timeout: 1_000,
        maxBuffer: 2 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        // The same fixed environment as every extraction child: the server's
        // own environment (which may hold provider keys) is never inherited.
        env: { LC_ALL: "C", PATH: "/usr/bin:/bin" },
      });
      // Poppler writes to stderr on `-v`; ffprobe writes to stdout on
      // `-version`. Accept either channel. The version string is kept
      // server-side only (never surfaced to the UI).
      const combined = `${r.stdout?.toString?.("utf-8") ?? ""}${r.stderr?.toString?.("utf-8") ?? ""}`.trim();
      if (combined.length === 0) continue;
      const firstLine = combined.split(/\r?\n/, 1)[0]!.slice(0, 120);
      return { path, version: firstLine };
    } catch {
      continue;
    }
  }
  return null;
}

function resolveBinaries(): ResolvedBinaries {
  if (cachedBinaries) return cachedBinaries;
  cachedBinaries = {
    pdfinfo: probeBinary(POPPLER_PDFINFO_CANDIDATES, "-v"),
    pdftotext: probeBinary(POPPLER_PDFTOTEXT_CANDIDATES, "-v"),
    ffprobe: probeBinary(FFPROBE_CANDIDATES, "-version"),
  };
  return cachedBinaries;
}

/**
 * Test-only hook. Allows a vitest to reset the cached discovery and
 * re-probe (e.g. after temporarily hiding a binary). Never called from
 * production code paths.
 */
export function __resetBinaryToolsCache(): void {
  cachedBinaries = null;
}

/**
 * Returns the discovered absolute path for `pdfinfo` + `pdftotext` iff
 * BOTH are available (we require matched Poppler pair; a half-install
 * is treated as unavailable).
 */
export function discoverPopplerPair(): { pdfinfo: DiscoveredBinary; pdftotext: DiscoveredBinary } | null {
  const r = resolveBinaries();
  if (!r.pdfinfo || !r.pdftotext) return null;
  return { pdfinfo: r.pdfinfo, pdftotext: r.pdftotext };
}

/** Returns the discovered absolute path for `ffprobe`, or `null`. */
export function discoverFfprobe(): DiscoveredBinary | null {
  return resolveBinaries().ffprobe;
}

/**
 * Boolean capability snapshot. This is the ONLY shape the UI / API /
 * export is allowed to see; concrete binary paths and version strings
 * never leave the server process.
 */
export function describeBinaryToolCapabilities(): BinaryToolCapabilities {
  const r = resolveBinaries();
  return {
    pdf_text_extraction: Boolean(r.pdfinfo) && Boolean(r.pdftotext),
    media_metadata_probe: Boolean(r.ffprobe),
  };
}
