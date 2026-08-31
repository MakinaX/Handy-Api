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

const receiptContract = read("scripts/handy-api-receipt-contract.ts");
const receiptContractTest = read("scripts/handy-api-receipt-contract.test.ts");
for (const receiptField of [
  "schema_version",
  "repository",
  "github_run_id",
  "candidate_sha",
  "fork_version",
  "unsigned_artifact_name",
  "unsigned_artifact_id",
  "unsigned_artifact_archive_sha256",
  "installer_filename",
  "installer_size_bytes",
  "installer_sha256",
  "signed_artifact_name",
  "signed_artifact_id",
  "signed_artifact_archive_sha256",
  "unsigned_receipt_artifact_name",
  "unsigned_receipt_artifact_id",
  "unsigned_receipt_artifact_archive_sha256",
  "unsigned_receipt_filename",
  "unsigned_receipt_sha256",
  "pre_sign_installer_sha256",
  "post_sign_installer_sha256",
  "signature_filename",
  "signature_sha256",
  "byte_invariance",
  "cryptographic_signature_verified",
]) {
  expect(
    receiptContract.includes(`"${receiptField}"`),
    `receipt schema field is not covered: ${receiptField}`,
  );
}
for (const negativeReceiptCase of [
  "tampered receipt SHA",
  "receipt candidate SHA mismatch",
  "one-byte installer change",
  "pre/post installer mismatch",
  "foreign installer",
  "extra installer",
  "tampered unsigned receipt identity",
  "missing schema field",
  "extra schema field",
  "duplicate schema field",
  "extra receipt artifact file",
  "unsigned artifact ID mismatch",
  "unsigned artifact archive digest mismatch",
  "unsigned receipt artifact ID mismatch",
  "unsigned receipt artifact archive digest mismatch",
  "signed artifact name mismatch",
  "signed artifact ID mismatch",
  "signed artifact archive digest mismatch",
  "signed installer change",
  "signature change",
  "false byte invariance",
  "false cryptographic verification",
]) {
  expect(
    receiptContractTest.includes(`"${negativeReceiptCase}"`),
    `receipt negative case is not covered: ${negativeReceiptCase}`,
  );
}
expect(
  receiptContract.includes("assertExactKeys") &&
    receiptContract.includes("requireExactFiles") &&
    receiptContract.includes("assertArtifactArchiveIdentity") &&
    receiptContract.includes("assertNoDuplicateTopLevelFields") &&
    receiptContract.includes("GITHUB_ARTIFACT_ID_PATTERN") &&
    receiptContract.includes("raw.pre_sign_installer_sha256 !==") &&
    receiptContract.includes("raw.post_sign_installer_sha256") &&
    receiptContractTest.includes("expectEveryMissingFieldFails(") &&
    receiptContractTest.includes("unsignedWrongTypes") &&
    receiptContractTest.includes("signingWrongTypes") &&
    receiptContractTest.includes("verifyUnsignedReceiptAndInput(") &&
    receiptContractTest.includes("verifySigningReceiptAndArtifacts("),
  "receipt tests do not exercise exact schemas, inventories, and byte invariance",
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
  "handy-api-windows-x64-unsigned-receipt-",
  "handy-api-windows-x64-unsigned-receipt.json",
  "handy-api-windows-x64-signed-",
  "handy-api-windows-x64-signing-receipt-",
  "handy-api-windows-x64-signing-receipt.json",
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
const unsignedReceiptCreationStepStart = upstreamSync.indexOf(
  "- name: Create durable unsigned receipt",
  unsignedUploadStepStart,
);
const unsignedReceiptUploadStepStart = upstreamSync.indexOf(
  "- name: Upload durable unsigned receipt",
  unsignedReceiptCreationStepStart,
);
expect(
  unsignedVerificationStepStart >= 0 &&
    unsignedUploadStepStart > unsignedVerificationStepStart &&
    unsignedReceiptCreationStepStart > unsignedUploadStepStart &&
    unsignedReceiptUploadStepStart > unsignedReceiptCreationStepStart,
  "unsigned installer/receipt step boundaries are missing or out of order",
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

const unsignedUploadStep = upstreamSync.slice(
  unsignedUploadStepStart,
  unsignedReceiptCreationStepStart,
);
const unsignedReceiptCreationStep = upstreamSync.slice(
  unsignedReceiptCreationStepStart,
  unsignedReceiptUploadStepStart,
);
const unsignedReceiptUploadStep = upstreamSync.slice(
  unsignedReceiptUploadStepStart,
  upstreamSync.indexOf(
    "\n  sign-windows-updater:",
    unsignedReceiptUploadStepStart,
  ),
);
expect(
  unsignedUploadStep.includes("id: upload-unsigned") &&
    unsignedUploadStep.includes(
      "path: unsigned-assets/Handy.API_${{ needs.prepare-candidate.outputs.fork-version }}_x64-setup.exe",
    ) &&
    !unsignedUploadStep.includes("receipt"),
  "unsigned signing-input artifact must upload only the canonical installer and expose immutable outputs",
);
for (const receiptCreationInvariant of [
  "CANDIDATE_SHA: ${{ needs.prepare-candidate.outputs.candidate-sha }}",
  "UNSIGNED_ARTIFACT_ID: ${{ steps.upload-unsigned.outputs.artifact-id }}",
  "UNSIGNED_ARTIFACT_ARCHIVE_SHA256: ${{ steps.upload-unsigned.outputs.artifact-digest }}",
  "$env:UNSIGNED_ARTIFACT_ID -notmatch '^[1-9][0-9]*$'",
  "$env:UNSIGNED_ARTIFACT_ARCHIVE_SHA256 -notmatch '^[0-9a-f]{64}$'",
  "schema_version = 1",
  "repository = $env:GITHUB_REPOSITORY",
  "github_run_id = [string]$env:GITHUB_RUN_ID",
  "candidate_sha = $env:CANDIDATE_SHA",
  "fork_version = $env:FORK_VERSION",
  "unsigned_artifact_name = $env:UNSIGNED_ARTIFACT_NAME",
  "unsigned_artifact_id = $env:UNSIGNED_ARTIFACT_ID",
  "unsigned_artifact_archive_sha256 = $env:UNSIGNED_ARTIFACT_ARCHIVE_SHA256",
  "installer_filename = $expectedName",
  "installer_size_bytes = [int64]$stagedInstaller.Length",
  "installer_sha256 = $stagedHash",
  "$receiptFiles.Count -ne 1",
  "$actualReceiptFields.Count -ne $expectedReceiptFields.Count",
  "$receiptReadback.candidate_sha -cne $env:CANDIDATE_SHA",
  "$receiptReadback.unsigned_artifact_id -cne $env:UNSIGNED_ARTIFACT_ID",
  "$receiptReadback.unsigned_artifact_archive_sha256 -cne",
  "$receiptReadback.installer_size_bytes",
  "$receiptReadback.installer_sha256 -cne $stagedHash",
]) {
  expect(
    unsignedReceiptCreationStep.includes(receiptCreationInvariant),
    `unsigned receipt creation invariant is missing: ${receiptCreationInvariant}`,
  );
}
expect(
  unsignedReceiptUploadStep.includes("id: upload-unsigned-receipt") &&
    unsignedReceiptUploadStep.includes(
      "name: handy-api-windows-x64-unsigned-receipt-${{ needs.prepare-candidate.outputs.fork-version }}",
    ) &&
    unsignedReceiptUploadStep.includes(
      "path: unsigned-receipt/handy-api-windows-x64-unsigned-receipt.json",
    ) &&
    !unsignedReceiptUploadStep.includes("unsigned-assets/"),
  "durable unsigned receipt must be uploaded as a separate exact-one-file artifact",
);
for (const ciInvariant of [
  "bun install --frozen-lockfile",
  "bun scripts/handy-api-receipt-contract.test.ts",
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
const signingJobSource = signingJob ?? "";
const signingInputDownloadStart = signingJobSource.indexOf(
  "- name: Download exact unsigned signing input",
);
const signingReceiptDownloadStart = signingJobSource.indexOf(
  "- name: Download durable unsigned receipt",
);
const signingInputVerificationStart = signingJobSource.indexOf(
  "- name: Verify exact unsigned receipt and signing input",
);
const signerInstallStart = signingJobSource.indexOf(
  "- name: Install trusted Tauri signer without secrets",
);
const signerCommandStart = signingJobSource.indexOf(
  "- name: Sign exact updater artifact",
);
const signatureVerificationStart = signingJobSource.indexOf(
  "- name: Verify byte invariance and exact signature with committed public key",
);
const signedArtifactUploadStart = signingJobSource.indexOf(
  "- name: Upload exact signed acceptance artifact",
);
const signingReceiptCreationStart = signingJobSource.indexOf(
  "- name: Create durable signing receipt",
);
const signingReceiptUploadStart = signingJobSource.indexOf(
  "- name: Upload durable signing receipt",
);
expect(
  unsignedBuildJob !== undefined &&
    unsignedBuildJob.includes('createUpdaterArtifacts":false') &&
    unsignedBuildJob.includes(
      "unsigned-artifact-id: ${{ steps.upload-unsigned.outputs.artifact-id }}",
    ) &&
    unsignedBuildJob.includes(
      "unsigned-artifact-digest: ${{ steps.upload-unsigned.outputs.artifact-digest }}",
    ) &&
    unsignedBuildJob.includes(
      "unsigned-receipt-artifact-id: ${{ steps.upload-unsigned-receipt.outputs.artifact-id }}",
    ) &&
    unsignedBuildJob.includes(
      "unsigned-receipt-artifact-digest: ${{ steps.upload-unsigned-receipt.outputs.artifact-digest }}",
    ) &&
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
    signingJob.includes(
      "signed-artifact-id: ${{ steps.upload-signed.outputs.artifact-id }}",
    ) &&
    signingJob.includes(
      "signed-artifact-digest: ${{ steps.upload-signed.outputs.artifact-digest }}",
    ) &&
    signingJob.includes(
      "signing-receipt-artifact-id: ${{ steps.upload-signing-receipt.outputs.artifact-id }}",
    ) &&
    signingJob.includes(
      "signing-receipt-artifact-digest: ${{ steps.upload-signing-receipt.outputs.artifact-digest }}",
    ) &&
    signingJob.includes("cargo install tauri-cli --version 2.11.4 --locked") &&
    !signingJob.includes("actions/checkout") &&
    !signingJob.includes("bun run") &&
    !signingJob.includes("tauri build"),
  "signing job must not checkout or execute candidate source",
);
expect(
  signingInputDownloadStart >= 0 &&
    signingReceiptDownloadStart > signingInputDownloadStart &&
    signingInputVerificationStart > signingReceiptDownloadStart &&
    signerInstallStart > signingInputVerificationStart &&
    signerCommandStart > signerInstallStart &&
    signatureVerificationStart > signerCommandStart &&
    signedArtifactUploadStart > signatureVerificationStart &&
    signingReceiptCreationStart > signedArtifactUploadStart &&
    signingReceiptUploadStart > signingReceiptCreationStart,
  "signer receipt/download/signature steps are missing or out of order",
);

const signingInputDownloadStep = signingJobSource.slice(
  signingInputDownloadStart,
  signingReceiptDownloadStart,
);
const signingReceiptDownloadStep = signingJobSource.slice(
  signingReceiptDownloadStart,
  signingInputVerificationStart,
);
expect(
  signingInputDownloadStep.includes(
    "artifact-ids: ${{ needs.build-unsigned-windows-x64.outputs.unsigned-artifact-id }}",
  ) &&
    signingInputDownloadStep.includes("path: signing-input") &&
    signingInputDownloadStep.includes("merge-multiple: true") &&
    !signingInputDownloadStep.includes("name: handy-api-windows"),
  "signer must download the unsigned installer by its exact uploaded artifact ID",
);
expect(
  signingReceiptDownloadStep.includes(
    "artifact-ids: ${{ needs.build-unsigned-windows-x64.outputs.unsigned-receipt-artifact-id }}",
  ) &&
    signingReceiptDownloadStep.includes("path: unsigned-receipt") &&
    signingReceiptDownloadStep.includes("merge-multiple: true") &&
    !signingReceiptDownloadStep.includes("name: handy-api-windows"),
  "signer must download the durable receipt by its exact uploaded artifact ID",
);

const signingInputVerificationStep = signingJobSource.slice(
  signingInputVerificationStart,
  signerInstallStart,
);
for (const signingInputInvariant of [
  "CANDIDATE_SHA: ${{ needs.prepare-candidate.outputs.candidate-sha }}",
  "WORKFLOW_SOURCE_SHA: ${{ github.sha }}",
  "UNSIGNED_ARTIFACT_ID: ${{ needs.build-unsigned-windows-x64.outputs.unsigned-artifact-id }}",
  "UNSIGNED_ARTIFACT_ARCHIVE_SHA256: ${{ needs.build-unsigned-windows-x64.outputs.unsigned-artifact-digest }}",
  "UNSIGNED_RECEIPT_ARTIFACT_ID: ${{ needs.build-unsigned-windows-x64.outputs.unsigned-receipt-artifact-id }}",
  "UNSIGNED_RECEIPT_ARTIFACT_ARCHIVE_SHA256: ${{ needs.build-unsigned-windows-x64.outputs.unsigned-receipt-artifact-digest }}",
  "$inputFiles.Count -ne 1",
  "$inputFiles[0].Name -cne $expectedName",
  "$receiptFiles.Count -ne 1",
  "$receiptFiles[0].Name -cne $expectedReceiptFilename",
  "$rawReceiptFields",
  "$rawReceiptKinds",
  "$actualReceiptFields.Count -ne $expectedReceiptFields.Count",
  "Unsigned receipt numeric fields must be JSON numbers",
  '$receipt.repository -cne "MakinaX/Handy-Api"',
  "$receipt.github_run_id -cne [string]$env:GITHUB_RUN_ID",
  "$receipt.candidate_sha -cne $env:CANDIDATE_SHA",
  "$receipt.unsigned_artifact_id -cne $env:UNSIGNED_ARTIFACT_ID",
  "$receipt.unsigned_artifact_archive_sha256 -cne",
  "$actualInstallerHash -cne $receipt.installer_sha256",
  "$actualInstallerSize -ne [int64]$receipt.installer_size_bytes",
  "actions/artifacts/$env:UNSIGNED_ARTIFACT_ID",
  "actions/artifacts/$env:UNSIGNED_RECEIPT_ARTIFACT_ID",
  "$unsignedArtifact.workflow_run.id",
  "$unsignedArtifact.workflow_run.head_sha",
  '"sha256:$($env:UNSIGNED_ARTIFACT_ARCHIVE_SHA256)"',
  "$unsignedReceiptArtifact.workflow_run.id",
  "$unsignedReceiptArtifact.workflow_run.head_sha",
  '"sha256:$($env:UNSIGNED_RECEIPT_ARTIFACT_ARCHIVE_SHA256)"',
  "HANDY_API_UNSIGNED_RECEIPT_SHA256=$unsignedReceiptHash",
  "HANDY_API_RECEIPT_INSTALLER_SHA256=$actualInstallerHash",
  "HANDY_API_RECEIPT_INSTALLER_SIZE=$actualInstallerSize",
  "HANDY_API_UNSIGNED_RECEIPT_ARTIFACT_ID=",
  "HANDY_API_UNSIGNED_RECEIPT_ARTIFACT_ARCHIVE_SHA256=",
]) {
  expect(
    signingInputVerificationStep.includes(signingInputInvariant),
    `signer unsigned receipt verification invariant is missing: ${signingInputInvariant}`,
  );
}
expect(
  /\$unsignedArtifact\.workflow_run\.head_sha\s+-cne\s+\$env:WORKFLOW_SOURCE_SHA\s+-or/.test(
    signingInputVerificationStep,
  ) &&
    /\$unsignedReceiptArtifact\.workflow_run\.head_sha\s+-cne\s+\$env:WORKFLOW_SOURCE_SHA\s+-or/.test(
      signingInputVerificationStep,
    ),
  "artifact API head SHA must be compared exactly to the workflow source SHA",
);
const unsignedApiReadback = signingInputVerificationStep.indexOf(
  "$unsignedArtifact = Invoke-RestMethod",
);
const unsignedReceiptApiReadback = signingInputVerificationStep.indexOf(
  "$unsignedReceiptArtifact = Invoke-RestMethod",
);
const candidateConfigRead =
  signingInputVerificationStep.indexOf("$configUri =");
expect(
  unsignedApiReadback >= 0 &&
    unsignedReceiptApiReadback > unsignedApiReadback &&
    candidateConfigRead > unsignedReceiptApiReadback,
  "artifact API metadata read-back must complete before candidate public-key data is read",
);

const signerCommandStep = signingJobSource.slice(
  signerCommandStart,
  signatureVerificationStart,
);
const preSignInventory = signerCommandStep.indexOf("$preSignFiles = @(");
const preSignHash = signerCommandStep.indexOf("$preSignHash = (");
const preSignSize = signerCommandStep.indexOf("$preSignSize = [int64]");
const preSignReceiptGate = signerCommandStep.indexOf(
  "$preSignHash -cne $env:HANDY_API_RECEIPT_INSTALLER_SHA256",
);
const tauriSignCommand = signerCommandStep.indexOf(
  "& $env:TAURI_SIGNER_EXE signer sign $installer",
);
const postSignHash = signerCommandStep.indexOf("$postSignHash = (");
const postSignSize = signerCommandStep.indexOf("$postSignSize = [int64]");
const byteInvarianceGate = signerCommandStep.indexOf(
  "$postSignHash -cne $preSignHash",
);
const postSignInventory = signerCommandStep.indexOf("$postSignFiles = @(");
expect(
  preSignInventory >= 0 &&
    preSignHash > preSignInventory &&
    preSignSize > preSignHash &&
    preSignReceiptGate > preSignSize &&
    tauriSignCommand > preSignReceiptGate &&
    postSignHash > tauriSignCommand &&
    postSignSize > postSignHash &&
    byteInvarianceGate > postSignSize &&
    postSignInventory > byteInvarianceGate &&
    signerCommandStep.includes("$postSignSize -ne $preSignSize") &&
    signerCommandStep.includes("$postSignFiles.Count -ne 2") &&
    signerCommandStep.includes(
      "Tauri signer must add only the exact non-empty .sig file",
    ),
  "Tauri signing pre/post hash, size, and exact-new-file gates are incomplete or out of order",
);

const signatureVerificationStep = signingJobSource.slice(
  signatureVerificationStart,
  signedArtifactUploadStart,
);
expect(
  signatureVerificationStep.includes("id: verify-signed") &&
    signatureVerificationStep.includes("$signedFiles.Count -ne 2") &&
    signatureVerificationStep.includes(
      "$measurements.post_sign_installer_sha256 -cne",
    ) &&
    signatureVerificationStep.includes(
      "Cryptographic updater signature verification failed",
    ) &&
    signatureVerificationStep.includes('"installer-filename=$expectedName"') &&
    signatureVerificationStep.includes(
      '"installer-size-bytes=$currentInstallerSize"',
    ) &&
    signatureVerificationStep.includes(
      '"pre-sign-installer-sha256=$($measurements.pre_sign_installer_sha256)"',
    ) &&
    signatureVerificationStep.includes(
      '"post-sign-installer-sha256=$($measurements.post_sign_installer_sha256)"',
    ) &&
    signatureVerificationStep.includes(
      '"signature-filename=$expectedName.sig"',
    ) &&
    signatureVerificationStep.includes('"signature-sha256=$signatureHash"'),
  "verified signed evidence outputs must follow byte and cryptographic signature gates",
);

const signedArtifactUploadStep = signingJobSource.slice(
  signedArtifactUploadStart,
  signingReceiptCreationStart,
);
const signingReceiptCreationStep = signingJobSource.slice(
  signingReceiptCreationStart,
  signingReceiptUploadStart,
);
for (const signingReceiptInvariant of [
  "CANDIDATE_SHA: ${{ needs.prepare-candidate.outputs.candidate-sha }}",
  "INSTALLER_FILENAME: ${{ steps.verify-signed.outputs.installer-filename }}",
  "INSTALLER_SIZE_BYTES: ${{ steps.verify-signed.outputs.installer-size-bytes }}",
  "PRE_SIGN_INSTALLER_SHA256: ${{ steps.verify-signed.outputs.pre-sign-installer-sha256 }}",
  "POST_SIGN_INSTALLER_SHA256: ${{ steps.verify-signed.outputs.post-sign-installer-sha256 }}",
  "SIGNATURE_FILENAME: ${{ steps.verify-signed.outputs.signature-filename }}",
  "SIGNATURE_SHA256: ${{ steps.verify-signed.outputs.signature-sha256 }}",
  "SIGNED_ARTIFACT_NAME: handy-api-windows-x64-signed-${{ needs.prepare-candidate.outputs.fork-version }}",
  "SIGNED_ARTIFACT_ID: ${{ steps.upload-signed.outputs.artifact-id }}",
  "SIGNED_ARTIFACT_ARCHIVE_SHA256: ${{ steps.upload-signed.outputs.artifact-digest }}",
  "$env:SIGNED_ARTIFACT_ID -notmatch '^[1-9][0-9]*$'",
  "$env:SIGNED_ARTIFACT_ARCHIVE_SHA256 -notmatch",
  "$signedFiles.Count -ne 2",
  "$installerHash -cne $env:PRE_SIGN_INSTALLER_SHA256",
  "$installerHash -cne $env:POST_SIGN_INSTALLER_SHA256",
  "$signatureHash -cne $env:SIGNATURE_SHA256",
  "$unsignedReceiptHash -cne $env:HANDY_API_UNSIGNED_RECEIPT_SHA256",
  "$signingReceipt = [ordered]@{",
  "signed_artifact_name = $expectedSignedArtifactName",
  "signed_artifact_id = $env:SIGNED_ARTIFACT_ID",
  "signed_artifact_archive_sha256 =",
  "$env:SIGNED_ARTIFACT_ARCHIVE_SHA256",
  "unsigned_receipt_artifact_name =",
  "unsigned_receipt_artifact_id =",
  "$env:HANDY_API_UNSIGNED_RECEIPT_ARTIFACT_ID",
  "unsigned_receipt_artifact_archive_sha256 =",
  "$env:HANDY_API_UNSIGNED_RECEIPT_ARTIFACT_ARCHIVE_SHA256",
  "unsigned_receipt_filename =",
  "unsigned_receipt_sha256 = $unsignedReceiptHash",
  "pre_sign_installer_sha256 = $installerHash",
  "post_sign_installer_sha256 = $installerHash",
  "installer_size_bytes = $installerSize",
  "signature_filename = $expectedSignatureName",
  "signature_sha256 = $signatureHash",
  "byte_invariance = $true",
  "cryptographic_signature_verified = $true",
  "$signingReceiptFiles.Count -ne 1",
  "$rawKinds",
  "$actualFields.Count -ne $expectedFields.Count",
  "Signing receipt typed fields are invalid",
  "$signingReceiptReadback.signed_artifact_name -cne",
  "$signingReceiptReadback.signed_artifact_id -cne",
  "$signingReceiptReadback.signed_artifact_archive_sha256 -cne",
  "$signingReceiptReadback.unsigned_receipt_artifact_id -cne",
  "$signingReceiptReadback.unsigned_receipt_artifact_archive_sha256 -cne",
  "$signingReceiptReadback.pre_sign_installer_sha256 -cne",
  "$signingReceiptReadback.post_sign_installer_sha256 -cne",
  "$signingReceiptReadback.byte_invariance -cne $true",
  "$signingReceiptReadback.cryptographic_signature_verified -cne",
]) {
  expect(
    signingReceiptCreationStep.includes(signingReceiptInvariant),
    `durable signing receipt invariant is missing: ${signingReceiptInvariant}`,
  );
}

const signingReceiptUploadStep = signingJobSource.slice(
  signingReceiptUploadStart,
);
expect(
  signedArtifactUploadStep.includes("id: upload-signed") &&
    signedArtifactUploadStep.includes(
      "signed-assets/Handy.API_${{ needs.prepare-candidate.outputs.fork-version }}_x64-setup.exe",
    ) &&
    signedArtifactUploadStep.includes(
      "signed-assets/Handy.API_${{ needs.prepare-candidate.outputs.fork-version }}_x64-setup.exe.sig",
    ) &&
    !signedArtifactUploadStep.includes("receipt"),
  "signed acceptance artifact must contain only installer and signature",
);
expect(
  signingReceiptUploadStep.includes("id: upload-signing-receipt") &&
    signingReceiptUploadStep.includes(
      "path: signing-receipt/handy-api-windows-x64-signing-receipt.json",
    ) &&
    !signingReceiptUploadStep.includes("signed-assets/"),
  "signing receipt must be uploaded as a separate evidence artifact",
);

const publishReleaseJob = upstreamSync.match(
  /\n  publish-release:\n([\s\S]*)$/,
)?.[1];
const publishReleaseJobSource = publishReleaseJob ?? "";
const signedReleaseDownloadStart = publishReleaseJobSource.indexOf(
  "- name: Download verified release inputs",
);
const unsignedReleaseReceiptDownloadStart = publishReleaseJobSource.indexOf(
  "- name: Download unsigned release receipt",
);
const signingReleaseReceiptDownloadStart = publishReleaseJobSource.indexOf(
  "- name: Download signing release receipt",
);
const releaseManifestStart = publishReleaseJobSource.indexOf(
  "- name: Build and verify updater manifest",
);
const releaseUploadStart = publishReleaseJobSource.indexOf(
  "- name: Create non-public draft and upload exact assets",
);
const releaseInventoryStart = publishReleaseJobSource.indexOf(
  "- name: Verify draft inventory and uploaded bytes",
);
const releasePublishStart = publishReleaseJobSource.indexOf(
  "- name: Fast-forward main and publish verified draft",
);
expect(
  signedReleaseDownloadStart >= 0 &&
    unsignedReleaseReceiptDownloadStart > signedReleaseDownloadStart &&
    signingReleaseReceiptDownloadStart > unsignedReleaseReceiptDownloadStart &&
    releaseManifestStart > signingReleaseReceiptDownloadStart &&
    releaseUploadStart > releaseManifestStart &&
    releaseInventoryStart > releaseUploadStart &&
    releasePublishStart > releaseInventoryStart,
  "production receipt verification and public release steps are missing or out of order",
);

const signedReleaseDownloadStep = publishReleaseJobSource.slice(
  signedReleaseDownloadStart,
  unsignedReleaseReceiptDownloadStart,
);
const unsignedReleaseReceiptDownloadStep = publishReleaseJobSource.slice(
  unsignedReleaseReceiptDownloadStart,
  signingReleaseReceiptDownloadStart,
);
const signingReleaseReceiptDownloadStep = publishReleaseJobSource.slice(
  signingReleaseReceiptDownloadStart,
  releaseManifestStart,
);
expect(
  signedReleaseDownloadStep.includes(
    "artifact-ids: ${{ needs.sign-windows-updater.outputs.signed-artifact-id }}",
  ) &&
    signedReleaseDownloadStep.includes("path: release-assets") &&
    signedReleaseDownloadStep.includes("merge-multiple: true"),
  "production must download signed inputs by the exact signer artifact ID",
);
expect(
  unsignedReleaseReceiptDownloadStep.includes(
    "artifact-ids: ${{ needs.build-unsigned-windows-x64.outputs.unsigned-receipt-artifact-id }}",
  ) &&
    unsignedReleaseReceiptDownloadStep.includes("path: unsigned-receipt") &&
    unsignedReleaseReceiptDownloadStep.includes("merge-multiple: true") &&
    signingReleaseReceiptDownloadStep.includes(
      "artifact-ids: ${{ needs.sign-windows-updater.outputs.signing-receipt-artifact-id }}",
    ) &&
    signingReleaseReceiptDownloadStep.includes("path: signing-receipt") &&
    signingReleaseReceiptDownloadStep.includes("merge-multiple: true"),
  "production must download both evidence receipts by exact artifact IDs into non-public directories",
);

const releaseManifestStep = publishReleaseJobSource.slice(
  releaseManifestStart,
  releaseUploadStart,
);
for (const productionReceiptInvariant of [
  "signing_inputs=(release-assets/*)",
  "[[ ${#signing_inputs[@]} -ne 2 ]]",
  '[[ "$(find unsigned-receipt -type f | wc -l)" -eq 1 ]]',
  '[[ "$(find signing-receipt -type f | wc -l)" -eq 1 ]]',
  'unsigned_receipt_sha="$(sha256sum "$unsigned_receipt"',
  'installer_sha="$(sha256sum "$installer"',
  'signature_sha="$(sha256sum "$signature_file"',
  "UNSIGNED_ARTIFACT_ID: ${{ needs.build-unsigned-windows-x64.outputs.unsigned-artifact-id }}",
  "UNSIGNED_ARTIFACT_ARCHIVE_SHA256: ${{ needs.build-unsigned-windows-x64.outputs.unsigned-artifact-digest }}",
  '--arg artifact_id "$UNSIGNED_ARTIFACT_ID"',
  '--arg artifact_digest "$UNSIGNED_ARTIFACT_ARCHIVE_SHA256"',
  ".unsigned_artifact_id == $artifact_id",
  ".unsigned_artifact_archive_sha256 == $artifact_digest",
  "UNSIGNED_RECEIPT_ARTIFACT_ID: ${{ needs.build-unsigned-windows-x64.outputs.unsigned-receipt-artifact-id }}",
  "UNSIGNED_RECEIPT_ARTIFACT_ARCHIVE_SHA256: ${{ needs.build-unsigned-windows-x64.outputs.unsigned-receipt-artifact-digest }}",
  '--arg receipt_artifact_id "$UNSIGNED_RECEIPT_ARTIFACT_ID"',
  '--arg receipt_artifact_digest "$UNSIGNED_RECEIPT_ARTIFACT_ARCHIVE_SHA256"',
  "SIGNED_ARTIFACT_ID: ${{ needs.sign-windows-updater.outputs.signed-artifact-id }}",
  "SIGNED_ARTIFACT_ARCHIVE_SHA256: ${{ needs.sign-windows-updater.outputs.signed-artifact-digest }}",
  'signed_artifact_name="handy-api-windows-x64-signed-${FORK_VERSION}"',
  '--arg signed_artifact "$signed_artifact_name"',
  '--arg signed_artifact_id "$SIGNED_ARTIFACT_ID"',
  '--arg signed_artifact_digest "$SIGNED_ARTIFACT_ARCHIVE_SHA256"',
  ".signed_artifact_name == $signed_artifact",
  ".signed_artifact_id == $signed_artifact_id",
  ".signed_artifact_archive_sha256 == $signed_artifact_digest",
  ".unsigned_receipt_artifact_id == $receipt_artifact_id",
  ".unsigned_receipt_artifact_archive_sha256 ==",
  ".unsigned_receipt_sha256 == $receipt_sha",
  ".pre_sign_installer_sha256 == $installer_sha",
  ".post_sign_installer_sha256 == $installer_sha",
  ".installer_size_bytes == $size",
  ".signature_sha256 == $signature_sha",
  ".byte_invariance == true",
  ".cryptographic_signature_verified == true",
  "> release-assets/latest.json",
]) {
  expect(
    releaseManifestStep.includes(productionReceiptInvariant),
    `production receipt/release contract invariant is missing: ${productionReceiptInvariant}`,
  );
}

const releaseUploadStep = publishReleaseJobSource.slice(
  releaseUploadStart,
  releaseInventoryStart,
);
expect(
  releaseUploadStep.includes(
    '"release-assets/Handy.API_${FORK_VERSION}_x64-setup.exe"',
  ) &&
    releaseUploadStep.includes(
      '"release-assets/Handy.API_${FORK_VERSION}_x64-setup.exe.sig"',
    ) &&
    releaseUploadStep.includes("release-assets/latest.json") &&
    !releaseUploadStep.includes("unsigned-receipt") &&
    !releaseUploadStep.includes("signing-receipt") &&
    !releaseUploadStep.includes("receipt.json"),
  "public upload command must expose only installer, signature, and latest.json",
);

const releaseInventoryStep = publishReleaseJobSource.slice(
  releaseInventoryStart,
  releasePublishStart,
);
expect(
  releaseInventoryStep.includes(
    '([$installer, ($installer + ".sig"), "latest.json"] | sort)',
  ) &&
    releaseInventoryStep.includes(
      "[[ ${#local_assets[@]} -ne 3 || ${#uploaded_assets[@]} -ne 3 ]]",
    ) &&
    releaseInventoryStep.includes("cmp --silent"),
  "draft read-back must prove the exact three-file public inventory and byte equality",
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
