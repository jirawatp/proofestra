// Production-path smoke test: after `npm run build`, parse a DOCX and a ZIP
// through the COMPILED extraction module. Proves the built `.js` worker file
// resolves and runs under plain Node, with no tsx loader involved.
//
//   npm run build && node tests/smoke/worker-dist.mjs
//
// To avoid touching `dist/` (which a running server may be using), compile to
// a scratch directory that still resolves `node_modules` and pass it in:
//
//   npx tsc -p tsconfig.server.json --outDir node_modules/.cache/proofestra-worker-smoke
//   node tests/smoke/worker-dist.mjs node_modules/.cache/proofestra-worker-smoke
//
// The argument (or PROOFESTRA_SMOKE_SERVER_DIR) is the compiled `server`
// output root, i.e. the directory that contains `core/`.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const serverDir = path.resolve(
  root,
  process.argv[2] ?? process.env.PROOFESTRA_SMOKE_SERVER_DIR ?? "dist/server",
);
const distCore = path.join(serverDir, "core");
const fixtures = path.join(root, "tests/fixtures/content");

assert.ok(
  fs.existsSync(path.join(distCore, "attachmentWorker.js")),
  "compiled core/attachmentWorker.js is missing; compile the server first",
);
assert.equal(
  process.execArgv.some((a) => a.includes("tsx")),
  false,
  "must run without tsx",
);

const { extractAttachment } = await import(pathToFileURL(path.join(distCore, "attachmentExtraction.js")).href);
const { resolveWorkerLaunch } = await import(pathToFileURL(path.join(distCore, "workerExtraction.js")).href);

const launch = resolveWorkerLaunch(pathToFileURL(path.join(distCore, "workerExtraction.js")).href);
assert.equal(launch.eval, false);
assert.ok(String(launch.entry).endsWith("/core/attachmentWorker.js"));

async function run(rel) {
  const blob = path.join(fixtures, rel);
  return extractAttachment({
    kind: "archive",
    sniffed_mime: "application/zip",
    byte_size: fs.statSync(blob).size,
    blob_path: blob,
    sanitized_display_name: path.basename(blob),
  });
}

const docx = await run("office/proofestra-content.docx");
assert.equal(docx.status, "text_extracted");
assert.ok(docx.extractedText.includes("PROOFESTRA_DOCX_BODY_ORCHID_42"));

const zip = await run("zip/supported-mixed.zip");
assert.equal(zip.status, "truncated");
assert.ok(zip.extractedText.includes("ZIP_JSON_KITE_1618"));
assert.ok(!zip.extractedText.includes("ZIP_NESTED_DO_NOT_RECURSE_31415"));

const hostile = await run("zip/bad-crc.zip");
assert.equal(hostile.status, "failed");
assert.ok(hostile.coverage.label.includes("(crc_mismatch)"));

console.log("worker-dist smoke: ok (built .js worker, no tsx)");
