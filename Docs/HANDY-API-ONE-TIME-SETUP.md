# Handy API one-time setup

The release path is fail-closed at signing and publication. Its exact unsigned
candidate build uses no signing secrets and runs before either human approval.
It can proceed only after the public repository/updater endpoint and committed
updater public key satisfy the release contract; signing then also requires the
dedicated private-key environment configuration and the two approvals described
below. The inherited official Handy release and main-build workflows are
repository-identity gated and cannot publish from this fork.

This document describes the authorized closure sequence. The identity-only
phase, public-key binding, protected-environment setup, environment-scoped
secret registration, and initial push are complete. Treat the corresponding
commands below as recovery/read-back instructions: do not regenerate the
keypair or repeat secret mutations without a new, specific authorization. The
current closure attempt must stop before approving `handy-api-signing`.

## 1. Verify authentication and the safe remote layout

The public updater repository already exists as `MakinaX/Handy-Api`. GitHub
authentication as `MakinaX` is **DIRECTOR-REPORTED COMPLETE** on the trusted
Windows machine. Verify identity and the safe remote layout without displaying
or exporting credentials:

```bash
fork_repo="MakinaX/Handy-Api"
gh auth status --hostname github.com
gh api user --jq .login
gh repo view "$fork_repo" --json nameWithOwner,visibility

git remote set-url origin "https://github.com/${fork_repo}.git"
git remote set-url upstream "https://github.com/cjpais/Handy.git"
git remote set-url --push upstream DISABLED
git remote -v

```

The identity read-back must be `MakinaX`; the repository read-back must report
`PUBLIC` and the exact name `MakinaX/Handy-Api`. The remote read-back must show
that only `origin` can push and that official `cjpais/Handy` remains the
fetch-only `upstream`.

The initial push completed with implementation/trust-root commit
`788809ce3cd99c0c29c77fbf832aeba1dfc4d7c2`. For a later locally validated
closure commit, the exact guarded push command remains:

```bash
git push --set-upstream origin HEAD:main
```

Enable read/write permissions for the repository's automatic token:

```bash
gh api --method PUT \
  "repos/${fork_repo}/actions/permissions/workflow" \
  -f default_workflow_permissions=write \
  -F can_approve_pull_request_reviews=false
```

Create two independent required-reviewer environments: `handy-api-signing`
authorizes use of the updater trust root only after the unsigned candidate and
all automated gates have been reviewed; `handy-api-production` separately
authorizes publication only after the exact signed artifact passes Windows
acceptance. `prevent_self_review` is intentionally false because this is a
one-person fork:

```bash
director_id="$(gh api user --jq .id)"
for release_environment in handy-api-signing handy-api-production; do
  jq -n --argjson director_id "$director_id" '{
    wait_timer: 0,
    prevent_self_review: false,
    reviewers: [{type: "User", id: $director_id}],
    deployment_branch_policy: null
  }' | gh api --method PUT \
    "repos/${fork_repo}/environments/${release_environment}" \
    --input -

  gh api \
    "repos/${fork_repo}/environments/${release_environment}" \
    --jq '{name, protection_rules}'
done
```

Do not continue unless both read-backs show the exact environment name and a
`required_reviewers` protection rule. The unsigned candidate build receives no
signing secrets. The isolated signer waits on `handy-api-signing`, never checks
out or executes candidate source, and exposes its environment secrets only to
the one signer step. After signing, `handy-api-production` remains a distinct
approval boundary before any tag, draft, `main` update, or public release.

Do not add branch protection that blocks GitHub Actions from fast-forwarding
`main`. The workflow first pushes and tests an immutable candidate branch;
it advances `main` only after every gate and remote draft-asset read-back pass.

## 2. Verify both updater clients are bound to the fork

The current tree binds the repository in these two runtime files:

- `src-tauri/tauri.conf.json`
- `src/components/update-checker/portableInstaller.ts`

Both URLs must resolve to:

```text
https://github.com/MakinaX/Handy-Api/releases/latest
```

The Tauri endpoint appends `/download/latest.json`; the portable fallback uses
the release URL directly and accepts a manifest deep-link only when its HTTPS
host, fork path, tag version, architecture, and exact installer filename all
match the Handy API release contract. Confirm that the official repository and
placeholders are absent from both runtime surfaces:

```bash
rg -n "REPLACE_WITH_GITHUB_OWNER|cjpais/Handy/releases" \
  src-tauri/tauri.conf.json \
  src/components/update-checker/portableInstaller.ts
```

The expected output is empty.

## 3. Use the existing dedicated updater keypair

The Director reports that the dedicated Handy API updater keypair has already
been created on the trusted Windows machine, outside this repository. Its
values and local storage path are intentionally absent from this public
document. Do not generate a replacement pair and do not read, print, or copy
the private key except through the secure secret-registration path in the next
authorized phase.

The public file is represented here as
`<secure-path>/handy-api-updater.key.pub`. In the next authorized phase, copy
its single-line base64-encoded Tauri Minisign public key into
`src-tauri/tauri.conf.json` in place of
`REPLACE_WITH_TAURI_UPDATER_PUBLIC_KEY`. Never commit the private key or its
password.

Before release setup, confirm that two independent offline backups of the
encrypted private-key file exist and that the password is stored separately.
Compare SHA-256 receipts locally without copying their paths or contents into
the repository:

```bash
sha256sum \
  <secure-path>/handy-api-updater.key \
  <backup-one>/handy-api-updater.key \
  <backup-two>/handy-api-updater.key
```

On Windows PowerShell, use `Get-FileHash -Algorithm SHA256 <path>` for each
copy. A lost key or password prevents all installed copies from accepting later
updates, so the backups are part of the release system, not optional cleanup.

Load the private key and password through interactive/standard-input paths so
they do not appear in shell history:

```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY \
  --repo "$fork_repo" \
  --env handy-api-signing \
  < <secure-path>/handy-api-updater.key

gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD \
  --repo "$fork_repo" \
  --env handy-api-signing
```

Paste the password only at the second command's hidden prompt. Verify secret
names, never values:

```bash
gh secret list \
  --repo "$fork_repo" \
  --env handy-api-signing |
  rg '^TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)?\b'

if gh secret list --repo "$fork_repo" |
  rg -q '^TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)?\b'; then
  echo "Signing secrets must not exist at repository scope" >&2
  exit 1
fi

if gh secret list --repo "$fork_repo" --env handy-api-production |
  rg -q '^TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)?\b'; then
  echo "Signing secrets must not exist in handy-api-production" >&2
  exit 1
fi
```

Do not register either value as a repository secret or under
`handy-api-production`. The candidate build produces and runtime-smokes the
exact unsigned NSIS installer with no signing-secret context. Only after the
first human approval does the no-checkout signer job use pinned Tauri CLI
2.11.4 to generate `.sig`; a separate secret-free step decodes the committed
public key and cryptographically verifies that exact installer.

## 4. Run the fail-closed gates, then publish only when authorized

Before binding the public key, the identity-only tree must pass scaffold mode:

```bash
bun scripts/check-handy-api-release.ts \
  --repository "$fork_repo"
```

After adding only the public key, release mode must pass. Commit the audited
public configuration and evidence without adding either signing secret:

```bash
bun scripts/check-handy-api-release.ts \
  --release \
  --repository "$fork_repo"

git add -- \
  src-tauri/tauri.conf.json \
  Docs/HANDY-API-ONE-TIME-SETUP.md \
  Docs/HANDY-API-IMPLEMENTATION-REPORT.md
git commit -m "chore: bind Handy API updater identity"
closure_sha="$(git rev-parse HEAD)"
git push origin HEAD:main
```

The initial `main` push starts `handy-api-ci.yml` automatically. Do not dispatch
a duplicate manual run: both runs share a cancellation-enabled concurrency
group, so the duplicate can cancel the push-owned evidence. Wait for the exact
push run to appear, bind it to the committed SHA, and watch that run ID:

```bash
ci_run_id="$(gh run list \
  --repo "$fork_repo" \
  --workflow handy-api-ci.yml \
  --branch main \
  --event push \
  --commit "$closure_sha" \
  --limit 1 \
  --json databaseId \
  --jq '.[0].databaseId')"

test -n "$ci_run_id"
test "$(gh run view "$ci_run_id" \
  --repo "$fork_repo" \
  --json headSha \
  --jq .headSha)" = "$closure_sha"
gh run watch "$ci_run_id" --repo "$fork_repo" --exit-status
```

If no matching push run appears, stop and diagnose the trigger instead of
starting an unbound replacement. After the exact push run passes, check that no
scheduled or manually dispatched upstream-sync run is already active, then run
the release owner once:

```bash
gh run list \
  --repo "$fork_repo" \
  --workflow upstream-sync.yml \
  --branch main \
  --limit 10 \
  --json databaseId,event,headSha,status,url

gh workflow run upstream-sync.yml --repo "$fork_repo" --ref main
```

Open that run in GitHub Actions. First wait for the unsigned Windows build and
all frontend, Rust, Nix, and release-contract gates to pass. Review the exact
candidate SHA and unsigned artifact receipt, then approve
`handy-api-signing`. After the isolated signer succeeds, `publish-release`
waits on the independent `handy-api-production` environment. Download
`handy-api-windows-x64-signed-<version>` and complete
`Docs/HANDY-API-WINDOWS-ACCEPTANCE.md`. Only after every blocking check is
recorded as PASS should the Director approve production and wait for the same
run to finish:

```bash
release_run_id="$(gh run list \
  --repo "$fork_repo" \
  --workflow upstream-sync.yml \
  --branch main \
  --event workflow_dispatch \
  --commit "$closure_sha" \
  --limit 1 \
  --json databaseId \
  --jq '.[0].databaseId')"

test -n "$release_run_id"
test "$(gh run view "$release_run_id" \
  --repo "$fork_repo" \
  --json event,headSha \
  --jq '[.event, .headSha] | @tsv')" = \
  "workflow_dispatch$(printf '\t')${closure_sha}"
gh run view "$release_run_id" --repo "$fork_repo" --web
gh run watch "$release_run_id" --repo "$fork_repo" --exit-status
```

The sync workflow enforces this order before publication:

1. exact stable upstream tag merge into a candidate branch;
2. frontend, format, lint, Playwright, Clippy, Rust, and Nix package gates;
3. unsigned exact Windows x64 NSIS build and installed-package runtime smoke,
   with no signing secrets in the candidate job; the job first requires the
   exact Tauri raw filename `Handy API_<version>_x64-setup.exe`, then renames
   that unchanged byte stream to the canonical public filename
   `Handy.API_<version>_x64-setup.exe` before smoke and upload;
4. Director approval of the independent `handy-api-signing` environment;
5. no-checkout Tauri CLI 2.11.4 signing of only
   `Handy.API_<version>_x64-setup.exe`, followed by secret-free Minisign
   verification against the exact candidate's committed public key;
6. protected `handy-api-production` wait while that exact signed artifact
   undergoes the Windows acceptance matrix;
7. separate Director production approval after evidence is recorded;
8. non-public draft creation, exact three-asset upload, and remote byte
   read-back;
9. `main` fast-forward; and
10. draft publication as the final release mutation.

Every complete release has exactly
`Handy.API_<version>_x64-setup.exe`, its exact matching `.sig`, and
`latest.json`. A differently named installer, stale draft, orphan release tag,
or any other inventory is a hard stop; automation never overwrites or retargets
it.

## 5. First-install checks

- Official Handy and Handy API have separate identifiers, stores, updater
  endpoints, logs, credentials, and executable names.
- On first launch, Handy API reads compatible settings from official Handy
  once without changing the official store. Imported autostart and cloud
  post-processing are disabled.
- If both applications are running, do not leave them on the same global
  shortcut. Close/disable official Handy or assign Handy API a distinct
  shortcut before enabling its autostart.
- Enter the Gemini API key in Handy API settings. It is stored in Windows
  Credential Manager under `computer.handy.api` / `gemini-api-key`; it is not
  a repository or Actions secret.

The Tauri updater signature authenticates updates but is not Windows
Authenticode. The official Handy Azure signing command is deliberately absent,
so Windows may show an unknown-publisher/SmartScreen warning. Adding
Authenticode later requires a separately owned certificate and must not reuse
official Handy credentials.
