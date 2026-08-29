# Handy Gemini one-time setup

The release workflow is fail-closed. It will not build or publish until the
repository is public, the updater endpoint names that exact repository, and a
dedicated updater keypair is configured. The inherited official Handy release
and main-build workflows are repository-identity gated and cannot publish from
this fork.

## 1. Create the public fork repository and remotes

GitHub Release assets are the public updater transport, so a private repository
is intentionally rejected. Starting from this reviewed checkout, replace
`<owner>` once and run:

```bash
fork_repo="<owner>/Handy-Gemini"
gh repo create "$fork_repo" \
  --public \
  --description "Personal Windows Handy fork with Gemini transcription"

# This checkout began with cjpais/Handy as origin. Preserve it as the read-only
# upstream owner and make the new repository the only push remote named origin.
git remote rename origin upstream
git remote add origin "git@github.com:${fork_repo}.git"
git remote set-url --push upstream DISABLED
git remote -v

git push --set-upstream origin HEAD:main
gh repo view "$fork_repo" --json nameWithOwner,visibility
```

The final command must report `PUBLIC` and the exact name
`<owner>/Handy-Gemini`. If an `upstream` remote already exists, verify that it
points to `https://github.com/cjpais/Handy.git` instead of renaming over it.

Enable read/write permissions for the repository's automatic token:

```bash
gh api --method PUT \
  "repos/${fork_repo}/actions/permissions/workflow" \
  -f default_workflow_permissions=write \
  -F can_approve_pull_request_reviews=false
```

Create the mandatory publication-approval environment with the Director as
its required reviewer. `prevent_self_review` is intentionally false because
this is a one-person fork and the Director must be able to approve the exact
artifact they just tested:

```bash
director_id="$(gh api user --jq .id)"
jq -n --argjson director_id "$director_id" '{
  wait_timer: 0,
  prevent_self_review: false,
  reviewers: [{type: "User", id: $director_id}],
  deployment_branch_policy: null
}' | gh api --method PUT \
  "repos/${fork_repo}/environments/handy-gemini-production" \
  --input -

gh api \
  "repos/${fork_repo}/environments/handy-gemini-production" \
  --jq '{name, protection_rules}'
```

Do not continue unless the read-back names `handy-gemini-production` and shows
a `required_reviewers` protection rule. The release job targets this exact
environment, so it pauses after the signed Windows artifact is built and
before any tag, draft, `main` update, or public release is created.

Do not add branch protection that blocks GitHub Actions from fast-forwarding
`main`. The workflow first pushes and tests an immutable candidate branch;
it advances `main` only after every gate and remote draft-asset read-back pass.

## 2. Bind both updater clients to the fork

Replace `REPLACE_WITH_GITHUB_OWNER` with the exact GitHub owner from
`$fork_repo` in only these runtime files:

- `src-tauri/tauri.conf.json`
- `src/components/update-checker/portableInstaller.ts`

Both URLs must resolve to:

```text
https://github.com/<owner>/Handy-Gemini/releases/latest
```

The Tauri endpoint appends `/download/latest.json`; the portable installer uses
the release URL directly. Confirm that the official repository and placeholders
are absent from both surfaces:

```bash
rg -n "REPLACE_WITH_GITHUB_OWNER|cjpais/Handy/releases" \
  src-tauri/tauri.conf.json \
  src/components/update-checker/portableInstaller.ts
```

The expected output is empty.

## 3. Generate and back up a dedicated updater keypair

Generate the key on a trusted machine, outside this repository. Use a unique,
high-entropy password when the official Tauri CLI prompts for one:

```bash
bun run tauri signer generate --write-keys <secure-path>/handy-gemini-updater.key
```

This creates the encrypted private key and
`<secure-path>/handy-gemini-updater.key.pub`. The `.pub` file is the
base64-encoded Tauri Minisign public key; copy its single-line contents into
`src-tauri/tauri.conf.json` in place of
`REPLACE_WITH_TAURI_UPDATER_PUBLIC_KEY`. Never commit the private key or its
password.

Before continuing, make two independent offline backups of the encrypted
private-key file and store the password in a separate password manager. Record
and compare a SHA-256 receipt for both private-key backups:

```bash
sha256sum \
  <secure-path>/handy-gemini-updater.key \
  <backup-one>/handy-gemini-updater.key \
  <backup-two>/handy-gemini-updater.key
```

On Windows PowerShell, use `Get-FileHash -Algorithm SHA256 <path>` for each
copy. A lost key or password prevents all installed copies from accepting later
updates, so the backups are part of the release system, not optional cleanup.

Load the private key and password through interactive/standard-input paths so
they do not appear in shell history:

```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY \
  --repo "$fork_repo" \
  < <secure-path>/handy-gemini-updater.key

gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo "$fork_repo"
```

Paste the password only at the second command's hidden prompt. Verify secret
names, never values:

```bash
gh secret list --repo "$fork_repo" | rg '^TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)?\b'
```

The Windows build decodes the committed public key and generated `.sig`, then
cryptographically verifies the exact NSIS installer before it can enter the
release job.

## 4. Commit and run the fail-closed gates

Run the contract against the exact remote identity, then commit the public
configuration only:

```bash
bun scripts/check-handy-gemini-release.ts \
  --release \
  --repository "$fork_repo"

git add \
  src-tauri/tauri.conf.json \
  src/components/update-checker/portableInstaller.ts
git commit -m "chore: bind Handy Gemini updater identity"
git push origin main
```

Run CI first and wait for it to finish:

```bash
gh workflow run handy-gemini-ci.yml --repo "$fork_repo" --ref main
gh run watch --repo "$fork_repo" --exit-status
```

Then run the upstream-sync/release owner once:

```bash
gh workflow run upstream-sync.yml --repo "$fork_repo" --ref main
```

Open that run in GitHub Actions. Wait until the signed Windows build succeeds
and `publish-release` is waiting for approval on
`handy-gemini-production`. Download the exact run artifact and complete
`Docs/HANDY-GEMINI-WINDOWS-ACCEPTANCE.md`. Only after every blocking check is
recorded as PASS, approve the pending environment deployment in the Actions
UI, then wait for the same run to finish:

```bash
release_run_id="$(gh run list \
  --repo "$fork_repo" \
  --workflow upstream-sync.yml \
  --branch main \
  --limit 1 \
  --json databaseId \
  --jq '.[0].databaseId')"

gh run view "$release_run_id" --repo "$fork_repo" --web
gh run watch "$release_run_id" --repo "$fork_repo" --exit-status
```

The sync workflow enforces this order before publication:

1. exact stable upstream tag merge into a candidate branch;
2. frontend, format, lint, Playwright, Clippy, and Rust test gates;
3. signed Windows x64 NSIS build and installed-package runtime smoke;
4. cryptographic updater-signature verification against the committed key;
5. protected-environment wait while the exact artifact undergoes the Windows
   acceptance matrix;
6. Director approval after evidence is recorded;
7. non-public draft creation, exact three-asset upload, and remote byte
   read-back;
8. `main` fast-forward; and
9. draft publication as the final release mutation.

Every complete release has exactly one `*-setup.exe`, its matching
`*-setup.exe.sig`, and `latest.json`. A stale draft, orphan release tag, or any
other inventory is a hard stop and must be inspected manually; automation never
overwrites or retargets it.

## 5. First-install checks

- Official Handy and Handy Gemini have separate identifiers, stores, updater
  endpoints, logs, credentials, and executable names.
- On first launch, Handy Gemini reads compatible settings from official Handy
  once without changing the official store. Imported autostart and cloud
  post-processing are disabled.
- If both applications are running, do not leave them on the same global
  shortcut. Close/disable official Handy or assign Handy Gemini a distinct
  shortcut before enabling its autostart.
- Enter the Gemini API key in Handy Gemini settings. It is stored in Windows
  Credential Manager under `computer.handy.gemini` / `gemini-api-key`; it is not
  a repository or Actions secret.

The Tauri updater signature authenticates updates but is not Windows
Authenticode. The official Handy Azure signing command is deliberately absent,
so Windows may show an unknown-publisher/SmartScreen warning. Adding
Authenticode later requires a separately owned certificate and must not reuse
official Handy credentials.
