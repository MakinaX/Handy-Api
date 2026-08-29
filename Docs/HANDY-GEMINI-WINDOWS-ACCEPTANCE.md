# Handy Gemini Windows acceptance

Overall status: **NOT EXECUTED**

Target: physical Windows 10/11 x64 system

Rule: leave every item unchecked until its evidence is attached. A build or
unit-test pass alone is not acceptance.

## Evidence rules

- [ ] Create one evidence directory named
      `handy-gemini-<version>-windows-acceptance`.
- [ ] Record the tester, UTC start/end time, Windows build, CPU/GPU, microphone,
      audio driver, official Handy version, Handy Gemini version, release tag,
      and tested candidate commit SHA.
- [ ] Record the successful CI URL and the upstream-sync URL that produced the
      exact acceptance artifact. Export the job summaries/logs and, after
      approval, the release's exact three-asset inventory.
- [ ] Record SHA-256 for the downloaded installer, its `.sig`, `latest.json`,
      and the installed `handy-gemini.exe`:

  ```powershell
  Get-FileHash -Algorithm SHA256 <path> | Format-List Path, Hash
  ```

- [ ] Save a case receipt for every test: case ID, backend/model, Gemini
      mode/language, input/fixture SHA-256, repetitions, start/end time,
      request-count delta, target-document hash before/after, history-row count
      before/after, recording-WAV count before/after, observed text, and result.
- [ ] Attach screenshots or a screen recording for installation identity,
      settings, F1/ESC behavior, history, Credential Manager target, and update.
- [ ] Redact API keys, authorization headers, request/response bodies, private
      dictation, usernames, and private paths. Evidence may state secrets only
      as `SET` or `UNSET`; never reveal a credential value.

## Capability gates

- [ ] A public `<owner>/Handy-Gemini` repository exists, `main` is its default
      branch, and `origin` points to it while `upstream` points read-only to
      `cjpais/Handy`.
- [ ] `REPLACE_WITH_GITHUB_OWNER` and
      `REPLACE_WITH_TAURI_UPDATER_PUBLIC_KEY` are absent from runtime config.
- [ ] Repository secrets `TAURI_SIGNING_PRIVATE_KEY` and
      `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` are present by name; values are not
      displayed.
- [ ] The protected GitHub environment `handy-gemini-production` exists with a
      human required reviewer. Publication cannot begin without that approval.
- [ ] `handy-gemini-ci.yml` completed successfully for the exact candidate. The
      upstream-sync candidate gates, release contract, signed Windows build,
      installed-runtime smoke, and artifact upload succeeded; its production
      job is waiting for `handy-gemini-production` approval. Capture URLs and
      SHA with:

  ```powershell
  gh run list --repo <owner>/Handy-Gemini --limit 20
  gh run view <run-id> --repo <owner>/Handy-Gemini `
    --json url,headSha,conclusion,workflowName
  ```

- [ ] While that exact run is waiting, download its artifact without approving
      the environment. Record the run ID, artifact name, candidate SHA, version,
      installer hash, and signature-file hash:

  ```powershell
  $RunId = "<run-id>"
  $Version = "<fork-version>"
  $Artifact = "handy-gemini-windows-x64-$Version"
  gh run download $RunId --repo <owner>/Handy-Gemini `
    --name $Artifact --dir ".\acceptance-artifact"
  Get-ChildItem ".\acceptance-artifact" -File
  Get-FileHash -Algorithm SHA256 ".\acceptance-artifact\*"
  ```

- [ ] The downloaded pre-approval artifact contains exactly one
      `*-setup.exe` and its matching `*-setup.exe.sig`. `latest.json` is
      expected only after the protected publish job is approved.
- [ ] The test machine has a snapshot/backup, working physical microphone,
      network access, a disposable Gemini API key with quota, a local
      Whisper-family model including Large V3, Notepad, and a local HTTPS
      capture proxy capable of exporting only sanitized request metadata.
- [ ] The proxy evidence retains only timestamp, method, host, path, status,
      and byte counts. Delete the unredacted local capture after deriving the
      receipt.

If any gate fails, stop with status **NOT EXECUTED** for all dependent cases.
Do not approve `handy-gemini-production` merely to obtain the artifact.

## Baseline state and counters

- [ ] In a dedicated Windows test profile, configure official Handy with F1,
      the intended microphone/output device, paste mode, language, dictionary,
      VAD/audio preferences, and a compatible local model.
- [ ] Before the first Handy Gemini launch, confirm the fork store does not
      exist. Use a fresh profile or restore the snapshot for a rerun; do not
      delete an unbacked user profile.
- [ ] Record SHA-256 of official Handy's `settings_store.json` before migration.
- [ ] Discover and record the actual fork data/log directories using the app's
      Open Data Folder/Open Log Folder controls. Set `$ForkData` to that exact
      path for later receipts.
- [ ] Before every no-output/cancel case, record these three counters and save a
      Notepad marker file:

  ```powershell
  $HistoryDb = Join-Path $ForkData "history.db"
  $Recordings = Join-Path $ForkData "recordings"
  sqlite3 -readonly $HistoryDb "select count(*) from transcription_history;"
  @(Get-ChildItem $Recordings -File -Filter "*.wav" -ErrorAction SilentlyContinue).Count
  Get-FileHash -Algorithm SHA256 <notepad-target-file>
  ```

The post-case values must be collected after the app returns to Idle. Save the
Notepad file before hashing it again.

## Side-by-side identity

- [ ] Install official Handy and the release-built Handy Gemini NSIS package;
      Windows Installed Apps shows two separate entries.
- [ ] Launch both once and capture process paths. The fork process is
      `handy-gemini.exe`; no fork install directory contains `handy.exe`.
- [ ] Confirm official Handy and Handy Gemini have different install, app-data,
      log, settings, history/recordings, uninstall, tray, and updater ownership.
- [ ] Changing a fork preference does not change the official settings-store
      hash, and changing an official preference after import does not change the
      fork setting.
- [ ] For all F1 tests, close official Handy or temporarily give it a different
      shortcut so only the fork receives F1. Restore it after testing.

## First-run migration

- [ ] On the fork's first launch, F1, microphone/output device, paste behavior,
      language, dictionary, VAD/audio settings, and compatible local-model
      preference match the official app.
- [ ] Fork backend starts as Local; Gemini mode/language start as Smart/Auto;
      fork autostart and post-processing are disabled; no official secret is
      imported.
- [ ] Literal Escape is the fork cancel binding even if the official store had
      another cancel binding.
- [ ] Official `settings_store.json` SHA-256 is unchanged by import.
- [ ] Change official Handy settings, restart Handy Gemini, and confirm the fork
      does not re-import them. Then change fork settings and confirm official
      Handy remains unchanged.

## Deterministic audio set

- [ ] Create/hash 16 kHz mono WAV fixtures for 2 seconds of digital silence,
      quiet room tone, fan/HVAC, and keyboard/mouse with no speech. Record the
      capture source, duration, and SHA-256 for each.
- [ ] Route each fixed WAV through one named loopback/virtual microphone so
      repetitions use identical bytes and gain. Separately run one live
      physical-microphone pass for room, fan, and keyboard conditions.
- [ ] Record live physical-microphone utterances `네`, `응`, `아니`, and
      `오케이` at normal and quiet voice levels, five repetitions each.
- [ ] Record one normal Korean sentence, one long prompt with hesitation and
      self-correction, and actual background broadcast speech. Background
      speech is expected to transcribe and is not a v1 failure.

## Silence and hallucination matrix

For every case, start/stop with F1 and keep Notepad focused. A no-speech pass
means zero pasted bytes, zero successful-history rows, zero new WAV files, and
for Gemini, zero transcription requests.

| Case   | Backend           | Input                        | Repetitions | Expected                            | Status       |
| ------ | ----------------- | ---------------------------- | ----------: | ----------------------------------- | ------------ |
| HG-S01 | Local Large V3    | digital silence              |          20 | no inference output/side effects    | NOT EXECUTED |
| HG-S02 | Local Large V3    | quiet room                   |          20 | no hallucinated output/side effects | NOT EXECUTED |
| HG-S03 | Local Large V3    | fan/HVAC                     |          20 | no hallucinated output/side effects | NOT EXECUTED |
| HG-S04 | Local Large V3    | keyboard/mouse               |          20 | no hallucinated output/side effects | NOT EXECUTED |
| HG-S05 | Gemini Smart/Auto | all four fixed fixtures      |      5 each | zero requests and side effects      | NOT EXECUTED |
| HG-S06 | Local and Gemini  | live room/fan/keyboard       |      1 each | no hallucinated output/side effects | NOT EXECUTED |
| HG-S07 | Local and Gemini  | four short Korean utterances |      5 each | usable non-empty transcript         | NOT EXECUTED |
| HG-S08 | Local and Gemini  | real background speech       |      1 each | speech may transcribe               | NOT EXECUTED |

- [ ] Each Local repeated run uses the normal F1 microphone path, not only
      `--transcribe-file`, because the headless file path does not prove the
      capture speech gate.
- [ ] Gemini request-count evidence comes from the sanitized proxy receipt;
      debug logs alone are supporting, not sole, proof of no request.

## Local regression corpus

Run with post-processing off and then once with the user's normal paste/history
configuration. Test Large V3 and at least one other already-supported installed
local model.

| Case   | Dictation                                         | Expected                                 | Status       |
| ------ | ------------------------------------------------- | ---------------------------------------- | ------------ |
| HG-L01 | `네` / `응` / `아니` / `오케이`                   | short speech preserved                   | NOT EXECUTED |
| HG-L02 | normal Korean sentence                            | accurate paste and one history/WAV entry | NOT EXECUTED |
| HG-L03 | `GPT-5.6 Sol X-High 다음에 UltraCode로 검증해줘.` | dictionary spelling preserved            | NOT EXECUTED |
| HG-L04 | `Codex에서 ProjectX 작업을 먼저 확인해줘.`        | code switching preserved                 | NOT EXECUTED |
| HG-L05 | `Claude Code와 Gemini 결과를 비교해줘.`           | product spelling preserved               | NOT EXECUTED |
| HG-L06 | long prompt with hesitation/self-correction       | complete usable transcript               | NOT EXECUTED |

- [ ] F1 starts recording, F1 normally stops it, the selected exact model stays
      loaded, current-cursor paste succeeds, and the matching history/WAV entry
      is created once.
- [ ] Dictionary, language, microphone, VAD, paste mode, history, and
      post-processing behavior show no regression.

## Gemini corpus and failures

- [ ] Save a valid disposable key, Test Connection succeeds, and Gemini is
      selectable without downloading or changing the local model.
- [ ] Run HG-L01 through HG-L06 in Smart/Auto and Verbatim/Auto; run HG-L03
      through HG-L05 once with `ko-KR`. Record request count, latency, exact
      transcript, paste, history, and WAV outcome.
- [ ] Add `GPT-5.6 Sol`, `X-High`, `UltraCode`, `Codex`, `Claude Code`, and
      `ProjectX` to the existing Handy Dictionary; confirm intended spellings
      without a second Gemini-only vocabulary UI.
- [ ] Malformed key, offline network, throttled timeout, and quota/rate-limit
      cases show a sanitized error, do not crash, do not paste, do not create a
      successful-history row, and leave no WAV artifact.
- [ ] Smart and Verbatim behavior is observably distinct where the spoken
      self-correction makes that applicable; Auto handles Korean/English code
      switching.

## F1 and Escape timing

Use a fresh Notepad marker and pre/post counters for every repetition.

| Case   | Action                                                           | Request expectation                                         | Other expected outcome             | Status       |
| ------ | ---------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------- | ------------ |
| HG-C01 | F1, speak, Escape while recording                                | Gemini delta 0                                              | no paste/history/WAV               | NOT EXECUTED |
| HG-C02 | F1, speak, F1 stop, Escape immediately; repeat 20                | 0 if Escape wins admission; otherwise classify as in-flight | no paste/history/WAV               | NOT EXECUTED |
| HG-C03 | throttle Gemini response to >=10 s; Escape after proxy sees POST | one admitted request may abort                              | no late paste/history/WAV          | NOT EXECUTED |
| HG-C04 | Local Large V3, Escape during processing                         | not applicable                                              | no paste/history/WAV               | NOT EXECUTED |
| HG-C05 | alternate rapid F1/Escape for 20 cycles                          | Gemini pre-admission cycles delta 0                         | returns Idle; no orphan output/WAV | NOT EXECUTED |

- [ ] HG-C01 is the strict no-send proof: sanitized proxy request delta is zero.
- [ ] For every HG-C02 run, record whether upload admission or Escape won; an
      already admitted request is not mislabeled as a pre-admission send.
- [ ] HG-C03 waits beyond the delayed provider response and confirms no late
      cursor paste or successful history entry.
- [ ] Escape remains registered during recording and pending transcription,
      and the next F1 operation works normally after every cancel.

## Windows Credential Manager

- [ ] Before Save, no fork-owned Generic Credential is present. After Save,
      Credential Manager contains service `computer.handy.gemini` and account
      `gemini-api-key`; capture identity only, never the value.
- [ ] Restart the app and Windows session; Test Connection succeeds without
      re-entering the key.
- [ ] Copy the key to the clipboard only for this local scan; scan fork JSON and
      log files while printing Boolean results only. Every result is `False`.
      Clear the variable and clipboard immediately; never attach a matching
      file:

  ```powershell
  $Secret = Get-Clipboard
  Get-ChildItem $ForkData -Recurse -File -Include *.json,*.log | ForEach-Object {
    [pscustomobject]@{
      Path = $_.FullName
      ContainsSecret = [IO.File]::ReadAllText($_.FullName).Contains($Secret)
    }
  }
  Clear-Variable Secret
  Set-Clipboard -Value ""
  ```

- [ ] Testing a bad replacement key does not overwrite the working saved key;
      restarting and testing the stored key still succeeds.

## Update and retention

- [ ] Before installing the waiting candidate artifact, use version N to set F1,
      backend, Gemini mode/language, key, dictionary, microphone, paste, VAD,
      and local model; create one Local and one Gemini successful history entry.
      Record all identities/counters.
- [ ] Install the exact waiting-run N+1 artifact over version N without
      approving production. After restart, executable/product identity and
      version are N+1 while F1, all listed settings, Credential Manager key,
      dictionary, existing history/WAV, and both Local/Gemini operation remain
      intact.
- [ ] Official Handy still launches independently and its settings/updater were
      not changed by the candidate install.
- [ ] In a throwaway repository/branch or using a preserved failed run, force a
      candidate gate failure and prove the public latest release tag, three
      asset names, and their SHA-256 values did not change.

## Production approval and published updater

- [ ] Every capability, identity, migration, audio, Local, Gemini, F1/Escape,
      Credential Manager, and pre-approval update-retention item above is PASS
      for the artifact downloaded from the waiting run. Attach the signed
      decision receipt to that run URL.
- [ ] A designated human reviewer, not automation, approves the waiting
      `handy-gemini-production` environment only after reviewing that receipt.
      Record reviewer identity and UTC approval time; do not record credentials.
- [ ] After approval, the same upstream-sync run completes successfully and
      publishes a stable release containing exactly one `*-setup.exe`, its
      matching `*-setup.exe.sig`, and `latest.json`, with no extra assets.
- [ ] Download the three public assets, compare installer/signature SHA-256 with
      the pre-approval artifact, hash `latest.json`, and confirm its version and
      URL name the exact fork release rather than `cjpais/Handy`.
- [ ] Restore the version-N test snapshot, accept the in-app N to N+1 update,
      and repeat the retention checks. The updater downloads from the fork and
      preserves F1, key, dictionary, preferences, history/WAV, and both
      backends.
- [ ] If a post-publication updater check fails, record the failure immediately,
      stop further promotion/use, and do not label the release accepted.

## Acceptance decision

- [ ] Every row is executed with a receipt and all required outcomes pass.
- [ ] CI/workflow URLs, waiting-run artifact identity, production approval
      receipt, tested candidate SHA, release version, four release/file SHA-256
      values, redacted logs, screenshots/video, corpus transcripts, and pre/post
      counters are present in the evidence directory.
- [ ] Any failure is linked to a tracked defect and the release remains draft
      or unpromoted. Do not call the fork complete while any required row is
      `NOT EXECUTED` or failed.
