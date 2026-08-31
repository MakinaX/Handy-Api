import { createHash } from "node:crypto";

export const HANDY_API_REPOSITORY = "MakinaX/Handy-Api";
export const RECEIPT_SCHEMA_VERSION = 1;
export const UNSIGNED_RECEIPT_FILENAME =
  "handy-api-windows-x64-unsigned-receipt.json";
export const SIGNING_RECEIPT_FILENAME =
  "handy-api-windows-x64-signing-receipt.json";

const FORK_VERSION_PATTERN = /^\d+\.\d+\.\d+-api\.\d+$/;
const CANDIDATE_SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GITHUB_RUN_ID_PATTERN = /^[1-9]\d*$/;
const GITHUB_ARTIFACT_ID_PATTERN = /^[1-9]\d*$/;

const UNSIGNED_RECEIPT_KEYS = [
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
] as const;

const SIGNING_RECEIPT_KEYS = [
  "schema_version",
  "repository",
  "github_run_id",
  "candidate_sha",
  "fork_version",
  "installer_filename",
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
  "installer_size_bytes",
  "signature_filename",
  "signature_sha256",
  "byte_invariance",
  "cryptographic_signature_verified",
] as const;

export interface ReceiptFile {
  name: string;
  bytes: Uint8Array;
}

export interface ReceiptIdentity {
  repository: string;
  githubRunId: string;
  candidateSha: string;
  forkVersion: string;
}

export interface ArtifactArchiveIdentity {
  artifactId: string;
  archiveSha256: string;
}

export interface ReceiptArtifactIdentity extends ArtifactArchiveIdentity {
  receiptSha256: string;
}

export interface UnsignedReceipt {
  schema_version: number;
  repository: string;
  github_run_id: string;
  candidate_sha: string;
  fork_version: string;
  unsigned_artifact_name: string;
  unsigned_artifact_id: string;
  unsigned_artifact_archive_sha256: string;
  installer_filename: string;
  installer_size_bytes: number;
  installer_sha256: string;
}

export interface SigningReceipt {
  schema_version: number;
  repository: string;
  github_run_id: string;
  candidate_sha: string;
  fork_version: string;
  installer_filename: string;
  signed_artifact_name: string;
  signed_artifact_id: string;
  signed_artifact_archive_sha256: string;
  unsigned_receipt_artifact_name: string;
  unsigned_receipt_artifact_id: string;
  unsigned_receipt_artifact_archive_sha256: string;
  unsigned_receipt_filename: string;
  unsigned_receipt_sha256: string;
  pre_sign_installer_sha256: string;
  post_sign_installer_sha256: string;
  installer_size_bytes: number;
  signature_filename: string;
  signature_sha256: string;
  byte_invariance: boolean;
  cryptographic_signature_verified: boolean;
}

export function unsignedArtifactName(forkVersion: string): string {
  return `handy-api-windows-x64-unsigned-${forkVersion}`;
}

export function unsignedReceiptArtifactName(forkVersion: string): string {
  return `handy-api-windows-x64-unsigned-receipt-${forkVersion}`;
}

export function signingReceiptArtifactName(forkVersion: string): string {
  return `handy-api-windows-x64-signing-receipt-${forkVersion}`;
}

export function signedArtifactName(forkVersion: string): string {
  return `handy-api-windows-x64-signed-${forkVersion}`;
}

export function installerFilename(forkVersion: string): string {
  return `Handy.API_${forkVersion}_x64-setup.exe`;
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fail(message: string): never {
  throw new Error(message);
}

function assertIdentity(identity: ReceiptIdentity): void {
  if (identity.repository !== HANDY_API_REPOSITORY) {
    fail(`repository must be ${HANDY_API_REPOSITORY}`);
  }
  if (!GITHUB_RUN_ID_PATTERN.test(identity.githubRunId)) {
    fail("github run ID must be a non-zero decimal string");
  }
  if (!CANDIDATE_SHA_PATTERN.test(identity.candidateSha)) {
    fail("candidate SHA must be one lowercase 40-character commit ID");
  }
  if (!FORK_VERSION_PATTERN.test(identity.forkVersion)) {
    fail("fork version must use <upstream>-api.<revision>");
  }
}

function assertArtifactArchiveIdentity(
  identity: ArtifactArchiveIdentity,
  label: string,
): void {
  if (!GITHUB_ARTIFACT_ID_PATTERN.test(identity.artifactId)) {
    fail(`${label} artifact ID must be a non-zero decimal string`);
  }
  assertSha256(identity.archiveSha256, `${label} archive SHA-256`);
}

function assertReceiptArtifactIdentity(
  identity: ReceiptArtifactIdentity,
): void {
  assertArtifactArchiveIdentity(identity, "expected unsigned receipt artifact");
  assertSha256(identity.receiptSha256, "expected unsigned receipt SHA-256");
}

function parseReceipt(
  bytes: Uint8Array,
  label: string,
): Record<string, unknown> {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail(`${label} must be UTF-8 JSON`);
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return fail(`${label} must be valid JSON`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail(`${label} must be one JSON object`);
  }
  assertNoDuplicateTopLevelFields(source, label);
  return value as Record<string, unknown>;
}

function assertNoDuplicateTopLevelFields(source: string, label: string): void {
  const fields = new Set<string>();
  let depth = 0;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{" || character === "[") {
      depth += 1;
      continue;
    }
    if (character === "}" || character === "]") {
      depth -= 1;
      continue;
    }
    if (character !== '"') continue;

    const stringStart = index;
    index += 1;
    for (; index < source.length; index += 1) {
      if (source[index] === "\\") {
        index += 1;
        continue;
      }
      if (source[index] === '"') break;
    }
    if (depth !== 1) continue;

    let next = index + 1;
    while (/\s/.test(source[next] ?? "")) next += 1;
    if (source[next] !== ":") continue;

    const field = JSON.parse(source.slice(stringStart, index + 1)) as string;
    if (fields.has(field)) {
      fail(`${label} must not contain duplicate fields`);
    }
    fields.add(field);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(`${label} fields must exactly match the receipt schema`);
  }
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) fail(`${label} mismatch`);
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail(`${label} must be one canonical lowercase SHA-256 digest`);
  }
}

function assertPositiveSafeInteger(
  value: unknown,
  label: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    fail(`${label} must be a positive safe integer`);
  }
}

function requireExactFiles(
  files: readonly ReceiptFile[],
  expectedNames: readonly string[],
  label: string,
): Map<string, ReceiptFile> {
  const actualNames = files.map(({ name }) => name).sort();
  const requiredNames = [...expectedNames].sort();
  if (
    actualNames.length !== requiredNames.length ||
    actualNames.some((name, index) => name !== requiredNames[index])
  ) {
    fail(`${label} must contain exactly: ${requiredNames.join(", ")}`);
  }
  return new Map(files.map((file) => [file.name, file]));
}

export function verifyUnsignedReceiptAndInput(
  receiptArtifactFiles: readonly ReceiptFile[],
  signingInputFiles: readonly ReceiptFile[],
  identity: ReceiptIdentity,
  expectedUnsignedArtifact: ArtifactArchiveIdentity,
): {
  receipt: UnsignedReceipt;
  receiptSha256: string;
  installerSha256: string;
} {
  assertIdentity(identity);
  assertArtifactArchiveIdentity(
    expectedUnsignedArtifact,
    "expected unsigned artifact",
  );
  const expectedInstaller = installerFilename(identity.forkVersion);
  const receiptFiles = requireExactFiles(
    receiptArtifactFiles,
    [UNSIGNED_RECEIPT_FILENAME],
    "unsigned receipt artifact",
  );
  const inputFiles = requireExactFiles(
    signingInputFiles,
    [expectedInstaller],
    "unsigned signing-input artifact",
  );
  const receiptFile = receiptFiles.get(UNSIGNED_RECEIPT_FILENAME)!;
  const installer = inputFiles.get(expectedInstaller)!;
  const raw = parseReceipt(receiptFile.bytes, "unsigned receipt");

  assertExactKeys(raw, UNSIGNED_RECEIPT_KEYS, "unsigned receipt");
  assertEqual(
    raw.schema_version,
    RECEIPT_SCHEMA_VERSION,
    "unsigned receipt schema_version",
  );
  assertEqual(
    raw.repository,
    identity.repository,
    "unsigned receipt repository",
  );
  assertEqual(
    raw.github_run_id,
    identity.githubRunId,
    "unsigned receipt github_run_id",
  );
  assertEqual(
    raw.candidate_sha,
    identity.candidateSha,
    "unsigned receipt candidate_sha",
  );
  assertEqual(
    raw.fork_version,
    identity.forkVersion,
    "unsigned receipt fork_version",
  );
  assertEqual(
    raw.unsigned_artifact_name,
    unsignedArtifactName(identity.forkVersion),
    "unsigned receipt unsigned_artifact_name",
  );
  assertEqual(
    raw.unsigned_artifact_id,
    expectedUnsignedArtifact.artifactId,
    "unsigned receipt unsigned_artifact_id",
  );
  assertSha256(
    raw.unsigned_artifact_archive_sha256,
    "unsigned receipt unsigned_artifact_archive_sha256",
  );
  assertEqual(
    raw.unsigned_artifact_archive_sha256,
    expectedUnsignedArtifact.archiveSha256,
    "unsigned receipt unsigned_artifact_archive_sha256",
  );
  assertEqual(
    raw.installer_filename,
    expectedInstaller,
    "unsigned receipt installer_filename",
  );
  assertPositiveSafeInteger(
    raw.installer_size_bytes,
    "unsigned receipt installer_size_bytes",
  );
  assertEqual(
    raw.installer_size_bytes,
    installer.bytes.byteLength,
    "unsigned receipt installer_size_bytes",
  );
  assertSha256(raw.installer_sha256, "unsigned receipt installer_sha256");
  const actualInstallerSha256 = sha256(installer.bytes);
  assertEqual(
    raw.installer_sha256,
    actualInstallerSha256,
    "unsigned receipt installer_sha256",
  );

  return {
    receipt: raw as unknown as UnsignedReceipt,
    receiptSha256: sha256(receiptFile.bytes),
    installerSha256: actualInstallerSha256,
  };
}

export function verifySigningReceiptAndArtifacts(
  receiptArtifactFiles: readonly ReceiptFile[],
  signedArtifactFiles: readonly ReceiptFile[],
  identity: ReceiptIdentity,
  expectedUnsignedReceipt: ReceiptArtifactIdentity,
  expectedSignedArtifact: ArtifactArchiveIdentity,
): SigningReceipt {
  assertIdentity(identity);
  assertReceiptArtifactIdentity(expectedUnsignedReceipt);
  assertArtifactArchiveIdentity(
    expectedSignedArtifact,
    "expected signed artifact",
  );
  const expectedInstaller = installerFilename(identity.forkVersion);
  const expectedSignature = `${expectedInstaller}.sig`;
  const receiptFiles = requireExactFiles(
    receiptArtifactFiles,
    [SIGNING_RECEIPT_FILENAME],
    "signing receipt artifact",
  );
  const signedFiles = requireExactFiles(
    signedArtifactFiles,
    [expectedInstaller, expectedSignature],
    "signed acceptance artifact",
  );
  const installer = signedFiles.get(expectedInstaller)!;
  const signature = signedFiles.get(expectedSignature)!;
  if (signature.bytes.byteLength === 0) {
    fail("signed acceptance signature must be non-empty");
  }
  const raw = parseReceipt(
    receiptFiles.get(SIGNING_RECEIPT_FILENAME)!.bytes,
    "signing receipt",
  );

  assertExactKeys(raw, SIGNING_RECEIPT_KEYS, "signing receipt");
  assertEqual(
    raw.schema_version,
    RECEIPT_SCHEMA_VERSION,
    "signing receipt schema_version",
  );
  assertEqual(
    raw.repository,
    identity.repository,
    "signing receipt repository",
  );
  assertEqual(
    raw.github_run_id,
    identity.githubRunId,
    "signing receipt github_run_id",
  );
  assertEqual(
    raw.candidate_sha,
    identity.candidateSha,
    "signing receipt candidate_sha",
  );
  assertEqual(
    raw.fork_version,
    identity.forkVersion,
    "signing receipt fork_version",
  );
  assertEqual(
    raw.installer_filename,
    expectedInstaller,
    "signing receipt installer_filename",
  );
  assertEqual(
    raw.signed_artifact_name,
    signedArtifactName(identity.forkVersion),
    "signing receipt signed_artifact_name",
  );
  assertEqual(
    raw.signed_artifact_id,
    expectedSignedArtifact.artifactId,
    "signing receipt signed_artifact_id",
  );
  assertSha256(
    raw.signed_artifact_archive_sha256,
    "signing receipt signed_artifact_archive_sha256",
  );
  assertEqual(
    raw.signed_artifact_archive_sha256,
    expectedSignedArtifact.archiveSha256,
    "signing receipt signed_artifact_archive_sha256",
  );
  assertEqual(
    raw.unsigned_receipt_artifact_name,
    unsignedReceiptArtifactName(identity.forkVersion),
    "signing receipt unsigned_receipt_artifact_name",
  );
  assertEqual(
    raw.unsigned_receipt_artifact_id,
    expectedUnsignedReceipt.artifactId,
    "signing receipt unsigned_receipt_artifact_id",
  );
  assertSha256(
    raw.unsigned_receipt_artifact_archive_sha256,
    "signing receipt unsigned_receipt_artifact_archive_sha256",
  );
  assertEqual(
    raw.unsigned_receipt_artifact_archive_sha256,
    expectedUnsignedReceipt.archiveSha256,
    "signing receipt unsigned_receipt_artifact_archive_sha256",
  );
  assertEqual(
    raw.unsigned_receipt_filename,
    UNSIGNED_RECEIPT_FILENAME,
    "signing receipt unsigned_receipt_filename",
  );
  assertSha256(
    raw.unsigned_receipt_sha256,
    "signing receipt unsigned_receipt_sha256",
  );
  assertEqual(
    raw.unsigned_receipt_sha256,
    expectedUnsignedReceipt.receiptSha256,
    "signing receipt unsigned_receipt_sha256",
  );
  assertSha256(
    raw.pre_sign_installer_sha256,
    "signing receipt pre_sign_installer_sha256",
  );
  assertSha256(
    raw.post_sign_installer_sha256,
    "signing receipt post_sign_installer_sha256",
  );
  if (raw.pre_sign_installer_sha256 !== raw.post_sign_installer_sha256) {
    fail("signing receipt pre/post installer SHA-256 mismatch");
  }
  const actualInstallerSha256 = sha256(installer.bytes);
  assertEqual(
    raw.pre_sign_installer_sha256,
    actualInstallerSha256,
    "signing receipt pre_sign_installer_sha256",
  );
  assertEqual(
    raw.post_sign_installer_sha256,
    actualInstallerSha256,
    "signing receipt post_sign_installer_sha256",
  );
  assertPositiveSafeInteger(
    raw.installer_size_bytes,
    "signing receipt installer_size_bytes",
  );
  assertEqual(
    raw.installer_size_bytes,
    installer.bytes.byteLength,
    "signing receipt installer_size_bytes",
  );
  assertEqual(
    raw.signature_filename,
    expectedSignature,
    "signing receipt signature_filename",
  );
  assertSha256(raw.signature_sha256, "signing receipt signature_sha256");
  assertEqual(
    raw.signature_sha256,
    sha256(signature.bytes),
    "signing receipt signature_sha256",
  );
  assertEqual(raw.byte_invariance, true, "signing receipt byte_invariance");
  assertEqual(
    raw.cryptographic_signature_verified,
    true,
    "signing receipt cryptographic_signature_verified",
  );

  return raw as unknown as SigningReceipt;
}
