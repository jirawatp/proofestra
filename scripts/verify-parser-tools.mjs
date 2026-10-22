import { describeBinaryToolCapabilities } from '../src/core/parsers/binaryTools.ts';
const capabilities = describeBinaryToolCapabilities();
if (!capabilities.pdf_text_extraction || !capabilities.media_metadata_probe) {
  console.error('Required real-parser tools are unavailable: install Poppler and ffprobe; see README.md.');
  process.exitCode = 1;
} else console.log('Parser preflight: Poppler and ffprobe available. Real-fixture tests must run.');
