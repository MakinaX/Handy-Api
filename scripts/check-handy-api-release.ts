import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const ROOT = new URL("../", import.meta.url);
const PRODUCT_NAME = "Handy API";
const PACKAGE_NAME = "handy-api";
const LIB_NAME = "handy_api_lib";
const IDENTIFIER = "computer.handy.api";
const PUBLISHER = "MakinaX";
const REPOSITORY = "MakinaX/Handy-Api";
const SOURCE_URL = `https://github.com/${REPOSITORY}`;
const UPDATER_ENDPOINT = `${SOURCE_URL}/releases/latest/download/latest.json`;
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

function upsertCargoPackageField(
  source: string,
  field: string,
  rawValue: string,
): string {
  const packageStart = source.indexOf("[package]");
  if (packageStart === -1) throw new Error("Cargo package section is missing");
  const nextSection = source.indexOf("\n[", packageStart + "[package]".length);
  const packageEnd = nextSection === -1 ? source.length : nextSection;
  let packageSection = source.slice(packageStart, packageEnd);
  const fieldPattern = new RegExp(`^${field}\\s*=.*$`, "m");
  if (fieldPattern.test(packageSection)) {
    packageSection = packageSection.replace(
      fieldPattern,
      `${field} = ${rawValue}`,
    );
  } else {
    packageSection = `${packageSection.trimEnd()}\n${field} = ${rawValue}\n`;
  }
  return `${source.slice(0, packageStart)}${packageSection}${source.slice(packageEnd)}`;
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

function planProductVersion(
  version: string,
  preservedUpdaterPath?: string,
): Map<string, string> {
  if (!/^\d+\.\d+\.\d+-api\.\d+$/.test(version)) {
    throw new Error(`invalid Handy API version: ${version}`);
  }

  // Compute and validate every product-owned rewrite before touching disk. An
  // upstream layout drift must fail closed without leaving a half-rewritten
  // candidate checkout behind.
  const updates = new Map<string, string>();
  const stage = (name: string, next: string): void => {
    updates.set(name, next);
  };

  const packageJson = JSON.parse(read("package.json"));
  packageJson.name = PACKAGE_NAME;
  packageJson.version = version;
  stage("package.json", `${JSON.stringify(packageJson, null, 2)}\n`);

  let bunLock = read("bun.lock");
  bunLock = replaceOnce(
    bunLock,
    /("workspaces"\s*:\s*\{\s*""\s*:\s*\{\s*"name"\s*:\s*)"[^"]+"/,
    `$1"${PACKAGE_NAME}"`,
    "Bun root workspace name",
  );
  stage("bun.lock", bunLock);
  read(".nix/bun-lock-hash");
  stage(
    ".nix/bun-lock-hash",
    `${createHash("sha256").update(bunLock).digest("hex")}\n`,
  );

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
    `$1"${PRODUCT_NAME}"`,
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
  cargo = upsertCargoPackageField(cargo, "authors", '["cjpais", "MakinaX"]');
  cargo = upsertCargoPackageField(cargo, "homepage", `"${SOURCE_URL}"`);
  cargo = upsertCargoPackageField(cargo, "repository", `"${SOURCE_URL}"`);
  cargo = cargo.replaceAll("handy.exe", "handy-api.exe");
  stage("src-tauri/Cargo.toml", cargo);

  let cargoLock = read("src-tauri/Cargo.lock");
  cargoLock = replaceOnce(
    cargoLock,
    /(\[\[package\]\]\r?\nname = ")(?:handy|handy-api)("\r?\nversion = ")[^"]+"/,
    `$1${PACKAGE_NAME}$2${version}"`,
    "Cargo root package identity",
  );
  stage("src-tauri/Cargo.lock", cargoLock);

  let tauriSource = read("src-tauri/tauri.conf.json");
  const tauriConfig = JSON.parse(tauriSource);
  const preservedUpdater = preservedUpdaterPath
    ? JSON.parse(readFileSync(preservedUpdaterPath, "utf8")).plugins?.updater
    : tauriConfig.plugins?.updater;
  if (!preservedUpdater) throw new Error("missing Handy API updater config");
  const endpoint = preservedUpdater.endpoints?.[0];
  if (
    preservedUpdater.endpoints?.length !== 1 ||
    endpoint !== UPDATER_ENDPOINT
  ) {
    throw new Error(`updater endpoint must remain ${UPDATER_ENDPOINT}`);
  }
  if (typeof preservedUpdater.pubkey !== "string") {
    throw new Error("missing Handy API updater public key field");
  }

  const newline = tauriSource.includes("\r\n") ? "\r\n" : "\n";
  const replaceIndentedString = (
    source: string,
    indent: number,
    key: string,
    value: string,
    label: string,
  ): string =>
    replaceOnce(
      source,
      new RegExp(`^(\\s{${indent}}"${key}"\\s*:\\s*)"[^"\\r\\n]*"`, "m"),
      `$1${JSON.stringify(value)}`,
      label,
    );
  const upsertIndentedStringAfter = (
    source: string,
    indent: number,
    key: string,
    value: string,
    anchor: string,
    label: string,
  ): string => {
    const existing = new RegExp(
      `^\\s{${indent}}"${key}"\\s*:\\s*"[^"\\r\\n]*"`,
      "m",
    );
    if (existing.test(source)) {
      return replaceIndentedString(source, indent, key, value, label);
    }
    return replaceOnce(
      source,
      new RegExp(
        `^(\\s{${indent}}"${anchor}"\\s*:\\s*[^\\r\\n]+,\\r?\\n)`,
        "m",
      ),
      `$1${" ".repeat(indent)}"${key}": ${JSON.stringify(value)},${newline}`,
      `${label} insertion anchor`,
    );
  };

  tauriSource = replaceIndentedString(
    tauriSource,
    2,
    "productName",
    PRODUCT_NAME,
    "Tauri product name",
  );
  if (/^  "mainBinaryName"\s*:/m.test(tauriSource)) {
    tauriSource = replaceIndentedString(
      tauriSource,
      2,
      "mainBinaryName",
      PACKAGE_NAME,
      "Tauri main binary name",
    );
  } else {
    tauriSource = replaceOnce(
      tauriSource,
      /(^  "productName"\s*:\s*"[^"\r\n]*",\r?\n)/m,
      `$1  "mainBinaryName": "${PACKAGE_NAME}",${newline}`,
      "Tauri main binary insertion anchor",
    );
  }
  tauriSource = replaceIndentedString(
    tauriSource,
    2,
    "version",
    version,
    "Tauri version",
  );
  tauriSource = replaceIndentedString(
    tauriSource,
    2,
    "identifier",
    IDENTIFIER,
    "Tauri identifier",
  );
  tauriSource = upsertIndentedStringAfter(
    tauriSource,
    4,
    "publisher",
    PUBLISHER,
    "targets",
    "Tauri bundle publisher",
  );
  tauriSource = upsertIndentedStringAfter(
    tauriSource,
    4,
    "homepage",
    SOURCE_URL,
    "publisher",
    "Tauri bundle homepage",
  );

  const linuxResourcePaths = tauriSource.match(
    /^\s{10}"\/usr\/lib\/(?:Handy|handy-api)"\s*:\s*"transcribe-libs"/gm,
  );
  if (linuxResourcePaths?.length !== 2) {
    throw new Error(
      `Tauri Linux resource paths: expected two matches, found ${linuxResourcePaths?.length ?? 0}`,
    );
  }
  tauriSource = tauriSource.replaceAll(
    '"/usr/lib/Handy": "transcribe-libs"',
    '"/usr/lib/handy-api": "transcribe-libs"',
  );

  if (tauriConfig.bundle?.windows?.signCommand !== undefined) {
    tauriSource = replaceOnce(
      tauriSource,
      /^\s{6}"signCommand"\s*:[^\r\n]+,\r?\n/m,
      "",
      "official Windows sign command",
    );
  }

  tauriSource = replaceOnce(
    tauriSource,
    /(^\s{6}"pubkey"\s*:\s*)"[^"\r\n]*"/m,
    `$1${JSON.stringify(preservedUpdater.pubkey)}`,
    "Tauri updater public key",
  );
  tauriSource = replaceOnce(
    tauriSource,
    /(^\s{6}"endpoints"\s*:\s*)\[[\s\S]*?^\s{6}\]/m,
    `$1[${newline}        ${JSON.stringify(endpoint)}${newline}      ]`,
    "Tauri updater endpoints",
  );

  const updatedTauriConfig = JSON.parse(tauriSource);
  for (const target of ["deb", "rpm"] as const) {
    const files = updatedTauriConfig.bundle?.linux?.[target]?.files;
    if (
      files?.["/usr/lib/handy-api"] !== "transcribe-libs" ||
      files?.["/usr/lib/Handy"] !== undefined
    ) {
      throw new Error(`Tauri ${target} resource identity rewrite failed`);
    }
  }
  if (
    updatedTauriConfig.productName !== PRODUCT_NAME ||
    updatedTauriConfig.mainBinaryName !== PACKAGE_NAME ||
    updatedTauriConfig.version !== version ||
    updatedTauriConfig.identifier !== IDENTIFIER ||
    updatedTauriConfig.bundle?.publisher !== PUBLISHER ||
    updatedTauriConfig.bundle?.homepage !== SOURCE_URL ||
    updatedTauriConfig.bundle?.windows?.signCommand !== undefined ||
    updatedTauriConfig.plugins?.updater?.pubkey !== preservedUpdater.pubkey ||
    updatedTauriConfig.plugins?.updater?.endpoints?.length !== 1 ||
    updatedTauriConfig.plugins?.updater?.endpoints?.[0] !== endpoint
  ) {
    throw new Error("Tauri product identity rewrite validation failed");
  }
  stage("src-tauri/tauri.conf.json", tauriSource);

  let main = read("src-tauri/src/main.rs");
  main = main.replaceAll("handy_app_lib", LIB_NAME);
  stage("src-tauri/src/main.rs", main);

  let index = read("index.html");
  index = replaceOnce(
    index,
    /<title>[^<]*<\/title>/,
    `<title>${PRODUCT_NAME}</title>`,
    "HTML title",
  );
  stage("index.html", index);

  for (const name of [
    "src-tauri/src/portable.rs",
    "src-tauri/nsis/installer.nsi",
  ]) {
    stage(
      name,
      read(name).replaceAll("Handy Portable Mode", "Handy API Portable Mode"),
    );
  }

  let portableInstaller = read(
    "src/components/update-checker/portableInstaller.ts",
  );
  portableInstaller = replaceOnce(
    portableInstaller,
    /(const PORTABLE_RELEASES_BASE\s*=\s*)"[^"]+"/,
    `$1"${SOURCE_URL}/releases"`,
    "portable releases base",
  );
  stage(
    "src/components/update-checker/portableInstaller.ts",
    portableInstaller,
  );

  return updates;
}

function setProductVersion(
  version: string,
  preservedUpdaterPath?: string,
): void {
  const updates = planProductVersion(version, preservedUpdaterPath);
  for (const [name, next] of updates) {
    writeIfChanged(name, next);
  }
}

const resolveRequested = process.argv.includes("--resolve-upstream-conflicts");
if (resolveRequested) {
  resolveKnownUpstreamConflicts();
}

const nextVersion = option("--set-version");
if (nextVersion) {
  setProductVersion(nextVersion, option("--preserve-updater-from"));
  // Root lock identities already move with the manifests above. The caller next
  // regenerates dependency metadata, then invokes the full contract against that
  // final lock state.
  console.log(`Handy API product version metadata set to ${nextVersion}`);
  process.exit(0);
}

if (resolveRequested) {
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
const bunLock = read("bun.lock");
const bunLockHash = read(".nix/bun-lock-hash").trim();
const tauriConfig = JSON.parse(read("src-tauri/tauri.conf.json"));
const cargo = read("src-tauri/Cargo.toml");
const cargoLock = read("src-tauri/Cargo.lock");
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
const cargoLockPackages = [
  ...cargoLock.matchAll(
    /\[\[package\]\]\r?\nname = "handy-api"\r?\nversion = "([^"]+)"/g,
  ),
];
const bunWorkspaceName = bunLock.match(
  /"workspaces"\s*:\s*\{\s*""\s*:\s*\{\s*"name"\s*:\s*"([^"]+)"/,
)?.[1];

try {
  // Keep scaffold/strict contract checks coupled to the mutation path used by
  // upstream-sync, without writing anything during ordinary verification.
  planProductVersion(packageJson.version);
} catch (error) {
  errors.push(
    `version setter preflight failed: ${error instanceof Error ? error.message : String(error)}`,
  );
}

expect(
  packageJson.name === PACKAGE_NAME,
  `package.json name must be ${PACKAGE_NAME}`,
);
expect(
  /^\d+\.\d+\.\d+-api\.\d+$/.test(packageJson.version),
  "package.json version must use <upstream>-api.<revision>",
);
expect(
  bunWorkspaceName === PACKAGE_NAME,
  `bun.lock root workspace must be ${PACKAGE_NAME}`,
);
expect(
  bunLockHash === createHash("sha256").update(bunLock).digest("hex"),
  ".nix/bun-lock-hash does not match bun.lock",
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
  cargoDescription?.[1] === PRODUCT_NAME,
  `Cargo description must be ${PRODUCT_NAME}`,
);
expect(
  cargoDefaultRun?.[1] === PACKAGE_NAME,
  `Cargo default-run must be ${PACKAGE_NAME}`,
);
expect(cargoLib?.[1] === LIB_NAME, `Cargo library must be ${LIB_NAME}`);
expect(
  cargo.includes(`authors = ["cjpais", "${PUBLISHER}"]`) &&
    cargo.includes(`homepage = "${SOURCE_URL}"`) &&
    cargo.includes(`repository = "${SOURCE_URL}"`),
  "Cargo publisher, homepage, or repository identity is incorrect",
);
expect(
  cargoLockPackages.length === 1 &&
    cargoLockPackages[0]?.[1] === packageJson.version,
  "Cargo.lock package name/version differs from Cargo.toml",
);
expect(
  tauriConfig.productName === PRODUCT_NAME,
  `Tauri productName must be ${PRODUCT_NAME}`,
);
expect(
  tauriConfig.mainBinaryName === PACKAGE_NAME,
  `Tauri mainBinaryName must be ${PACKAGE_NAME}`,
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
  tauriConfig.bundle?.publisher === PUBLISHER &&
    tauriConfig.bundle?.homepage === SOURCE_URL,
  "Tauri publisher or homepage identity is incorrect",
);
expect(
  tauriConfig.bundle?.linux?.deb?.files?.["/usr/lib/handy-api"] ===
    "transcribe-libs" &&
    tauriConfig.bundle?.linux?.rpm?.files?.["/usr/lib/handy-api"] ===
      "transcribe-libs",
  "Linux bundle resources are not isolated under /usr/lib/handy-api",
);
expect(
  tauriConfig.bundle?.windows?.signCommand === undefined,
  "official Windows signCommand must not be present",
);

const updater = tauriConfig.plugins?.updater;
const endpoint = updater?.endpoints?.[0];
expect(
  updater?.endpoints?.length === 1,
  "exactly one updater endpoint is required",
);
expect(
  endpoint === UPDATER_ENDPOINT,
  `updater endpoint must target ${REPOSITORY}`,
);
if (expectedRepository !== undefined) {
  expect(
    expectedRepository === REPOSITORY,
    `--repository must be ${REPOSITORY}`,
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
    `release mode requires --repository ${REPOSITORY}`,
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
const buildScript = read("src-tauri/build.rs");
expect(
  buildScript.includes("$ORIGIN/../lib/handy-api") &&
    !buildScript.includes("/usr/lib/Handy"),
  "Linux runtime rpath is not isolated under /usr/lib/handy-api",
);
expect(
  main.includes(`use ${LIB_NAME}::CliArgs;`),
  "main.rs imports the wrong library crate",
);
expect(
  main.includes(`${LIB_NAME}::run(cli_args)`),
  "main.rs runs the wrong library crate",
);
expect(
  read("index.html").includes(`<title>${PRODUCT_NAME}</title>`),
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
  geminiKey.includes(`const SERVICE: &str = "${IDENTIFIER}";`) &&
    geminiKey.includes('const ACCOUNT: &str = "gemini-api-key";') &&
    geminiKey.includes("HANDY_GEMINI_API_KEY"),
  "Gemini credential account or Handy API service namespace drifted",
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
  cli.includes('#[command(name = "handy-api"') &&
    lib.includes('.title("Handy API")') &&
    lib.includes('file_name: Some("handy-api".into())') &&
    tray.includes('format!("Handy API v{}'),
  "runtime CLI, window, log, or tray identity remains official Handy",
);

const portableRust = read("src-tauri/src/portable.rs");
const portableNsis = read("src-tauri/nsis/installer.nsi");
expect(
  portableRust.includes("Handy API Portable Mode"),
  "Rust portable marker is not forked",
);
expect(
  portableNsis.includes("Handy API Portable Mode"),
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

const portableInstaller = read(
  "src/components/update-checker/portableInstaller.ts",
);
const portableInstallerTest = read(
  "src/components/update-checker/portableInstaller.test.ts",
);
expect(
  portableInstaller.includes(`"${SOURCE_URL}/releases"`) &&
    portableInstaller.includes("url === expectedUrl") &&
    portableInstaller.includes(
      "Handy.API_${version}_${bundleArch}-setup.exe",
    ) &&
    portableInstallerTest.includes("https://evil.example/") &&
    portableInstallerTest.includes("https://github.com/cjpais/Handy/releases/"),
  "portable installer does not fail closed to the exact fork release artifact",
);

const aboutSettings = read("src/components/settings/about/AboutSettings.tsx");
const llmClient = read("src-tauri/src/llm_client.rs");
expect(
  aboutSettings.includes(`openUrl("${SOURCE_URL}")`),
  "About source-code link does not target the Handy API repository",
);
expect(
  llmClient.includes(`HeaderValue::from_static("${SOURCE_URL}")`) &&
    llmClient.includes(`Handy-Api/1.0 (+${SOURCE_URL})`) &&
    llmClient.includes('HeaderValue::from_static("Handy API")'),
  "post-processing request identity does not target Handy API",
);
expect(
  !aboutSettings.includes("https://github.com/cjpais/Handy") &&
    !llmClient.includes("https://github.com/cjpais/Handy"),
  "product-owned runtime source identity still points to upstream Handy",
);

const legacyReleaseWorkflow = read(".github/workflows/release.yml");
const handyApiCi = read(".github/workflows/handy-api-ci.yml");
const upstreamSync = read(".github/workflows/upstream-sync.yml");
expect(
  (legacyReleaseWorkflow.match(/if: github\.repository == 'cjpais\/Handy'/g)
    ?.length ?? 0) >= 2,
  "legacy manual release workflow is not hard-gated to official Handy",
);
for (const [inheritedGate, minimumGates] of [
  [".github/workflows/main-build.yml", 1],
  [".github/workflows/code-quality.yml", 1],
  [".github/workflows/test.yml", 1],
  [".github/workflows/playwright.yml", 1],
  [".github/workflows/nix-check.yml", 1],
  [".github/workflows/build.yml", 1],
  [".github/workflows/build-test.yml", 1],
  [".github/workflows/pr-test-build.yml", 2],
] as const) {
  expect(
    (read(inheritedGate).match(/if: github\.repository == 'cjpais\/Handy'/g)
      ?.length ?? 0) >= minimumGates,
    `inherited workflow is not gated to official Handy: ${inheritedGate}`,
  );
}
expect(
  (handyApiCi.match(/if: github\.repository == 'MakinaX\/Handy-Api'/g)
    ?.length ?? 0) >= 3,
  "Handy API CI is not hard-gated to the exact product repository",
);
expect(
  upstreamSync.includes("if: github.repository == 'MakinaX/Handy-Api'") &&
    upstreamSync.includes(
      'if [[ "$GITHUB_REPOSITORY" != "MakinaX/Handy-Api" ]]',
    ),
  "upstream-sync is not hard-gated to the exact product repository",
);
for (const releaseInvariant of [
  "src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis",
  "handy-api.exe",
  "Handy API releases require a public GitHub repository",
  "Upstream sync must be dispatched from the fork main branch",
  "Cryptographic updater signature verification failed",
  "minisign-0.12-win64.zip",
  "37b600344e20c19314b2e82813db2bfdcc408b77b876f7727889dbd46d539479",
  "Handy.API_${fork_version}_x64-setup.exe",
  "build-unsigned-windows-x64:",
  `--config '{"bundle":{"createUpdaterArtifacts":false}}'`,
  "sign-windows-updater:",
  "name: handy-api-signing",
  "cargo install tauri-cli --version 2.11.4 --locked",
  "handy-api-windows-x64-signed-",
  "cmp --silent",
  '--repository "$GITHUB_REPOSITORY"',
  "name: handy-api-production",
  "--draft=false",
]) {
  expect(
    upstreamSync.includes(releaseInvariant),
    `upstream-sync release invariant is missing: ${releaseInvariant}`,
  );
}
const unsignedVerificationStepStart = upstreamSync.indexOf(
  "- name: Verify exact unsigned updater output and runtime",
);
const unsignedUploadStepStart = upstreamSync.indexOf(
  "- name: Upload exact unsigned signing input",
  unsignedVerificationStepStart,
);
expect(
  unsignedVerificationStepStart >= 0 &&
    unsignedUploadStepStart > unsignedVerificationStepStart,
  "unsigned installer verification step boundaries are missing",
);
const unsignedVerificationStep = upstreamSync.slice(
  unsignedVerificationStepStart,
  unsignedUploadStepStart,
);
for (const unsignedInvariant of [
  '$generatedName = "Handy API_$($env:FORK_VERSION)_x64-setup.exe"',
  '$expectedName = "Handy.API_$($env:FORK_VERSION)_x64-setup.exe"',
  "$generatedInstallers.Count -ne 1",
  "$generatedInstallers[0].Name -cne $generatedName",
  "[IO.FileAttributes]::ReparsePoint",
  'Get-ChildItem $bundle -File -Filter "*.sig"',
  "if (Test-Path $expectedPath)",
  "Get-FileHash -LiteralPath $generatedInstaller.FullName",
  "Move-Item -LiteralPath $generatedInstaller.FullName -Destination $expectedPath",
  "$canonicalInstallers.Count -ne 1",
  "$canonicalInstallers[0].Name -cne $expectedName",
  "-not (Test-Path $expectedPath -PathType Leaf)",
  "$installer = Get-Item -LiteralPath $expectedPath",
  "$canonicalHash -cne $generatedHash",
  "$postSmokeHash -cne $generatedHash",
  "Copy-Item -LiteralPath $installer.FullName -Destination $stagedPath",
  "$stagedHash -cne $generatedHash",
]) {
  expect(
    unsignedVerificationStep.includes(unsignedInvariant),
    `unsigned installer verification invariant is missing: ${unsignedInvariant}`,
  );
}
const rawInstallerCheck = unsignedVerificationStep.indexOf(
  '$generatedName = "Handy API_$($env:FORK_VERSION)_x64-setup.exe"',
);
const rawExactNameCheck = unsignedVerificationStep.indexOf(
  "$generatedInstallers[0].Name -cne $generatedName",
);
const unsignedSignatureCheck = unsignedVerificationStep.indexOf(
  'Get-ChildItem $bundle -File -Filter "*.sig"',
);
const destinationCollisionCheck = unsignedVerificationStep.indexOf(
  "if (Test-Path $expectedPath)",
);
const rawByteHash = unsignedVerificationStep.indexOf(
  "Get-FileHash -LiteralPath $generatedInstaller.FullName",
);
const canonicalRename = unsignedVerificationStep.indexOf(
  "Move-Item -LiteralPath $generatedInstaller.FullName -Destination $expectedPath",
);
const canonicalEnumeration = unsignedVerificationStep.indexOf(
  "$canonicalInstallers = @(",
);
const canonicalExactNameCheck = unsignedVerificationStep.indexOf(
  "$canonicalInstallers[0].Name -cne $expectedName",
);
const canonicalByteCheck = unsignedVerificationStep.indexOf(
  "$canonicalHash -cne $generatedHash",
);
const installedRuntimeSmoke = unsignedVerificationStep.indexOf(
  "$install = Start-Process -FilePath $installer.FullName",
);
const postSmokeByteCheck = unsignedVerificationStep.indexOf(
  "$postSmokeHash -cne $generatedHash",
);
const stagedCopy = unsignedVerificationStep.indexOf(
  "Copy-Item -LiteralPath $installer.FullName -Destination $stagedPath",
);
const stagedByteCheck = unsignedVerificationStep.indexOf(
  "$stagedHash -cne $generatedHash",
);
expect(
  rawInstallerCheck >= 0 &&
    rawExactNameCheck > rawInstallerCheck &&
    unsignedSignatureCheck > rawExactNameCheck &&
    destinationCollisionCheck > unsignedSignatureCheck &&
    rawByteHash > destinationCollisionCheck &&
    canonicalRename > rawByteHash &&
    canonicalEnumeration > canonicalRename &&
    canonicalExactNameCheck > canonicalEnumeration &&
    canonicalByteCheck > canonicalExactNameCheck &&
    installedRuntimeSmoke > canonicalByteCheck &&
    postSmokeByteCheck > installedRuntimeSmoke &&
    stagedCopy > postSmokeByteCheck &&
    stagedByteCheck > stagedCopy,
  "unsigned installer canonicalization and byte checks are out of order",
);
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
  "humbletim/install-vulkan-sdk@30ba978f977e81b72d091fc8888feb1fb26f9aff",
  "version: 1.4.309.0",
  "VK_HEADER_VERSION 309",
  "VkLayerSettingTypeEXT",
  "VkLayerSettingsCreateInfoEXT",
  "CMAKE_PREFIX_PATH=$VULKAN_SDK",
  "CPATH=$VULKAN_SDK/include",
  "binutils",
  'ort_version="1.24.2"',
  "https://blob.handy.computer/onnxruntime-linux-x86_64-${ort_version}.tgz",
  "7e8062d5cda514fe3e31d805f9aabd50bed42d331994f66753d2dd697294b976",
  "873ed82ce0d898d6e588f31f415be11f9d9ac036984dcb9bbdc4e38058b1c8e4",
  "libonnxruntime.so.1.24.2",
  "Library soname: [libonnxruntime.so.1]",
  'test "$max_glibc" = "GLIBC_2.34"',
  "__isoc23_",
  "ORT_LIB_LOCATION=$ort_dir/lib",
  "ORT_PREFER_DYNAMIC_LINK=1",
  "LD_LIBRARY_PATH=$ort_dir/lib",
  "DeterminateSystems/nix-installer-action@ef8a148080ab6020fd15196c2084a2eea5ff2d25",
  "nix flake metadata --no-write-lock-file",
  "nix eval --raw .#packages.x86_64-linux.handy-api.meta.mainProgram",
  "nix eval --raw .#packages.aarch64-linux.handy-api.meta.mainProgram",
  "nix build .#handy-api --print-build-logs",
  "test -x result/bin/handy-api",
]) {
  expect(
    handyApiCi.includes(ciInvariant),
    `Handy API CI invariant is missing: ${ciInvariant}`,
  );
}
expect(
  !handyApiCi.includes("nix flake check --no-build"),
  "Handy API CI must not use the bun2nix-incompatible no-build flake check",
);

const rustTestsJob = handyApiCi.match(
  /\n  rust-tests:\n([\s\S]*?)\n  nix-package:/,
)?.[1];
const vulkanInstallIndex =
  rustTestsJob?.indexOf("Install pinned Vulkan SDK") ?? -1;
const vulkanVerifyIndex =
  rustTestsJob?.indexOf("Verify pinned Vulkan SDK headers") ?? -1;
const ortInstallIndex =
  rustTestsJob?.indexOf("Install pinned baseline ONNX Runtime") ?? -1;
const clippyIndex = rustTestsJob?.indexOf("Run Clippy") ?? -1;
const rustTestIndex = rustTestsJob?.indexOf("Run Rust tests") ?? -1;
expect(
  rustTestsJob !== undefined &&
    rustTestsJob.includes(
      "humbletim/install-vulkan-sdk@30ba978f977e81b72d091fc8888feb1fb26f9aff",
    ) &&
    rustTestsJob.includes("version: 1.4.309.0") &&
    rustTestsJob.includes("VK_HEADER_VERSION 309") &&
    vulkanInstallIndex >= 0 &&
    vulkanVerifyIndex > vulkanInstallIndex &&
    ortInstallIndex > vulkanVerifyIndex &&
    rustTestsJob.includes(
      "https://blob.handy.computer/onnxruntime-linux-x86_64-${ort_version}.tgz",
    ) &&
    rustTestsJob.includes(
      "7e8062d5cda514fe3e31d805f9aabd50bed42d331994f66753d2dd697294b976",
    ) &&
    rustTestsJob.includes(
      "873ed82ce0d898d6e588f31f415be11f9d9ac036984dcb9bbdc4e38058b1c8e4",
    ) &&
    rustTestsJob.includes("binutils") &&
    rustTestsJob.includes("libonnxruntime.so.1.24.2") &&
    rustTestsJob.includes("Library soname: [libonnxruntime.so.1]") &&
    rustTestsJob.includes('test "$max_glibc" = "GLIBC_2.34"') &&
    rustTestsJob.includes("__isoc23_") &&
    rustTestsJob.includes("ORT_LIB_LOCATION=$ort_dir/lib") &&
    rustTestsJob.includes("ORT_PREFER_DYNAMIC_LINK=1") &&
    rustTestsJob.includes("LD_LIBRARY_PATH=$ort_dir/lib") &&
    clippyIndex > ortInstallIndex &&
    rustTestIndex > ortInstallIndex,
  "Rust CI must install verified Vulkan SDK 1.4.309 and baseline dynamic ONNX Runtime 1.24.2 before compilation",
);

const unsignedBuildJob = upstreamSync.match(
  /\n  build-unsigned-windows-x64:\n([\s\S]*?)\n  sign-windows-updater:/,
)?.[1];
const signingJob = upstreamSync.match(
  /\n  sign-windows-updater:\n([\s\S]*?)\n  publish-release:/,
)?.[1];
const signingSecretStep = signingJob?.match(
  /\n      - name: Sign exact updater artifact\n([\s\S]*?)\n      - name:/,
)?.[1];
expect(
  unsignedBuildJob !== undefined &&
    unsignedBuildJob.includes('createUpdaterArtifacts":false') &&
    !unsignedBuildJob.includes("TAURI_SIGNING_PRIVATE_KEY") &&
    !unsignedBuildJob.includes("handy-api-signing"),
  "candidate build is not isolated from updater signing secrets",
);
expect(
  signingJob !== undefined &&
    signingJob.includes("name: handy-api-signing") &&
    signingJob.includes(
      "TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}",
    ) &&
    signingJob.includes(
      "TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}",
    ) &&
    signingJob.includes("cargo install tauri-cli --version 2.11.4 --locked") &&
    !signingJob.includes("actions/checkout") &&
    !signingJob.includes("bun run") &&
    !signingJob.includes("tauri build"),
  "signing job must not checkout or execute candidate source",
);
expect(
  (upstreamSync.match(/secrets\.TAURI_SIGNING_PRIVATE_KEY/g)?.length ?? 0) ===
    2 &&
    signingJob?.match(/secrets\.TAURI_SIGNING_PRIVATE_KEY/g)?.length === 2 &&
    signingSecretStep?.match(/secrets\.TAURI_SIGNING_PRIVATE_KEY/g)?.length ===
      2,
  "updater signing secrets must be referenced only by the isolated signer step",
);

for (const workflow of [
  ".github/workflows/handy-api-ci.yml",
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

const flake = read("flake.nix");
const nixModule = read("nix/module.nix");
const homeManagerModule = read("nix/hm-module.nix");
expect(
  flake.includes('pname = "handy-api";') &&
    flake.includes('mainProgram = "handy-api";') &&
    flake.includes(`homepage = "${SOURCE_URL}";`) &&
    flake.includes('self.packages.${system}."handy-api"') &&
    flake.includes('"--linker=isolated"') &&
    flake.includes('"--backend=copyfile"'),
  "Nix package identity is not Handy API",
);
expect(
  flake.includes('cratesIoApiBase = "https://crates.io/api/v1/crates";') &&
    flake.includes('cratesIoStaticBase = "https://static.crates.io/crates";') &&
    flake.includes("staticCratesImportCargoLock") &&
    flake.includes("buildRustPackageWithStaticCrates") &&
    flake.includes('"handy-api" = buildRustPackageWithStaticCrates {'),
  "Nix Cargo vendoring must use the checksum-verified crates.io static CDN",
);
expect(
  nixModule.includes('options.programs."handy-api"') &&
    homeManagerModule.includes('options.services."handy-api"') &&
    homeManagerModule.includes('/bin/handy-api"'),
  "Nix module or service identity is not Handy API",
);

const retiredProductFragments = [
  ["handy", "gemini"].join("-"),
  ["handy", "gemini"].join(" "),
  ["handy", "gemini"].join("."),
  ["computer", "handy", "gemini"].join("."),
  ["", "gemini."].join("-"),
];
const productOwnedIdentityFiles = [
  "package.json",
  "bun.lock",
  ".nix/bun-lock-hash",
  "flake.nix",
  "nix/module.nix",
  "nix/hm-module.nix",
  "index.html",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
  "src-tauri/tauri.conf.json",
  "src-tauri/build.rs",
  "src-tauri/nsis/installer.nsi",
  "src-tauri/src/actions.rs",
  "src-tauri/src/cli.rs",
  "src-tauri/src/gemini_key.rs",
  "src-tauri/src/lib.rs",
  "src-tauri/src/llm_client.rs",
  "src-tauri/src/main.rs",
  "src-tauri/src/portable.rs",
  "src-tauri/src/settings.rs",
  "src-tauri/src/shortcut/mod.rs",
  "src-tauri/src/tray.rs",
  "src/components/settings/about/AboutSettings.tsx",
  "src/components/settings/debug/DebugPaths.tsx",
  "src/components/update-checker/portableInstaller.ts",
  "src/components/update-checker/portableInstaller.test.ts",
  ".github/workflows/handy-api-ci.yml",
  ".github/workflows/upstream-sync.yml",
];
for (const productOwnedFile of productOwnedIdentityFiles) {
  const normalized = read(productOwnedFile).toLowerCase();
  for (const retiredProductFragment of retiredProductFragments) {
    expect(
      !normalized.includes(retiredProductFragment),
      `retired Gemini-product identity remains: ${productOwnedFile}`,
    );
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`ERROR: ${error}`);
  process.exit(1);
}

console.log(
  `Handy API release contract OK (${packageJson.version}${releaseMode ? ", release mode" : ", placeholders allowed"})`,
);
