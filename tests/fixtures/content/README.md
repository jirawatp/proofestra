# Synthetic content-analysis fixtures

Small, generated, **synthetic** inputs for the bounded content-analysis tests
(`tests/integration/content_parsers.test.ts`, `tests/unit/zip_core.test.ts`,
`tests/integration/content_delivery.test.ts`).

- Provenance: produced by generator scripts that live **outside** this
  repository (`make-office-content-fixtures.py`, `make_media_fixtures.py` and
  the PDF/ZIP generators of the original task fixture package, 21 Oct 2026).
  The generators are not copied here; regeneration is not required to run the
  tests. If a generator is ever added, it must be Apache-2.0 compatible.
- No user files, real documents, speech, credentials, provider calls, or
  network access were involved. Audio is a 440 Hz tone or silence.
- `manifest.json` (PDF, ZIP), `office/manifest.json` and
  `media/expected-manifest.json` use paths relative to this directory. Every
  fixture they name is exercised by a test; adding a fixture without mapping
  it makes the manifest-coverage assertion fail.
- Every fixture is a byte-for-byte copy of the generated original EXCEPT
  `office/external-entity.docx`, which was REBUILT: its SYSTEM identifier
  originally held an absolute local path, so it was replaced by the relative
  name below and the manifest size/sha256 were updated.
- `office/external-entity.docx` carries an external XML entity whose SYSTEM
  identifier is the relative name `xxe-sentinel.txt`. The sentinel file is
  deliberately **not** in the repository; the test asserts the document is
  rejected before any entity is read; the test creates the sentinel next to a
  temporary copy so a regression that read it could actually surface it.
- `media/huge-dimensions-header-only.mp4` is **probe-only hostile input**. It
  declares absurd dimensions in a header with no packets. Tests may run
  `ffprobe` on it (FD-only, bounded) but must never decode, transcode,
  thumbnail, or render it, and the UI must never hand it to a media element.
- Passing a fixture proves bounded local parsing only. It does not prove that
  any provider understands the content, and nothing here is a transcript.
