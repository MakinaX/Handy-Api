# Handy Gemini implementation report

Date: 2026-08-30 KST

Baseline branch: `handy-gemini-v0.9.6`

Baseline tag/commit: `v0.9.6` / `af48dd68a64d58aad128fdbb920492a03da53c79`

## Verdict

The local implementation and release scaffolding are substantially complete,
but this checkout does **not** yet satisfy the brief's final completion
standard. A Windows artifact has not been built, and the live Gemini, physical
microphone, cursor-paste, Credential Manager, installer-isolation, and updater
paths have not been exercised on Windows.

The public repository identity is now bound to `MakinaX/Handy-Gemini`. Release
mode deliberately remains fail-closed until the Director supplies a dedicated
Tauri updater keypair and the protected publication environment. The exact
one-time procedure is in `Docs/HANDY-GEMINI-ONE-TIME-SETUP.md`.

## Fresh baseline and adopted upstream work

- Official stable baseline was verified as Handy `v0.9.6`, released
  2026-08-24.
- The fork is based on the stable tag rather than untagged `main`.
- Two narrowly relevant post-tag fixes were adopted: the tail-audio fix
  (`df2168326e360f7c52d57b896cc624fb66e1c035`) and production transcript-log
  redaction (`258899a260b5c67769a8de16a6e41589b9a7063e`).
- Experimental Earshot VAD and the dirty/open silent-input PR were inspected
  but not imported wholesale. The fork keeps stable Silero VAD and adds the
  provider-independent evidence guard locally.

## Implemented product delta

### Gemini backend

- Isolated Gemini adapter using `gemini-3.5-transcribe` with 16 kHz mono
  signed-16-bit WAV input.
- Smart/Verbatim modes, Auto or validated BCP-47 language, and existing Handy
  dictionary words mapped to Gemini custom vocabulary.
- Request-size, timeout, malformed-response, quota/API, and sanitized-error
  handling.
- API keys stored in Windows Credential Manager under the fork-owned
  `computer.handy.gemini` / `gemini-api-key` identity.
- A typed replacement key can be tested without overwriting an existing
  working key; Save remains an explicit action.
- Backend selection is separate from local model download/inference ownership.

### Speech-presence and hallucination guard

- Capture evidence records raw sample count/duration, output sample count,
  peak, RMS, exact-zero/non-finite state, VAD analyzed/voiced/error frames, and
  confirmed two-frame speech onsets.
- Stage A/B rejects strong no-speech before Local inference, Gemini request,
  WAV/history persistence, or paste.
- Live provider callbacks are held behind a bounded one-second pre-roll latch
  until the same confirmed Silero onset. Missing/erroring VAD never opens that
  streaming latch.
- Stage C rejects borderline/no-onset transcripts without affirmative provider
  speech evidence. Lexical patterns are only a secondary signal; real speech
  with a confirmed onset is not rejected merely for containing a stock phrase.
- The same guard is used for Local and Gemini paths.

### ESC hard cancellation

- Literal Escape is an invariant cancel binding; imported/custom cancel
  bindings are normalized while the Director's F1 transcription mapping is
  preserved.
- Escape remains registered throughout recording and pending output work.
- Shortcut register/unregister operations use one ordered worker, preventing an
  older operation's unregister from removing a newer operation's binding.
- Gemini upload admission and Escape share an atomic linearization state:
  Escape-before-admission prevents the request future from being polled;
  admission-before-Escape is treated as in-flight and its result is logically
  discarded.
- Paste and Escape also share an atomic claim, closing the final check-to-paste
  race.
- Cancel/error paths suppress successful history and remove uncommitted WAV
  artifacts.

### Settings, local path, and identity

- Backend/mode/language and local transcription settings are snapshotted at
  operation arm time.
- Switch, unload, idle-unload, and model deletion share an engine-mutation
  reservation with recording/transcription, so the active local engine cannot
  change underneath an operation.
- VAD-disabled batch capture remains unfiltered while observational VAD still
  protects live streaming.
- First-run Windows import reads official Handy settings once, copies compatible
  preferences into the fork store, strips secrets, and disables conflicting
  fork autostart/post-processing defaults.
- Product, executable, Tauri identifier/data directory, logs, portable marker,
  Credential Manager service, installer/uninstall identity, and updater feed
  are distinct from official Handy.

### Update and release ownership

- `handy-gemini-ci.yml` owns deterministic frontend, Playwright, Rust format,
  test, and Clippy gates.
- The statically parsed `upstream-sync.yml` is configured to auto-resolve only
  five allowlisted release-metadata conflicts and reject unexpected or
  unresolved conflicts and test failures. It then builds Windows x64 NSIS,
  performs an installed runtime/DLL smoke, and verifies the Tauri signature
  cryptographically.
- The exact signed artifact remains a private workflow artifact while the
  publish job waits on the protected `handy-gemini-production` environment.
  After the Director records the Windows acceptance evidence and approves that
  deployment, the job uploads a draft, reads back the exact bytes, advances
  `main`, and only then publishes.
- Fork workflow actions are pinned to full commit SHAs, and workflow YAML
  declares Bun 1.2.23 and Rust 1.88.0. The release-contract script checks
  locked install/test commands, updater identity, Windows bundle and release
  inventory invariants, the protected environment, and action SHA pinning.
- Inherited official release/build workflows are repository-identity gated and
  cannot publish this fork.

## Verification record

| Check                                           | Result               | Evidence / limitation                                                 |
| ----------------------------------------------- | -------------------- | --------------------------------------------------------------------- |
| Frozen Bun dependency install                   | PASS                 | `bun install --frozen-lockfile`                                       |
| Translation parity                              | PASS                 | 452 keys; all 23 non-English locales complete                         |
| ESLint                                          | PASS                 | full `eslint src`                                                     |
| Prettier                                        | PASS                 | full repository check                                                 |
| TypeScript + production Vite build              | PASS                 | 2,117 modules; only inherited large-chunk warnings                    |
| Portable updater unit assertions                | PASS                 | all assertions passed                                                 |
| Playwright                                      | PASS                 | 2/2 tests in Playwright 1.58.0 Noble container                        |
| Workflow YAML parse                             | PASS                 | both fork workflows parsed                                            |
| Release contract, scaffold mode                 | PASS                 | `0.9.6-gemini.1`, placeholders allowed                                |
| Release contract, release mode                  | EXPECTED FAIL-CLOSED | only the updater-public-key placeholder remains                       |
| Rustfmt                                         | PASS                 | Rust 1.88 toolchain, all targets                                      |
| Pure speech-guard regression suite              | PASS                 | 13/13 deterministic tests                                             |
| Static P0/P1 Rust integration audit             | PASS                 | no remaining static blocker after final caller/state review           |
| Locked Rust tests, Linux target                 | PASS                 | `cargo test --locked`; 261 passed, 0 failed; Windows cfg not compiled |
| Clippy defect groups, Linux target              | PASS                 | all targets; correctness/suspicious/perf denied; style debt allowed   |
| Windows x64 compile/package                     | NOT EXECUTED         | requires native `windows-latest` workflow run                         |
| Actual Local model load/transcription           | NOT EXECUTED         | no model/runtime acceptance corpus in this host session               |
| Actual Silero + real WAV/noise/utterance corpus | NOT VALIDATED        | current deterministic guard tests synthesize evidence/signals         |
| Repeated Whisper hallucination runs             | NOT VALIDATED        | local model/runtime corpus unavailable in this host session           |
| Live Gemini acceptance corpus                   | NOT EXECUTED         | Gemini API key is unavailable                                         |
| Windows F1/ESC/paste/history/manual matrix      | NOT EXECUTED         | no Windows runtime/runner in the local environment                    |
| Windows migration/Credential Manager            | NOT EXECUTED         | Windows app-data and credential APIs unavailable locally              |
| Windows installer/runtime/update retention      | NOT EXECUTED         | updater keys and Windows Actions run are unavailable                  |

## External capability state

- GitHub CLI/authentication: unavailable/unset.
- Public fork repository: `MakinaX/Handy-Gemini`, verified public and configured
  as `origin`; it remains empty until an authenticated initial push succeeds.
- Official `cjpais/Handy`: retained as fetch-only `upstream` with push disabled.
- Tauri updater private key/password: unset.
- Fork GitHub owner: bound to `MakinaX`; updater public key: intentional
  fail-closed placeholder.
- Windows Authenticode identity: not configured. Tauri updater signatures are
  separate; the first personal installer may display Unknown Publisher.
- Local Windows build capability: unavailable on this x86_64 Linux
  host. The release workflow uses native `windows-latest` instead.

No credential values were read, logged, or added to the repository.

## Required closure before calling the fork complete

1. Complete the authenticated initial push, updater-key, workflow-permission,
   and protected publication-environment setup.
2. Run `handy-gemini-ci.yml`, then run the upstream-sync workflow until its
   `publish-release` job is waiting for Director approval.
3. Download that run's exact signed Windows x64 artifact, install it alongside
   official Handy, and execute the unchecked
   [Windows acceptance checklist](HANDY-GEMINI-WINDOWS-ACCEPTANCE.md).
4. Preserve the Actions URL, candidate SHA, artifact hashes, and redacted manual
   evidence in this report.
5. Only after every blocking item passes, approve
   `handy-gemini-production`; the same run then verifies its draft bytes,
   fast-forwards `main`, and publishes the personal stable release.
