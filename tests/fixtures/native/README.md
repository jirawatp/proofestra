# Native backend fixtures

Captured from the installed `codex-cli 0.163.0` with harmless, non-inference
commands only, using an empty scratch `CODEX_HOME` and a credential-free
environment. They contain a feature table (name, stage, effective state) and
no credential, path, account or conversation data.

- `codex-0.163.0-features-default.txt`: `codex features list` with no overrides.
- `codex-0.163.0-features-denied.txt`: `codex features list` with the Proofestra
  deny overrides (`--disable <feature>` for every entry of
  `CODEX_DENIED_FEATURES` plus `-c web_search="disabled"`). Note
  `unified_exec` is still `true`: the installed CLI does not let that switch be
  turned off per invocation. That recorded fact is why Codex execution stays
  fail-closed (`unified_exec_not_disableable` in `CODEX_VERIFICATION`).

Re-capture per CLI version; never edit by hand.
