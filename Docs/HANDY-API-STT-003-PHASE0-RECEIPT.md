# Handy API STT-003 Phase 0 receipt

Historical note: this identity-normalized copy preserves the hashes, counts,
and outcomes recorded before the Handy API naming decision. The exact original
receipt remains available at commit `17ccbf61bdac265654ae46f5f5b3cb1acbb697a2`.

Recorded: 2026-08-30T00:07:05Z

## Preservation boundary

- Baseline tag: `v0.9.6`
- Baseline commit: `af48dd68a64d58aad128fdbb920492a03da53c79`
- Pre-implementation parent: `ecbcc3070f503ac7825ffe3bb5443a8549f91f9d`
- Preserved implementation commit:
  `d7cbb2e5a55b78c32ecbbe1259eee230ae5f11c8`
- Preserved implementation tree:
  `2a619f79e45306afb4afced800d44d7f756431cb`
- Current identity branch: `codex/handy-api-v0.9.6`
- Commit scope: 83 paths, 7,223 insertions, 522 deletions

The preservation commit was created locally. No branch, tag, artifact, or
release was pushed.

## Remote safety

- `upstream` fetch URL: official `cjpais/Handy`
- `upstream` push URL: `DISABLED`
- fork `origin`: not configured at the time of this receipt

At recording time, no remote could receive this branch until a Director-owned
public fork was created and configured as `origin`.

## Public-leak gate

Status: **PASS**

- Inspected 371 tracked files, 12 non-ignored untracked files, 1,341 reachable
  commits, and 5,466 unique reachable blobs.
- No live API key, PAT, authorization header, updater private key/password,
  private-key material, credential export, private recording/transcript,
  history database, log, raw capture, credential file, or personal path was
  found.
- The only key-shaped strings are inherited synthetic redaction fixtures.
- `ProjectX` appears only as an explicitly allowed vocabulary, migration,
  speech-guard, and acceptance-test fixture; it contains no private source,
  configuration, credential, path, or implementation detail.
- Current media are byte-identical upstream product assets and public test
  fixtures. No new recording or screenshot is present.
- The upstream MIT `LICENSE` is unchanged.

Dedicated secret-scanner binaries were unavailable, so the audit combined
complete file/blob enumeration with high-confidence and generic targeted
content scans. The staged index was independently re-audited before commit.

## Validation receipt

- Primary implementation run: Rust `261/261` PASS.
- Recorded pre-identity tree: ESLint PASS, TypeScript PASS, Vite build PASS, full-repository
  Prettier PASS, translation parity PASS (`452` keys across `23` non-English
  locales), Playwright `2/2` PASS, release scaffold contract PASS, and staged
  diff/public-content audit PASS.
- At recording time, the strict release contract remained fail-closed on the
  GitHub-owner and updater-public-key placeholders.
- An additional disposable Linux Rust rerun completed system dependency setup
  but stopped before compilation because that image lacked `cargo-fmt`. This
  environment-only attempt is not counted as a test failure and does not
  replace the recorded `261/261` result.

## Closure state

- Phase 0: **PASS**
- Phase 0.5: **PASS**
- At recording time, Phase 1 onward was **BLOCKED / NOT EXECUTED** pending the
  external fork, authentication, updater signing secrets, protected production
  environment, and physical Windows acceptance capabilities.

No secret value is recorded in this receipt.
