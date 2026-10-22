// Worker-thread entry for Office/ZIP extraction. It runs the synchronous
// parsers away from the server's event loop so the parent can enforce
// resource limits and call `terminate()` on abort/timeout. This file only
// bridges `workerData` to the parsers: it imports no server configuration,
// storage, or credentials.

import { parentPort, workerData } from "node:worker_threads";
import type { WorkerExtractionInput, WorkerExtractionMessage } from "./workerExtraction.js";
import { extractOfficeTextSync } from "./parsers/office.js";
import { extractZipArchiveSync } from "./parsers/zip.js";

function run(input: WorkerExtractionInput): WorkerExtractionMessage {
  try {
    if (input.operation === "office") {
      return {
        ok: true,
        result: extractOfficeTextSync({
          blob_path: input.blob_path,
          byte_size: input.byte_size,
          office_kind: input.office_kind,
          ...(input.macro_variant ? { macro_variant: true } : {}),
        }),
      };
    }
    return {
      ok: true,
      result: extractZipArchiveSync({ blob_path: input.blob_path, byte_size: input.byte_size }),
    };
  } catch {
    return { ok: false, code: "worker_exception", message: "extraction failed" };
  }
}

parentPort?.postMessage(run(workerData as WorkerExtractionInput));
