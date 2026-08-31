# Handy API implementation report

Date: 2026-08-31 KST

Current branch: `codex/handy-api-v0.9.6`

Baseline tag/commit: `v0.9.6` / `af48dd68a64d58aad128fdbb920492a03da53c79`

## Verdict

The local implementation and release scaffolding are substantially complete,
but this checkout does **not** yet satisfy the brief's final completion
standard. A later live run built and runtime-smoked an unsigned Windows NSIS
installer, but its Actions artifact predates the durable unsigned receipt and
signer pre/post byte-invariance gates. It is therefore blocked signing input,
not an approvable candidate. Live Gemini, physical microphone, cursor-paste,
Credential Manager, installer-isolation, and updater acceptance remain
**NOT EXECUTED** on physical Windows.

The product and repository identity is now `Handy API` / `MakinaX/Handy-Api`.
The Director reports that GitHub authentication and a dedicated updater
keypair already exist on the trusted Windows machine. The updater public key is
now bound to the fork and the strict release contract passes. The private key
and password were not read or printed. The environment-level secrets and both
protected approval environments are configured. The failed run never reached a
pending deployment. Run `33308322090` later reached the still-unapproved
`handy-api-signing` gate, but it was cancelled without approval, runner
assignment, signer steps, secret access, signing, or production execution.
Queued old-source run `33340123965` was cancelled first without any job or
artifact. The authenticated read-back is preserved in
`Docs/HANDY-API-SIGNING-ROOTFIX-RECEIPT.json`. A replacement run using the
receipt rootfix must stop again at `handy-api-signing` after unsigned evidence
read-back. The exact procedure is in `Docs/HANDY-API-ONE-TIME-SETUP.md`.

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
or signer byte invariance. The current-tree checks below were rerun for those
surfaces; exact push-owned CI and the replacement native Windows workflow still
must run against the final commit.

### Receipt rootfix local verification

The following 2026-08-31 results apply to the current rootfix working tree, not
to any pushed commit or Windows workflow run:

| Check                                       | Result       | Current rootfix evidence / limitation                                                                                                                                                                               |
| ------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Release contract, scaffold and strict modes | PASS         | exact fork identity and updater key contract                                                                                                                                                                        |
| Public-leak audit                           | PASS         | intended tree, ignored filenames, and reachable history contain no updater private material, credential value, private backup path, or generated installer/signature evidence; inherited fixtures/assets classified |
| Receipt contract and negative suite         | PASS         | tampered receipt/hash/identity, one-byte EXE change, pre/post mismatch, foreign/extra files, schema/type/encoding bounds, and artifact identity cases rejected                                                      |
| Workflow YAML parse                         | PASS         | all workflow YAML files parsed                                                                                                                                                                                      |
| Embedded PowerShell parser                  | PASS         | 11 workflow PowerShell blocks parsed                                                                                                                                                                                |
| Embedded Bash parser                        | PASS         | 7 workflow Bash blocks parsed                                                                                                                                                                                       |
| Translation parity                          | PASS         | all 23 non-English locales match the source keys                                                                                                                                                                    |
| Portable updater resolver                   | PASS         | exact fork release resolution and rejection cases                                                                                                                                                                   |
| ESLint                                      | PASS         | current frontend tree                                                                                                                                                                                               |
| TypeScript and Vite production build        | PASS         | strict type-check and production bundle                                                                                                                                                                             |
| Playwright                                  | PASS         | 2/2 in official `mcr.microsoft.com/playwright:v1.58.0-noble` container                                                                                                                                              |
| Direct host Playwright                      | ENV-BLOCKED  | host lacks `libatk`; the official pinned container result is the executed browser evidence                                                                                                                          |
| Rust formatting                             | PASS         | `cargo +1.88 fmt -- --check`                                                                                                                                                                                        |
| Full Rust tests and Clippy                  | NOT EXECUTED | deferred to the exact push-owned CI run for the final rootfix commit                                                                                                                                                |
| Full Nix package build                      | NOT EXECUTED | deferred to the exact push-owned CI run for the final rootfix commit                                                                                                                                                |
| Native Windows receipt workflow             | NOT EXECUTED | requires the replacement upstream-sync run after old-source cancellation                                                                                                                                            |

These local passes do not make signing approval ready. The Director must still
download the replacement run's unsigned EXE and unsigned receipt artifacts and
independently match GitHub artifact identity/digest and inner EXE size/SHA
before any later approval-ready decision.

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
- The current working-tree rootfix adds separate unsigned and signing receipts,
  artifact ID/archive-digest binding, exact inventories, receipt schema and
  negative-case tests, signer pre/post hash-and-size invariance, and
  publication-time receipt-chain verification. No replacement run has yet
  demonstrated those gates.
- Windows acceptance remains **NOT EXECUTED**. A fresh full run is required;
  the prior runs are retained only as fail-closed diagnostic evidence.

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

No credential values were read, logged, or added to the repository.

## Required closure before calling the fork complete

1. Local receipt-rootfix validation and public-leak audit passed without
   touching either approval.
2. Old-source scheduled run `33340123965` and unapproved run `33308322090` were
   cancelled in the safe order with authenticated `completed/cancelled`
   read-back. The retained zero-approval, signer, production, tag, and release
   evidence is recorded in the rootfix receipt.
3. Commit and push the validated workflow fix, read back that exact SHA on
   `main`, and bind the push-triggered `handy-api-ci.yml` run to it.
4. Dispatch exactly one fresh upstream-sync run. Require candidate gates,
   unsigned Windows runtime smoke, the one-EXE unsigned artifact, the separate
   one-JSON unsigned receipt artifact, and GitHub artifact read-back to pass.
   The Director must download both artifacts and independently match artifact
   identity/digest plus inner installer size/SHA to the receipt. Only then may a
   later decision call the evidence `SIGNING APPROVAL READY`; for the currently
   authorized phase, stop at the unapproved `handy-api-signing` gate.
5. After separate authorization, approve signing, wait for the isolated signer
   to prove pre/post EXE hash and size invariance, verify the signature, upload
   the exact two-file signed artifact and one-JSON signing receipt, and confirm
   `publish-release` pauses on
   `handy-api-production`. Download that run's exact signed Windows x64
   artifact and signing receipt, install the EXE alongside official Handy, and
   execute the unchecked
   [Windows acceptance checklist](HANDY-API-WINDOWS-ACCEPTANCE.md).
6. Preserve the Actions URL, candidate SHA, all artifact IDs/archive digests,
   inner file sizes/hashes, receipt hashes, and redacted manual evidence in this
   report.
7. Only after every blocking item passes, separately approve
   `handy-api-production`; the same run then verifies its draft bytes,
   fast-forwards `main`, and publishes the personal stable release.
