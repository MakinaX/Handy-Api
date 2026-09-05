# Handy API implementation report

Date: 2026-09-04 KST

Current branch: `codex/stt-physical-hallucination-guard`

Baseline tag/commit: `v0.9.6` / `af48dd68a64d58aad128fdbb920492a03da53c79`

## Verdict

Release and production are **BLOCKED**. Physical Windows acceptance failed on
Local Whisper Large V3 through the real F1 microphone path: long no-speech
captures and long silence followed by short Korean speech produced fabricated
cursor output, while some real short utterances were omitted. The failed
candidate is commit `85ce706aaf998591ac9e9fc7a7e158b252121fa4` from run
`33371021364`. That run has already produced a signed artifact and signing
receipt, but its protected `handy-api-production` job is still waiting and must
not be approved. The signed candidate is disqualified from tag, release, and
`latest.json` promotion.

Authenticated artifact read-back identifies signed artifact `9934800266`
(`sha256:443b83aa5d5e8132e9811d58f1eef44937c950afa86276c496d8e4f24f5b6408`)
and signing-receipt artifact `9934800918`
(`sha256:d592cf3382e4e2bf9b0b385316962b22e4271f0ff909823a125a12903b083f8b`).
These identify the failed candidate only; they are not approval evidence.

The failed binary logged aggregate VAD counts only at debug level; it did not
emit the complete per-capture metrics now required. Consequently the physical
failure's RMS, peak, VAD run/density/tail details, and exact pre/post verdicts
are **NOT CAPTURED**. The Director-provided observable evidence is limited to
the F1 conditions, pasted hallucination examples, and short-speech omissions;
numeric values must not be inferred after the fact.

The product and repository identity is now `Handy API` / `MakinaX/Handy-Api`.
The Director reports that GitHub authentication and a dedicated updater
keypair already exist on the trusted Windows machine. The updater public key is
now bound to the fork and the strict release contract passes. The private key
and password were not read by this checkout or printed. The environment-level
secrets and both protected approval environments are configured. Earlier
old-source runs were cancelled safely, as recorded in
`Docs/HANDY-API-SIGNING-ROOTFIX-RECEIPT.json`; the earlier failed signing run is
recorded separately in `Docs/HANDY-API-MINISIGN-ROOTFIX-RECEIPT.json`. A new
unsigned diagnostic candidate must pass the physical hallucination corpus
before any new signing run or approval is considered. The exact procedure is in
`Docs/HANDY-API-ONE-TIME-SETUP.md`.

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
- Smart/Verbatim modes, Auto or validated BCP-47 language, and existing
  dictionary words mapped to Gemini custom vocabulary.
- Request-size, timeout, malformed-response, quota/API, and sanitized-error
  handling.
- API keys stored in Windows Credential Manager under the fork-owned
  `computer.handy.api` / `gemini-api-key` identity.
- A typed replacement key can be tested without overwriting an existing
  working key; Save remains an explicit action.
- Backend selection is separate from local model download/inference ownership.

### Speech-presence and hallucination guard

- Capture evidence records raw sample count/duration, output sample count,
  peak, RMS, exact-zero/non-finite state, VAD analyzed/voiced/error frames,
  confirmed onsets, longest/latest confirmed raw-positive runs, last
  voice/confirmed positions, active onset/hangover settings, and aggregate
  Silero probabilities plus its threshold.
- Stage A/B rejects strong no-speech before Local inference, Gemini request,
  WAV/history persistence, or paste.
- Live provider callbacks are held behind a bounded one-second pre-roll latch
  until the same confirmed Silero onset. Missing/erroring VAD never opens that
  streaming latch.
- A single confirmed onset is no longer permanent proof for the whole capture.
  The existing two-frame onset remains affirmative when the whole short capture
  fits in one configured hangover window. A long capture instead accepts a
  recent sustained episode of at least max(onset \* 2, 4) frames ending within
  three hangover windows, capped at 45 frames, independent of whole-capture
  density. VAD errors are treated conservatively as potentially trailing for
  recency and cannot count as voiced density. Older speech may still use the
  existing sustained-density rescue; a bare two-frame onset in a long capture
  becomes Borderline even when it is stop-adjacent.
- Stage C recomputes the same durable-capture condition and rejects Local
  Borderline output because Local currently supplies no positive post-STT
  metadata. The physical failure phrases were not added to the lexical pattern
  set. VAD threshold `0.3` and the two-frame detector onset remain unchanged
  pending physical calibration.
- `transcribe-cpp` 0.2's safe transcript exposes family-specific per-token
  probability hints but no calibrated Whisper no-speech probability. Those
  hints are not promoted to `PostSttEvidence` until physical paired samples can
  show that an aggregate separates real short speech from hallucination.
- Release logs emit one privacy-safe `speech_guard_capture` line and one
  `speech_guard_final` line per normally stopped operation. Transcript logging
  is limited to empty/single-token/multi-token class plus character and word
  counts.
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

- `handy-api-ci.yml` owns deterministic frontend, Playwright, Rust format,
  test, Clippy, and executable Nix evaluation/package gates.
- The statically parsed `upstream-sync.yml` is configured to auto-resolve only
  five allowlisted release-metadata conflicts and reject unexpected or
  unresolved conflicts and test failures. It then builds the exact unsigned
  Windows x64 NSIS with updater artifacts explicitly disabled and performs the
  installed runtime/DLL smoke without any signing-secret context. It uploads
  one artifact containing exactly the canonical EXE and a separate artifact
  containing exactly one unsigned receipt JSON. The receipt binds repository,
  run, candidate, version, unsigned artifact name/ID/archive digest, and the
  inner EXE filename/byte size/SHA-256.
- A separate `handy-api-signing` required-reviewer job downloads only that
  exact artifact and its receipt and never checks out or executes candidate
  source. Before the signing command, it validates both exact inventories,
  every receipt identity, artifact ID/archive digest against GitHub metadata,
  and the recalculated inner EXE size/hash. Tauri CLI 2.11.4 is installed before
  secrets are exposed; only the signer step receives the environment-level
  private key/password. The signer records EXE SHA-256 and byte size immediately
  before and after signing, requires both to remain identical, and permits the
  command to add only the exact non-empty `.sig`. A later secret-free step
  rechecks invariance and verifies the signature with the exact candidate's
  committed public key and a digest-pinned Minisign binary.
- After cryptographic verification, the signer uploads one artifact containing
  exactly the unchanged EXE and `.sig`, then creates a separate one-JSON signing
  receipt. That receipt binds the signed artifact name/ID/archive digest, the
  unsigned receipt artifact name/ID/archive digest and JSON SHA-256, equal
  pre/post installer hashes, inner installer size, signature filename/hash,
  `byte_invariance: true`, and
  `cryptographic_signature_verified: true`.
- The exact signed artifact remains private while the publish job waits on the
  independent protected `handy-api-production` environment. After Windows
  acceptance and separate production approval, the job uploads a draft, reads
  back the exact three bytes-identical assets, advances `main`, and only then
  publishes.
- Fork workflow actions are pinned to full commit SHAs, and workflow YAML
  declares Bun 1.2.23 and Rust 1.88.0. The release-contract script checks
  locked install/test commands, updater identity, Windows bundle and release
  inventory invariants, the protected environment, and action SHA pinning.
- Inherited official release/build workflows are repository-identity gated and
  cannot publish this fork.

The exact inventory contract is:

| Evidence or release object                         | Exact inventory                                         |
| -------------------------------------------------- | ------------------------------------------------------- |
| `handy-api-windows-x64-unsigned-<version>`         | one canonical installer EXE                             |
| `handy-api-windows-x64-unsigned-receipt-<version>` | one `handy-api-windows-x64-unsigned-receipt.json`       |
| `handy-api-windows-x64-signed-<version>`           | the same installer EXE plus its exact `.sig`            |
| `handy-api-windows-x64-signing-receipt-<version>`  | one `handy-api-windows-x64-signing-receipt.json`        |
| final public release                               | installer EXE, installer `.sig`, and `latest.json` only |

The receipt artifacts remain private Actions evidence and are never release
assets. GitHub artifact ID, archive `size_in_bytes`, and archive digest identify
the uploaded container. They are distinct from the installer size and SHA-256
measured from the EXE inside it.

## Historical implementation-baseline verification record

The table below records the validated STT implementation baseline from before
the identity migration. Every `BASELINE PASS` is historical evidence, not a
result for the current shared tree. It is not a substitute for the full
post-identity rerun required before the identity phase is closed; the final
executor must replace or supplement these rows with the actually executed
results for the committed Handy API tree.

| Check                                           | Result               | Evidence / limitation                                                 |
| ----------------------------------------------- | -------------------- | --------------------------------------------------------------------- |
| Frozen Bun dependency install                   | BASELINE PASS        | `bun install --frozen-lockfile`                                       |
| Translation parity                              | BASELINE PASS        | 452 keys; all 23 non-English locales complete                         |
| ESLint                                          | BASELINE PASS        | full `eslint src`                                                     |
| Prettier                                        | BASELINE PASS        | full repository check                                                 |
| TypeScript + production Vite build              | BASELINE PASS        | 2,117 modules; only inherited large-chunk warnings                    |
| Portable updater unit assertions                | BASELINE PASS        | all assertions passed                                                 |
| Playwright                                      | BASELINE PASS        | 2/2 tests in Playwright 1.58.0 Noble container                        |
| Workflow YAML parse                             | BASELINE PASS        | both fork workflows parsed                                            |
| Release contract, scaffold mode                 | BASELINE PASS        | `0.9.6-api.1`, placeholders allowed                                   |
| Release contract, release mode                  | EXPECTED FAIL-CLOSED | only the updater-public-key placeholder remains                       |
| Nix flake evaluation/package build              | NOT EXECUTED         | no Nix runtime on this host; exact gate is now mandatory in fork CI   |
| Rustfmt                                         | BASELINE PASS        | Rust 1.88 toolchain, all targets                                      |
| Pure speech-guard regression suite              | BASELINE PASS        | 13/13 deterministic tests                                             |
| Static P0/P1 Rust integration audit             | BASELINE PASS        | no remaining static blocker after final caller/state review           |
| Locked Rust tests, Linux target                 | BASELINE PASS        | `cargo test --locked`; 261 passed, 0 failed; Windows cfg not compiled |
| Clippy defect groups, Linux target              | BASELINE PASS        | all targets; correctness/suspicious/perf denied; style debt allowed   |
| Windows x64 compile/package                     | NOT EXECUTED         | requires native `windows-latest` workflow run                         |
| Actual Local model load/transcription           | NOT EXECUTED         | no model/runtime acceptance corpus in this host session               |
| Actual Silero + real WAV/noise/utterance corpus | NOT VALIDATED        | current deterministic guard tests synthesize evidence/signals         |
| Repeated Whisper hallucination runs             | NOT VALIDATED        | local model/runtime corpus unavailable in this host session           |
| Live Gemini acceptance corpus                   | NOT EXECUTED         | Gemini API key is unavailable                                         |
| Windows F1/ESC/paste/history/manual matrix      | NOT EXECUTED         | no Windows runtime/runner in the local environment                    |
| Windows migration/Credential Manager            | NOT EXECUTED         | Windows app-data and credential APIs unavailable locally              |
| Windows installer/runtime/update retention      | NOT EXECUTED         | no verified/uploaded candidate or physical Windows acceptance exists  |

## Current Handy API tree verification

The following checks were rerun against the provider-neutral Handy API working
tree on 2026-08-30. They supersede the historical baseline rows for the checks
that can be executed on this Linux host. Windows and live-provider acceptance
remain explicitly outside this phase.

| Check                                      | Result | Current-tree evidence / limitation                                       |
| ------------------------------------------ | ------ | ------------------------------------------------------------------------ |
| Frozen Bun dependency install              | PASS   | Bun 1.2.23; 355 installs / 427 packages; lockfile unchanged              |
| Translation parity                         | PASS   | 452 keys; all 23 non-English locales complete                            |
| ESLint                                     | PASS   | full `src` tree                                                          |
| TypeScript no-emit                         | PASS   | strict project type-check                                                |
| Prettier                                   | PASS   | full repository check                                                    |
| TypeScript + production Vite build         | PASS   | 2,117 modules; inherited large-chunk warning only                        |
| Portable updater assertions                | PASS   | positive case plus foreign host/repo/tag/name/query/fragment rejection   |
| Playwright                                 | PASS   | 2/2 tests in Playwright 1.58.0 Noble container                           |
| Workflow YAML parse                        | PASS   | all 11 workflow files                                                    |
| Release contract, scaffold mode            | PASS   | exact `MakinaX/Handy-Api`; version `0.9.6-api.1`                         |
| Release contract, release mode             | PASS   | dedicated updater public key satisfies the strict Minisign contract      |
| Wrong/case-drifted repository contract     | PASS   | non-exact repository identity rejected                                   |
| Locked Cargo metadata                      | PASS   | package/lock identity and version consistent                             |
| Rustfmt                                    | PASS   | Rust 1.88.0, all targets                                                 |
| Clippy defect-bearing groups               | PASS   | all targets; correctness/suspicious/perf denied                          |
| Locked Rust tests, Linux target            | PASS   | 262 passed, 0 failed                                                     |
| Vulkan/ONNX Runtime compatibility boundary | PASS   | Vulkan 1.4.309 headers; dynamic ORT 1.24.2 with glibc 2.34 ceiling       |
| Nix metadata and lazy package evaluation   | PASS   | x86_64/aarch64 `mainProgram` is exactly `handy-api`                      |
| Actual Nix package build                   | PASS   | Nix 2.31.2; `handy-api` exists and legacy `handy` is absent              |
| Final public-leak audit                    | PASS   | 384 files plus ignored/history scan; no secret or private artifact found |

The Nix build completed from a read-only checkout in an isolated Nix 2.31.2
container. It used checksum-verified static crates.io downloads and Bun's
copyfile backend, then produced the exact `handy-api` executable. Tauri emitted
a Linux DEB bundle-type marker warning; no Linux or Windows updater acceptance
is inferred from this package-build result.

These 2026-08-30 rows predate the signing-receipt rootfix. They do not establish
the current workflow's receipt schemas, negative cases, artifact inventories,
or signer byte invariance. The receipt-rootfix checks and their exact live runs
are recorded below.

### Receipt rootfix verification record

The local checks were run before receipt-rootfix commit
`47a0407a1eb5851b5f6819f5d1400a4cb937e573`; the last three rows bind the
subsequent exact push CI and native Windows run:

| Check                                       | Result      | Current rootfix evidence / limitation                                                                                                                                                                               |
| ------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Release contract, scaffold and strict modes | PASS        | exact fork identity and updater key contract                                                                                                                                                                        |
| Public-leak audit                           | PASS        | intended tree, ignored filenames, and reachable history contain no updater private material, credential value, private backup path, or generated installer/signature evidence; inherited fixtures/assets classified |
| Receipt contract and negative suite         | PASS        | tampered receipt/hash/identity, one-byte EXE change, pre/post mismatch, foreign/extra files, schema/type/encoding bounds, and artifact identity cases rejected                                                      |
| Workflow YAML parse                         | PASS        | all workflow YAML files parsed                                                                                                                                                                                      |
| Embedded PowerShell parser                  | PASS        | 11 workflow PowerShell blocks parsed                                                                                                                                                                                |
| Embedded Bash parser                        | PASS        | 7 workflow Bash blocks parsed                                                                                                                                                                                       |
| Translation parity                          | PASS        | all 23 non-English locales match the source keys                                                                                                                                                                    |
| Portable updater resolver                   | PASS        | exact fork release resolution and rejection cases                                                                                                                                                                   |
| ESLint                                      | PASS        | current frontend tree                                                                                                                                                                                               |
| TypeScript and Vite production build        | PASS        | strict type-check and production bundle                                                                                                                                                                             |
| Playwright                                  | PASS        | 2/2 in official `mcr.microsoft.com/playwright:v1.58.0-noble` container                                                                                                                                              |
| Direct host Playwright                      | ENV-BLOCKED | host lacks `libatk`; the official pinned container result is the executed browser evidence                                                                                                                          |
| Rust formatting                             | PASS        | `cargo +1.88 fmt -- --check`                                                                                                                                                                                        |
| Full Rust tests and Clippy                  | PASS        | push-owned CI run `33351528982` on exact receipt-rootfix commit                                                                                                                                                     |
| Full Nix package build                      | PASS        | push-owned CI run `33351528982` on exact receipt-rootfix commit                                                                                                                                                     |
| Native Windows receipt workflow             | FAIL-CLOSED | run `33354201384` passed unsigned receipt/read-back and signer invariance, then stopped before Minisign invocation; signed evidence, production, tags, and releases remained zero                                   |

These results cannot be reused to approve or publish. The exact-x64 verifier fix
requires a new commit and full run. The Director must download that new run's
unsigned EXE and receipt, independently match its fresh artifact identity,
digest, inner EXE size, and SHA, then make a new run-specific signing decision.

## Live closure runs and current signing blocker

- Initial push CI run
  [`33302015844`](https://github.com/MakinaX/Handy-Api/actions/runs/33302015844)
  passed frontend/contracts, Rust, and the actual Nix package build on exact
  commit `788809ce3cd99c0c29c77fbf832aeba1dfc4d7c2`.
- Upstream-sync run
  [`33303353021`](https://github.com/MakinaX/Handy-Api/actions/runs/33303353021)
  passed candidate preparation, all candidate CI gates, the strict release
  contract, and the unsigned NSIS build. It then failed closed before install
  smoke and upload because Tauri emitted the raw product-derived filename
  `Handy API_0.9.6-api.1_x64-setup.exe`, while the release contract requires
  `Handy.API_0.9.6-api.1_x64-setup.exe`.
- That failed run produced zero Actions artifacts, did not expose signing
  secrets, skipped both signing and production jobs, and created no tag or
  release. The workflow now requires exactly the single raw Tauri filename and
  canonicalizes only that file to the stable release filename before runtime
  smoke and upload.
- Upstream-sync run
  [`33308322090`](https://github.com/MakinaX/Handy-Api/actions/runs/33308322090)
  on workflow source and candidate
  `62c4947a36d3774527042da2776ff66d047002cd` passed candidate gates, release
  contract, unsigned Windows build, installed runtime smoke, and upload of
  `handy-api-windows-x64-unsigned-0.9.6-api.1`. The Director read back the one
  inner file `Handy.API_0.9.6-api.1_x64-setup.exe` as 21,561,685 bytes with
  SHA-256
  `ACC08A58FAF3B22996D8F48BF62513E34B5A2EB142B7BF564DD18A04CFC03E61`
  and Authenticode `NotSigned`, as expected.
- The old Actions artifact has ID `9731923966`, archive `size_in_bytes`
  21,549,105, and archive SHA-256
  `6ce8c9bcc763396e462ebf352a7fbf4879c77aa4e533156bcaf9036a24945735`.
  The different archive and inner-EXE sizes are expected layers; neither value
  substitutes for the other. The blocker is that this run produced no separate
  machine-readable unsigned receipt binding those layers.
- Run `33308322090` was cancelled `completed/cancelled` without approval. Its
  approval history is empty, its signer job had no assigned runner and zero
  steps, and production had zero runners, steps, or deployments. No signing
  environment secret became available to the job, no signing command or
  production mutation ran, and authenticated tag/release inventory remained
  zero.
- Scheduled upstream-sync run
  [`33340123965`](https://github.com/MakinaX/Handy-Api/actions/runs/33340123965)
  was cancelled first with `completed/cancelled` read-back and the same old
  workflow source SHA. It retained zero jobs, approvals, and artifacts, so it
  could not start the superseded workflow when `33308322090` was cancelled.
  Both cancellation results and the retained old artifact metadata are in
  `Docs/HANDY-API-SIGNING-ROOTFIX-RECEIPT.json`.
- Receipt-rootfix commit `47a0407a1eb5851b5f6819f5d1400a4cb937e573`
  added separate unsigned and signing receipts, artifact ID/archive-digest
  binding, exact inventories, receipt schema and negative-case tests, signer
  pre/post hash-and-size invariance, and publication-time receipt-chain
  verification. Push CI run
  [`33351528982`](https://github.com/MakinaX/Handy-Api/actions/runs/33351528982)
  passed frontend/contracts, Rust, and the actual Nix package build on that
  exact commit.
- Replacement upstream-sync run
  [`33354201384`](https://github.com/MakinaX/Handy-Api/actions/runs/33354201384)
  used the same exact workflow-source and candidate SHA. Candidate gates,
  strict release contract, unsigned Windows build, installed runtime smoke,
  one-EXE upload, and separate unsigned-receipt upload all passed. The
  Director independently matched installer `Handy.API_0.9.6-api.1_x64-setup.exe`
  at 21,568,046 bytes and SHA-256
  `df36d254164bcea61325338f678968e93ae6cdfacbdeddccc0de1b90f1b91383`
  to the durable receipt, whose SHA-256 is
  `057926401bf55e8d41ee2cca04da187419a497088456ed90eb871c0748daeb62`.
- The Director then approved only `handy-api-signing`. Signer-side receipt and
  input verification passed; the secret-bearing Tauri sign step succeeded and
  its explicit pre/post installer hash-and-size gate passed. The following
  secret-free verification step failed closed before invoking Minisign because
  the pinned Minisign 0.12 Windows archive contains the two expected
  architecture executables, while the workflow incorrectly required one
  recursive `minisign.exe` result. The exact message was
  `Expected exactly one minisign.exe, found 2`.
- Run `33354201384` therefore uploaded no signed artifact or signing receipt,
  skipped production, and retained zero tags and releases. The failure and
  artifact evidence are recorded in
  `Docs/HANDY-API-MINISIGN-ROOTFIX-RECEIPT.json`. The verifier fix now checks
  the pinned digest and exact two-file architecture inventory, selects only
  `minisign-win64/x86_64/minisign.exe` on the required x64 runner before the
  secret-bearing signing step, requires its native version output to be exactly
  `minisign 0.12`, then re-hashes and freshly expands the archive before
  post-signature invocation. A fresh commit and full run are required; the
  failed run must not be rerun.
- Windows acceptance is **BLOCKED / FAILED**. Run `33371021364` reached a signed
  candidate, but the physical F1 regression disqualifies it; production, tags,
  releases, and `latest.json` remain prohibited.

### Exact-x64 verifier rootfix local verification

These checks apply to the exact-x64 verifier fix in this tree. They prove its
local contract and parser behavior, not Windows cryptographic verification:

| Check                                     | Result       | Evidence                                                                                                                              |
| ----------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Release contract, scaffold and strict     | PASS         | Bun 1.2.23; exact repository and release mode                                                                                         |
| Receipt schemas and negative suite        | PASS         | all unsigned/signing receipt assertions                                                                                               |
| Workflow and embedded shell parse         | PASS         | 11 YAML files; all 19 explicit PowerShell and 20 explicit Bash blocks parsed after GitHub-expression substitution                     |
| Pinned archive preflight/revalidation     | PASS         | digest-matched 0.12 archive; exact aarch64/x86_64 inventory; literal x86_64 selection                                                 |
| Minisign dynamic negative cases           | PASS         | extra verifier, non-x64 runner, and archive tamper rejected                                                                           |
| Release-contract mutation negative cases  | PASS         | 15 cases rejected: recursive/ARM selection, missing arch/inventory/hash/exit gates, SHA drift, reassignment, and post-sign redownload |
| Frontend lint and production build        | PASS         | Bun 1.2.23; inherited Vite large-chunk warning only                                                                                   |
| Rust format, Clippy, and locked tests     | PASS         | Rust 1.88.0; CI-equivalent Clippy flags; 262 tests passed, 0 failed                                                                   |
| Pinned ONNX Runtime contract              | PASS         | CI-equivalent dynamic ORT library identity, SONAME, and glibc compatibility gates                                                     |
| Targeted Prettier, JSON, and diff checks  | PASS         | all changed workflow/checker/evidence files                                                                                           |
| Public-leak audit                         | PASS         | actionable matches zero in current/history/name scopes; one synthetic redaction fixture classified                                    |
| Windows x64 verifier version preflight    | NOT EXECUTED | exact pre-secret `minisign 0.12` gate is encoded; requires the fresh native Windows run                                               |
| Native Windows cryptographic verification | NOT EXECUTED | requires the fresh committed upstream-sync run                                                                                        |

## External capability state

- GitHub authentication and repository authority: **DIRECTOR-PROVIDED
  READ-BACK PASS** on the trusted Windows machine (`MakinaX`, exact public
  `MakinaX/Handy-Api`, `ADMIN`). No credential value was accessed from this
  checkout.
- GitHub Actions default token permissions: **DIRECTOR-PROVIDED READ-BACK
  PASS** (`write`, with pull-request review approval disabled).
- Repository target: `MakinaX/Handy-Api`; the initial push completed with
  implementation/trust-root commit
  `788809ce3cd99c0c29c77fbf832aeba1dfc4d7c2` on `main`.
- Official `cjpais/Handy`: retained as fetch-only `upstream` with push disabled.
- Dedicated Handy API updater keypair: **DIRECTOR-REPORTED CREATED** outside the
  repository. The Director reports that SHA-256 receipts for the original and
  two encrypted private-key backups are identical; no hash value is recorded.
  The private key and password were not read or printed.
- Fork GitHub owner: bound to `MakinaX`; the updater public key is configured
  and release-mode contract verification passes. The Director-provided
  read-backs confirm both `handy-api-signing` and `handy-api-production` exist
  with `MakinaX` as their required reviewer and
  `prevent_self_review=false`. The two updater signing secrets exist exactly
  under `handy-api-signing`; repository and production scopes contain neither,
  and no Gemini API secret exists in any of the three audited scopes. Secret
  values were not read back.
- Windows Authenticode identity: not configured. Tauri updater signatures are
  separate; the first personal installer may display Unknown Publisher.
- Local Windows build capability: unavailable on this x86_64 Linux
  host. The release workflow uses native `windows-latest` instead.

No credential values were exposed in logs or added to the repository. The one
approved Tauri signing step consumed the environment-scoped secrets; no secret
value was read back into this checkout.

## Required closure before calling the fork complete

1. Keep run `33371021364`'s `handy-api-production` job unapproved and treat its
   signed artifact as failed physical evidence only. Do not tag, publish, or
   update `latest.json` from it.
2. Run the full local/host-independent CI suite on the guard change and build a
   new native Windows x64 **unsigned diagnostic-only** candidate. Preserve its
   exact commit, run, artifact ID/digest, installer size/hash, and receipt.
3. On the physical Windows microphone and normal F1 path, execute class A
   (5/15/30-second digital silence, quiet room, fan/HVAC, keyboard/mouse) and
   class B (each delay followed by `네`, `응`, `아니`, `오케이`, or
   `테스트입니다`). Preserve matching `speech_guard_capture` and
   `speech_guard_final` lines without private transcript content.
4. Calibrate run length, density, tail recency, and VAD probability from that
   physical evidence. Do not raise the `0.3` threshold or add reported phrases
   to a blacklist as a substitute for calibration. If a stop-adjacent false
   onset still survives, revise the combined evidence rule and repeat with a
   new commit/candidate.
5. Require every no-speech case to produce paste 0, successful-history 0, WAV
   0, and Local hallucination 0. Require delayed short speech to remain usable
   with minimal false rejection, and verify normal Korean, F1 stop, and ESC
   cancellation regressions.
6. Only after the physical matrix passes may a wholly new signing workflow be
   dispatched and separately approved. Its signed bytes and receipts must be
   accepted on Windows before production is considered.
7. Only after every blocking item passes, separately approve
   `handy-api-production`; then verify draft bytes before advancing `main`, tag,
   release, or `latest.json`.
