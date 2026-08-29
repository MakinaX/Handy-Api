import { readFileSync, writeFileSync } from "node:fs";

const ROOT = new URL("../", import.meta.url);
const FORK_NAME = "Handy Gemini";
const PACKAGE_NAME = "handy-gemini";
const LIB_NAME = "handy_gemini_lib";
const IDENTIFIER = "computer.handy.gemini";
const PLACEHOLDER_OWNER = "REPLACE_WITH_GITHUB_OWNER";
const PLACEHOLDER_PUBKEY = "REPLACE_WITH_TAURI_UPDATER_PUBLIC_KEY";

function path(name: string): URL {
  return new URL(name, ROOT);
}

function read(name: string): string {
  return readFileSync(path(name), "utf8");
}

function writeIfChanged(name: string, next: string): void {
  const target = path(name);
  if (readFileSync(target, "utf8") !== next) writeFileSync(target, next);
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function replaceOnce(
  source: string,
  pattern: RegExp,
  replacement: string,
  label: string,
): string {
  const matches = source.match(new RegExp(pattern.source, pattern.flags + "g"));
  if (matches?.length !== 1) {
    throw new Error(
      `${label}: expected one match, found ${matches?.length ?? 0}`,
    );
  }
  return source.replace(pattern, replacement);
}

function resolveIncomingConflictBlocks(source: string, name: string): string {
  const conflict =
    /^<<<<<<<[^\n]*\n[\s\S]*?^=======\r?\n([\s\S]*?)^>>>>>>>[^\n]*(?:\n|$)/gm;
  const resolved = source.replace(conflict, "$1");
  if (/^(<<<<<<<|=======|>>>>>>>)/m.test(resolved)) {
    throw new Error(
      `${name}: unsupported or incomplete merge-conflict markers`,
    );
  }
  return resolved;
}

function resolveKnownUpstreamConflicts(): void {
  // These generated/manifests are the only expected conflicts when both
  // upstream and the fork change a release version. Unexpected conflicted paths
  // are rejected by upstream-sync.yml before this helper runs.
  for (const name of [
    "package.json",
    "bun.lock",
    "src-tauri/Cargo.toml",
    "src-tauri/Cargo.lock",
    "src-tauri/tauri.conf.json",
  ]) {
    const source = read(name);
    if (source.includes("<<<<<<<")) {
      writeIfChanged(name, resolveIncomingConflictBlocks(source, name));
    }
  }
}

function setForkVersion(version: string, preservedUpdaterPath?: string): void {
  if (!/^\d+\.\d+\.\d+-gemini\.\d+$/.test(version)) {
    throw new Error(`invalid Handy Gemini version: ${version}`);
  }

  const packageJson = JSON.parse(read("package.json"));
  packageJson.name = PACKAGE_NAME;
  packageJson.version = version;
  writeIfChanged("package.json", `${JSON.stringify(packageJson, null, 2)}\n`);

  let cargo = read("src-tauri/Cargo.toml");
  cargo = replaceOnce(
    cargo,
    /(\[package\][\s\S]*?^name\s*=\s*)"[^"]+"/m,
    `$1"${PACKAGE_NAME}"`,
    "Cargo package name",
  );
  cargo = replaceOnce(
    cargo,
    /(\[package\][\s\S]*?^version\s*=\s*)"[^"]+"/m,
    `$1"${version}"`,
    "Cargo package version",
  );
  cargo = replaceOnce(
    cargo,
    /(\[package\][\s\S]*?^description\s*=\s*)"[^"]+"/m,
    `$1"${FORK_NAME}"`,
    "Cargo package description",
  );
  cargo = replaceOnce(
    cargo,
    /(\[package\][\s\S]*?^default-run\s*=\s*)"[^"]+"/m,
    `$1"${PACKAGE_NAME}"`,
    "Cargo default binary",
  );
  cargo = replaceOnce(
    cargo,
    /(\[lib\][\s\S]*?^name\s*=\s*)"[^"]+"/m,
    `$1"${LIB_NAME}"`,
    "Cargo library name",
  );
  cargo = cargo.replaceAll("handy.exe", "handy-gemini.exe");
  writeIfChanged("src-tauri/Cargo.toml", cargo);

  const tauriConfig = JSON.parse(read("src-tauri/tauri.conf.json"));
  const preservedUpdater = preservedUpdaterPath
    ? JSON.parse(readFileSync(preservedUpdaterPath, "utf8")).plugins?.updater
    : tauriConfig.plugins?.updater;
  if (!preservedUpdater) throw new Error("missing Handy Gemini updater config");
  tauriConfig.productName = FORK_NAME;
  tauriConfig.version = version;
  tauriConfig.identifier = IDENTIFIER;
  tauriConfig.bundle.windows ??= {};
  delete tauriConfig.bundle.windows.signCommand;
  tauriConfig.plugins ??= {};
  tauriConfig.plugins.updater = preservedUpdater;
  writeIfChanged(
    "src-tauri/tauri.conf.json",
    `${JSON.stringify(tauriConfig, null, 2)}\n`,
  );

  let main = read("src-tauri/src/main.rs");
  main = main.replaceAll("handy_app_lib", LIB_NAME);
  writeIfChanged("src-tauri/src/main.rs", main);

  let index = read("index.html");
  index = replaceOnce(
    index,
    /<title>[^<]*<\/title>/,
    `<title>${FORK_NAME}</title>`,
    "HTML title",
  );
  writeIfChanged("index.html", index);

  for (const name of [
    "src-tauri/src/portable.rs",
    "src-tauri/nsis/installer.nsi",
  ]) {
    writeIfChanged(
      name,
      read(name).replaceAll(
        "Handy Portable Mode",
        "Handy Gemini Portable Mode",
      ),
    );
  }

  const endpoint = preservedUpdater.endpoints?.[0];
  if (typeof endpoint === "string") {
    const releasesUrl = endpoint.replace(/\/download\/latest\.json$/, "");
    let portableInstaller = read(
      "src/components/update-checker/portableInstaller.ts",
    );
    portableInstaller = replaceOnce(
      portableInstaller,
      /(export const PORTABLE_RELEASES_URL\s*=\s*\n\s*)"[^"]+"/,
      `$1"${releasesUrl}"`,
      "portable releases URL",
    );
    writeIfChanged(
      "src/components/update-checker/portableInstaller.ts",
      portableInstaller,
    );
  }
}

const resolveRequested = process.argv.includes("--resolve-upstream-conflicts");
if (resolveRequested) {
  resolveKnownUpstreamConflicts();
}

const nextVersion = option("--set-version");
if (nextVersion) {
  setForkVersion(nextVersion, option("--preserve-updater-from"));
}

if (resolveRequested && !nextVersion) {
  console.log("Known upstream release-metadata conflicts resolved");
  process.exit(0);
}

const releaseMode = process.argv.includes("--release");
const expectedRepository = option("--repository");
const errors: string[] = [];
const expect = (condition: unknown, message: string) => {
  if (!condition) errors.push(message);
};

const packageJson = JSON.parse(read("package.json"));
const tauriConfig = JSON.parse(read("src-tauri/tauri.conf.json"));
const cargo = read("src-tauri/Cargo.toml");
const cargoPackage = cargo.match(
  /\[package\][\s\S]*?^name\s*=\s*"([^"]+)"[\s\S]*?^version\s*=\s*"([^"]+)"/m,
);
const cargoDescription = cargo.match(
  /\[package\][\s\S]*?^description\s*=\s*"([^"]+)"/m,
);
const cargoDefaultRun = cargo.match(
  /\[package\][\s\S]*?^default-run\s*=\s*"([^"]+)"/m,
);
const cargoLib = cargo.match(/\[lib\][\s\S]*?^name\s*=\s*"([^"]+)"/m);

expect(
  packageJson.name === PACKAGE_NAME,
  `package.json name must be ${PACKAGE_NAME}`,
);
expect(
  /^\d+\.\d+\.\d+-gemini\.\d+$/.test(packageJson.version),
  "package.json version must use <upstream>-gemini.<revision>",
);
expect(
  cargoPackage?.[1] === PACKAGE_NAME,
  `Cargo package must be ${PACKAGE_NAME}`,
);
expect(
  cargoPackage?.[2] === packageJson.version,
  "Cargo and package.json versions differ",
);
expect(
  cargoDescription?.[1] === FORK_NAME,
  `Cargo description must be ${FORK_NAME}`,
);
expect(
  cargoDefaultRun?.[1] === PACKAGE_NAME,
  `Cargo default-run must be ${PACKAGE_NAME}`,
);
expect(cargoLib?.[1] === LIB_NAME, `Cargo library must be ${LIB_NAME}`);
expect(
  tauriConfig.productName === FORK_NAME,
  `Tauri productName must be ${FORK_NAME}`,
);
expect(
  tauriConfig.version === packageJson.version,
  "Tauri and package.json versions differ",
);
expect(
  tauriConfig.identifier === IDENTIFIER,
  `Tauri identifier must be ${IDENTIFIER}`,
);
expect(
  tauriConfig.bundle?.windows?.signCommand === undefined,
  "official Windows signCommand must not be present",
);

const updater = tauriConfig.plugins?.updater;
const endpoint = updater?.endpoints?.[0];
const endpointMatch =
  typeof endpoint === "string"
    ? endpoint.match(
        /^https:\/\/github\.com\/([^/]+)\/Handy-Gemini\/releases\/latest\/download\/latest\.json$/,
      )
    : undefined;
expect(
  updater?.endpoints?.length === 1,
  "exactly one updater endpoint is required",
);
expect(
  Boolean(endpointMatch),
  "updater endpoint must target <owner>/Handy-Gemini",
);
const endpointRepository = endpointMatch
  ? `${endpointMatch[1]}/Handy-Gemini`
  : undefined;
if (expectedRepository !== undefined) {
  expect(
    /^[^/]+\/Handy-Gemini$/.test(expectedRepository),
    "--repository must be <owner>/Handy-Gemini",
  );
  expect(
    endpointRepository?.toLowerCase() === expectedRepository.toLowerCase(),
    "updater endpoint must match the exact release repository",
  );
}

const pubkey = updater?.pubkey;
expect(
  typeof pubkey === "string" && pubkey.length > 0,
  "updater pubkey is required",
);
if (releaseMode) {
  expect(
    expectedRepository !== undefined,
    "release mode requires --repository <owner>/Handy-Gemini",
  );
  expect(
    endpointMatch?.[1] !== PLACEHOLDER_OWNER,
    "replace the GitHub owner placeholder before release",
  );
  expect(
    pubkey !== PLACEHOLDER_PUBKEY,
    "replace the updater pubkey before release",
  );
  if (typeof pubkey === "string" && pubkey !== PLACEHOLDER_PUBKEY) {
    let decoded = "";
    try {
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(pubkey)) {
        throw new Error("not strict base64");
      }
      decoded = Buffer.from(pubkey, "base64").toString("utf8");
    } catch {
      // The expectation below reports the failure without exposing key material.
    }
    expect(
      /^untrusted comment: minisign public key: [0-9A-Fa-f]{16}\r?\nRW[A-Za-z0-9+/]{54}(?:\r?\n)?$/.test(
        decoded,
      ),
      "updater pubkey is not a Tauri minisign public key",
    );
  }
}

const main = read("src-tauri/src/main.rs");
expect(
  main.includes(`use ${LIB_NAME}::CliArgs;`),
  "main.rs imports the wrong library crate",
);
expect(
  main.includes(`${LIB_NAME}::run(cli_args)`),
  "main.rs runs the wrong library crate",
);
expect(
  read("index.html").includes(`<title>${FORK_NAME}</title>`),
  "HTML title is not forked",
);

const lib = read("src-tauri/src/lib.rs");
const commandsMod = read("src-tauri/src/commands/mod.rs");
const commandHandler = read("src-tauri/src/commands/gemini.rs");
const gemini = read("src-tauri/src/gemini.rs");
const geminiKey = read("src-tauri/src/gemini_key.rs");
const actions = read("src-tauri/src/actions.rs");
const cli = read("src-tauri/src/cli.rs");
const tray = read("src-tauri/src/tray.rs");
const frontendCommands = read("src/lib/geminiCommands.ts");

for (const moduleDeclaration of [
  "mod gemini;",
  "mod gemini_key;",
  "mod speech_guard;",
]) {
  expect(
    lib.includes(moduleDeclaration),
    `lib.rs is missing ${moduleDeclaration}`,
  );
}
expect(
  commandsMod.includes("pub mod gemini;"),
  "Gemini command module is not exported",
);

for (const command of [
  "change_transcription_backend_setting",
  "change_gemini_transcription_mode_setting",
  "change_gemini_language_setting",
  "gemini_api_key_status",
  "save_gemini_api_key",
  "test_gemini_connection",
  "test_gemini_api_key",
]) {
  expect(
    commandHandler.includes(`fn ${command}`) &&
      lib.includes(`commands::gemini::${command}`) &&
      frontendCommands.includes(`\"${command}\"`),
    `Gemini command is not defined, registered, and invoked: ${command}`,
  );
}

expect(
  gemini.includes(
    'pub const GEMINI_TRANSCRIBE_MODEL: &str = "gemini-3.5-transcribe";',
  ),
  "Gemini adapter model binding drifted",
);
expect(
  gemini.includes("inlineData") && gemini.includes("customVocabulary"),
  "Gemini adapter lost audio or custom-vocabulary request fields",
);
expect(
  geminiKey.includes('const SERVICE: &str = "computer.handy.gemini";') &&
    geminiKey.includes('const ACCOUNT: &str = "gemini-api-key";') &&
    geminiKey.includes("HANDY_GEMINI_API_KEY"),
  "Gemini Credential Manager identity drifted",
);
expect(
  /\[target\.'cfg\(windows\)'\.dependencies\][\s\S]*?keyring\s*=\s*\{[^\n]*features\s*=\s*\["windows-native"\]/.test(
    cargo,
  ),
  "Windows-native Credential Manager dependency is missing",
);
expect(
  /^base64\s*=\s*"0\.22"$/m.test(cargo) &&
    /^reqwest\s*=\s*\{[^\n]*features\s*=\s*\[[^\]]*"json"/m.test(cargo),
  "Gemini adapter dependencies are missing",
);
expect(
  actions.includes("TranscriptionBackend::Gemini") &&
    actions.includes("pre_stt_verdict(&evidence)") &&
    actions.includes("post_stt_verdict(") &&
    actions.includes("complete_unless_cancelled("),
  "Gemini pipeline is not guarded by speech evidence and cancellation",
);
expect(
  cli.includes('#[command(name = "handy-gemini"') &&
    lib.includes('.title("Handy Gemini")') &&
    lib.includes('file_name: Some("handy-gemini".into())') &&
    tray.includes('format!("Handy Gemini v{}'),
  "runtime CLI, window, log, or tray identity remains official Handy",
);

const portableRust = read("src-tauri/src/portable.rs");
const portableNsis = read("src-tauri/nsis/installer.nsi");
expect(
  portableRust.includes("Handy Gemini Portable Mode"),
  "Rust portable marker is not forked",
);
expect(
  portableNsis.includes("Handy Gemini Portable Mode"),
  "NSIS portable marker is not forked",
);
expect(
  !portableRust.includes("Handy Portable Mode"),
  "official Rust portable marker remains",
);
expect(
  !portableNsis.includes("Handy Portable Mode"),
  "official NSIS portable marker remains",
);

const releasesUrl = read(
  "src/components/update-checker/portableInstaller.ts",
).match(/export const PORTABLE_RELEASES_URL\s*=\s*\n\s*"([^"]+)"/)?.[1];
expect(
  !endpointMatch ||
    releasesUrl === endpoint?.replace(/\/download\/latest\.json$/, ""),
  "portable releases URL and updater endpoint target different repositories",
);

const legacyReleaseWorkflow = read(".github/workflows/release.yml");
const inheritedMainBuild = read(".github/workflows/main-build.yml");
const handyGeminiCi = read(".github/workflows/handy-gemini-ci.yml");
const upstreamSync = read(".github/workflows/upstream-sync.yml");
expect(
  (legacyReleaseWorkflow.match(/if: github\.repository == 'cjpais\/Handy'/g)
    ?.length ?? 0) >= 2,
  "legacy manual release workflow is not hard-gated to official Handy",
);
expect(
  inheritedMainBuild.includes("if: github.repository == 'cjpais/Handy'"),
  "inherited main-build workflow is not gated to official Handy",
);
for (const inheritedGate of [
  ".github/workflows/code-quality.yml",
  ".github/workflows/test.yml",
  ".github/workflows/playwright.yml",
  ".github/workflows/nix-check.yml",
]) {
  expect(
    read(inheritedGate).includes("if: github.repository == 'cjpais/Handy'"),
    `inherited workflow is not gated to official Handy: ${inheritedGate}`,
  );
}
for (const releaseInvariant of [
  "src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis",
  "handy-gemini.exe",
  "Handy Gemini releases require a public GitHub repository",
  "Upstream sync must be dispatched from the fork main branch",
  "Cryptographic updater signature verification failed",
  "minisign-0.12-win64.zip",
  "37b600344e20c19314b2e82813db2bfdcc408b77b876f7727889dbd46d539479",
  "($assets | length) == 3",
  "cmp --silent",
  '--repository "$GITHUB_REPOSITORY"',
  "name: handy-gemini-production",
  "--draft=false",
]) {
  expect(
    upstreamSync.includes(releaseInvariant),
    `upstream-sync release invariant is missing: ${releaseInvariant}`,
  );
}
for (const ciInvariant of [
  "bun install --frozen-lockfile",
  "bunx prettier --check .",
  "bun run test:playwright",
  "cargo fmt -- --check",
  "cargo clippy --all-targets --locked --",
  "-D clippy::correctness",
  "-D clippy::suspicious",
  "-D clippy::perf",
  "cargo test --locked",
]) {
  expect(
    handyGeminiCi.includes(ciInvariant),
    `Handy Gemini CI invariant is missing: ${ciInvariant}`,
  );
}

for (const workflow of [
  ".github/workflows/handy-gemini-ci.yml",
  ".github/workflows/upstream-sync.yml",
]) {
  for (const match of read(workflow).matchAll(
    /^\s*uses:\s*([^\.\s][^@\s]+)@([^\s#]+)/gm,
  )) {
    expect(
      /^[0-9a-f]{40}$/.test(match[2]),
      `${workflow} action is not pinned to a full commit SHA: ${match[1]}@${match[2]}`,
    );
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`ERROR: ${error}`);
  process.exit(1);
}

console.log(
  `Handy Gemini release contract OK (${packageJson.version}${releaseMode ? ", release mode" : ", placeholders allowed"})`,
);
