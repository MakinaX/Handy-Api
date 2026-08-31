// Standalone assert check (no JS unit-test runner in this repo). Run with:
//   bun scripts/handy-api-receipt-contract.test.ts
import assert from "node:assert";
import {
  type ArtifactArchiveIdentity,
  HANDY_API_REPOSITORY,
  installerFilename,
  RECEIPT_SCHEMA_VERSION,
  type ReceiptArtifactIdentity,
  type ReceiptFile,
  type ReceiptIdentity,
  sha256,
  signedArtifactName,
  SIGNING_RECEIPT_FILENAME,
  UNSIGNED_RECEIPT_FILENAME,
  unsignedArtifactName,
  unsignedReceiptArtifactName,
  verifySigningReceiptAndArtifacts as verifySigningReceiptAndArtifactsContract,
  verifyUnsignedReceiptAndInput,
} from "./handy-api-receipt-contract.ts";

const encoder = new TextEncoder();
const identity: ReceiptIdentity = {
  repository: HANDY_API_REPOSITORY,
  githubRunId: "33308322091",
  candidateSha: "62c4947a36d3774527042da2776ff66d047002cd",
  forkVersion: "0.9.6-api.1",
};
const unsignedArtifact: ArtifactArchiveIdentity = {
  artifactId: "4100000001",
  archiveSha256: sha256(encoder.encode("unsigned artifact archive bytes")),
};
const unsignedReceiptArtifactArchive = {
  artifactId: "4100000002",
  archiveSha256: sha256(
    encoder.encode("unsigned receipt artifact archive bytes"),
  ),
};
const signedArtifactArchive: ArtifactArchiveIdentity = {
  artifactId: "4100000003",
  archiveSha256: sha256(encoder.encode("signed artifact archive bytes")),
};
const expectedInstaller = installerFilename(identity.forkVersion);
const installerBytes = encoder.encode("verified unsigned installer bytes");
const signatureBytes = encoder.encode("verified updater signature");

const NEGATIVE_CASES = {
  tamperedReceiptSha: "tampered receipt SHA",
  candidateMismatch: "receipt candidate SHA mismatch",
  oneByteInstallerChange: "one-byte installer change",
  prePostMismatch: "pre/post installer mismatch",
  foreignInstaller: "foreign installer",
  extraInstaller: "extra installer",
  tamperedUnsignedReceiptIdentity: "tampered unsigned receipt identity",
  missingSchemaField: "missing schema field",
  extraSchemaField: "extra schema field",
  duplicateSchemaField: "duplicate schema field",
  extraReceiptArtifactFile: "extra receipt artifact file",
  unsignedArtifactIdMismatch: "unsigned artifact ID mismatch",
  unsignedArtifactDigestMismatch: "unsigned artifact archive digest mismatch",
  unsignedReceiptArtifactIdMismatch: "unsigned receipt artifact ID mismatch",
  unsignedReceiptArtifactDigestMismatch:
    "unsigned receipt artifact archive digest mismatch",
  signedArtifactNameMismatch: "signed artifact name mismatch",
  signedArtifactIdMismatch: "signed artifact ID mismatch",
  signedArtifactDigestMismatch: "signed artifact archive digest mismatch",
  signedInstallerChange: "signed installer change",
  signatureChange: "signature change",
  falseByteInvariance: "false byte invariance",
  falseCryptographicVerification: "false cryptographic verification",
} as const;

function jsonFile(name: string, value: object): ReceiptFile {
  return { name, bytes: encoder.encode(`${JSON.stringify(value)}\n`) };
}

function rawJsonFile(name: string, source: string): ReceiptFile {
  return { name, bytes: encoder.encode(`${source}\n`) };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function differentDigest(digest: string): string {
  return `${digest[0] === "0" ? "1" : "0"}${digest.slice(1)}`;
}

function expectFailure(
  label: string,
  expectedMessage: RegExp,
  action: () => unknown,
): void {
  let failure: unknown;
  try {
    action();
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof Error, `${label}: expected hard failure`);
  assert.match(failure.message, expectedMessage, label);
}

function expectEveryMissingFieldFails(
  label: string,
  filename: string,
  receipt: Record<string, unknown>,
  verify: (file: ReceiptFile) => unknown,
): void {
  for (const key of Object.keys(receipt)) {
    const missingField = clone(receipt);
    delete missingField[key];
    expectFailure(
      `${label} ${NEGATIVE_CASES.missingSchemaField}: ${key}`,
      /fields must exactly match the receipt schema/,
      () => verify(jsonFile(filename, missingField)),
    );
  }
}

function verifySigningReceiptAndArtifacts(
  receiptArtifactFiles: readonly ReceiptFile[],
  signedArtifactFiles: readonly ReceiptFile[],
  receiptIdentity: ReceiptIdentity,
  expectedUnsignedReceipt: ReceiptArtifactIdentity,
  expectedSignedArtifact: ArtifactArchiveIdentity = signedArtifactArchive,
): unknown {
  return verifySigningReceiptAndArtifactsContract(
    receiptArtifactFiles,
    signedArtifactFiles,
    receiptIdentity,
    expectedUnsignedReceipt,
    expectedSignedArtifact,
  );
}

const unsignedReceipt = {
  schema_version: RECEIPT_SCHEMA_VERSION,
  repository: identity.repository,
  github_run_id: identity.githubRunId,
  candidate_sha: identity.candidateSha,
  fork_version: identity.forkVersion,
  unsigned_artifact_name: unsignedArtifactName(identity.forkVersion),
  unsigned_artifact_id: unsignedArtifact.artifactId,
  unsigned_artifact_archive_sha256: unsignedArtifact.archiveSha256,
  installer_filename: expectedInstaller,
  installer_size_bytes: installerBytes.byteLength,
  installer_sha256: sha256(installerBytes),
};
const unsignedReceiptFile = jsonFile(
  UNSIGNED_RECEIPT_FILENAME,
  unsignedReceipt,
);
const signingInput = [{ name: expectedInstaller, bytes: installerBytes }];
const verifiedUnsigned = verifyUnsignedReceiptAndInput(
  [unsignedReceiptFile],
  signingInput,
  identity,
  unsignedArtifact,
);
const unsignedReceiptArtifact: ReceiptArtifactIdentity = {
  ...unsignedReceiptArtifactArchive,
  receiptSha256: verifiedUnsigned.receiptSha256,
};

const signingReceipt = {
  schema_version: RECEIPT_SCHEMA_VERSION,
  repository: identity.repository,
  github_run_id: identity.githubRunId,
  candidate_sha: identity.candidateSha,
  fork_version: identity.forkVersion,
  installer_filename: expectedInstaller,
  signed_artifact_name: signedArtifactName(identity.forkVersion),
  signed_artifact_id: signedArtifactArchive.artifactId,
  signed_artifact_archive_sha256: signedArtifactArchive.archiveSha256,
  unsigned_receipt_artifact_name: unsignedReceiptArtifactName(
    identity.forkVersion,
  ),
  unsigned_receipt_artifact_id: unsignedReceiptArtifact.artifactId,
  unsigned_receipt_artifact_archive_sha256:
    unsignedReceiptArtifact.archiveSha256,
  unsigned_receipt_filename: UNSIGNED_RECEIPT_FILENAME,
  unsigned_receipt_sha256: unsignedReceiptArtifact.receiptSha256,
  pre_sign_installer_sha256: verifiedUnsigned.installerSha256,
  post_sign_installer_sha256: verifiedUnsigned.installerSha256,
  installer_size_bytes: installerBytes.byteLength,
  signature_filename: `${expectedInstaller}.sig`,
  signature_sha256: sha256(signatureBytes),
  byte_invariance: true,
  cryptographic_signature_verified: true,
};
const signedArtifact = [
  { name: expectedInstaller, bytes: installerBytes },
  { name: `${expectedInstaller}.sig`, bytes: signatureBytes },
];
verifySigningReceiptAndArtifacts(
  [jsonFile(SIGNING_RECEIPT_FILENAME, signingReceipt)],
  signedArtifact,
  identity,
  unsignedReceiptArtifact,
  signedArtifactArchive,
);

const tamperedReceiptSha = clone(unsignedReceipt);
tamperedReceiptSha.installer_sha256 = differentDigest(
  tamperedReceiptSha.installer_sha256,
);
expectFailure(
  NEGATIVE_CASES.tamperedReceiptSha,
  /installer_sha256 mismatch/,
  () =>
    verifyUnsignedReceiptAndInput(
      [jsonFile(UNSIGNED_RECEIPT_FILENAME, tamperedReceiptSha)],
      signingInput,
      identity,
      unsignedArtifact,
    ),
);

const candidateMismatch = clone(unsignedReceipt);
candidateMismatch.candidate_sha = "a".repeat(40);
expectFailure(NEGATIVE_CASES.candidateMismatch, /candidate_sha mismatch/, () =>
  verifyUnsignedReceiptAndInput(
    [jsonFile(UNSIGNED_RECEIPT_FILENAME, candidateMismatch)],
    signingInput,
    identity,
    unsignedArtifact,
  ),
);

const oneByteChanged = Uint8Array.from(installerBytes);
oneByteChanged[0] ^= 1;
expectFailure(
  NEGATIVE_CASES.oneByteInstallerChange,
  /installer_sha256 mismatch/,
  () =>
    verifyUnsignedReceiptAndInput(
      [unsignedReceiptFile],
      [{ name: expectedInstaller, bytes: oneByteChanged }],
      identity,
      unsignedArtifact,
    ),
);

const prePostMismatch = clone(signingReceipt);
prePostMismatch.post_sign_installer_sha256 = differentDigest(
  prePostMismatch.post_sign_installer_sha256,
);
expectFailure(
  NEGATIVE_CASES.prePostMismatch,
  /pre\/post installer SHA-256 mismatch/,
  () =>
    verifySigningReceiptAndArtifacts(
      [jsonFile(SIGNING_RECEIPT_FILENAME, prePostMismatch)],
      signedArtifact,
      identity,
      unsignedReceiptArtifact,
    ),
);

expectFailure(
  NEGATIVE_CASES.foreignInstaller,
  /unsigned signing-input artifact/,
  () =>
    verifyUnsignedReceiptAndInput(
      [unsignedReceiptFile],
      [{ name: "Foreign_0.9.6-api.1_x64-setup.exe", bytes: installerBytes }],
      identity,
      unsignedArtifact,
    ),
);
expectFailure(
  NEGATIVE_CASES.extraInstaller,
  /unsigned signing-input artifact/,
  () =>
    verifyUnsignedReceiptAndInput(
      [unsignedReceiptFile],
      [
        ...signingInput,
        { name: "Foreign_0.9.6-api.1_x64-setup.exe", bytes: installerBytes },
      ],
      identity,
      unsignedArtifact,
    ),
);

const tamperedReceiptIdentity = clone(signingReceipt);
tamperedReceiptIdentity.unsigned_receipt_sha256 = differentDigest(
  tamperedReceiptIdentity.unsigned_receipt_sha256,
);
expectFailure(
  NEGATIVE_CASES.tamperedUnsignedReceiptIdentity,
  /unsigned_receipt_sha256 mismatch/,
  () =>
    verifySigningReceiptAndArtifacts(
      [jsonFile(SIGNING_RECEIPT_FILENAME, tamperedReceiptIdentity)],
      signedArtifact,
      identity,
      unsignedReceiptArtifact,
    ),
);

const unsignedArtifactIdMismatch = clone(unsignedReceipt);
unsignedArtifactIdMismatch.unsigned_artifact_id = "4100000999";
expectFailure(
  NEGATIVE_CASES.unsignedArtifactIdMismatch,
  /unsigned_artifact_id mismatch/,
  () =>
    verifyUnsignedReceiptAndInput(
      [jsonFile(UNSIGNED_RECEIPT_FILENAME, unsignedArtifactIdMismatch)],
      signingInput,
      identity,
      unsignedArtifact,
    ),
);
const unsignedArtifactDigestMismatch = clone(unsignedReceipt);
unsignedArtifactDigestMismatch.unsigned_artifact_archive_sha256 =
  differentDigest(
    unsignedArtifactDigestMismatch.unsigned_artifact_archive_sha256,
  );
expectFailure(
  NEGATIVE_CASES.unsignedArtifactDigestMismatch,
  /unsigned_artifact_archive_sha256 mismatch/,
  () =>
    verifyUnsignedReceiptAndInput(
      [jsonFile(UNSIGNED_RECEIPT_FILENAME, unsignedArtifactDigestMismatch)],
      signingInput,
      identity,
      unsignedArtifact,
    ),
);

const unsignedReceiptArtifactIdMismatch = clone(signingReceipt);
unsignedReceiptArtifactIdMismatch.unsigned_receipt_artifact_id = "4100000998";
expectFailure(
  NEGATIVE_CASES.unsignedReceiptArtifactIdMismatch,
  /unsigned_receipt_artifact_id mismatch/,
  () =>
    verifySigningReceiptAndArtifacts(
      [jsonFile(SIGNING_RECEIPT_FILENAME, unsignedReceiptArtifactIdMismatch)],
      signedArtifact,
      identity,
      unsignedReceiptArtifact,
    ),
);
const unsignedReceiptArtifactDigestMismatch = clone(signingReceipt);
unsignedReceiptArtifactDigestMismatch.unsigned_receipt_artifact_archive_sha256 =
  differentDigest(
    unsignedReceiptArtifactDigestMismatch.unsigned_receipt_artifact_archive_sha256,
  );
expectFailure(
  NEGATIVE_CASES.unsignedReceiptArtifactDigestMismatch,
  /unsigned_receipt_artifact_archive_sha256 mismatch/,
  () =>
    verifySigningReceiptAndArtifacts(
      [
        jsonFile(
          SIGNING_RECEIPT_FILENAME,
          unsignedReceiptArtifactDigestMismatch,
        ),
      ],
      signedArtifact,
      identity,
      unsignedReceiptArtifact,
    ),
);

const signedArtifactIdMismatch = clone(signingReceipt);
signedArtifactIdMismatch.signed_artifact_id = "4100000997";
expectFailure(
  NEGATIVE_CASES.signedArtifactIdMismatch,
  /signed_artifact_id mismatch/,
  () =>
    verifySigningReceiptAndArtifacts(
      [jsonFile(SIGNING_RECEIPT_FILENAME, signedArtifactIdMismatch)],
      signedArtifact,
      identity,
      unsignedReceiptArtifact,
    ),
);
const signedArtifactNameMismatch = clone(signingReceipt);
signedArtifactNameMismatch.signed_artifact_name =
  "handy-api-windows-x64-signed-foreign";
expectFailure(
  NEGATIVE_CASES.signedArtifactNameMismatch,
  /signed_artifact_name mismatch/,
  () =>
    verifySigningReceiptAndArtifacts(
      [jsonFile(SIGNING_RECEIPT_FILENAME, signedArtifactNameMismatch)],
      signedArtifact,
      identity,
      unsignedReceiptArtifact,
    ),
);
const signedArtifactDigestMismatch = clone(signingReceipt);
signedArtifactDigestMismatch.signed_artifact_archive_sha256 = differentDigest(
  signedArtifactDigestMismatch.signed_artifact_archive_sha256,
);
expectFailure(
  NEGATIVE_CASES.signedArtifactDigestMismatch,
  /signed_artifact_archive_sha256 mismatch/,
  () =>
    verifySigningReceiptAndArtifacts(
      [jsonFile(SIGNING_RECEIPT_FILENAME, signedArtifactDigestMismatch)],
      signedArtifact,
      identity,
      unsignedReceiptArtifact,
    ),
);

expectEveryMissingFieldFails(
  "unsigned receipt",
  UNSIGNED_RECEIPT_FILENAME,
  unsignedReceipt,
  (file) =>
    verifyUnsignedReceiptAndInput(
      [file],
      signingInput,
      identity,
      unsignedArtifact,
    ),
);
expectEveryMissingFieldFails(
  "signing receipt",
  SIGNING_RECEIPT_FILENAME,
  signingReceipt,
  (file) =>
    verifySigningReceiptAndArtifacts(
      [file],
      signedArtifact,
      identity,
      unsignedReceiptArtifact,
    ),
);

const extraUnsignedSchemaField = {
  ...unsignedReceipt,
  untrusted_note: "ignored?",
};
expectFailure(NEGATIVE_CASES.extraSchemaField, /exactly match/, () =>
  verifyUnsignedReceiptAndInput(
    [jsonFile(UNSIGNED_RECEIPT_FILENAME, extraUnsignedSchemaField)],
    signingInput,
    identity,
    unsignedArtifact,
  ),
);
const extraSigningSchemaField = {
  ...signingReceipt,
  untrusted_note: "ignored?",
};
expectFailure(NEGATIVE_CASES.extraSchemaField, /exactly match/, () =>
  verifySigningReceiptAndArtifacts(
    [jsonFile(SIGNING_RECEIPT_FILENAME, extraSigningSchemaField)],
    signedArtifact,
    identity,
    unsignedReceiptArtifact,
  ),
);

const unsignedReceiptJson = JSON.stringify(unsignedReceipt);
const duplicateUnsignedCandidateSha = unsignedReceiptJson.replace(
  `"candidate_sha":"${identity.candidateSha}"`,
  `"candidate_sha":"${"a".repeat(40)}","candidate_\\u0073ha":"${identity.candidateSha}"`,
);
assert.notEqual(
  duplicateUnsignedCandidateSha,
  unsignedReceiptJson,
  "duplicate unsigned receipt fixture was not created",
);
expectFailure(
  NEGATIVE_CASES.duplicateSchemaField,
  /must not contain duplicate fields/,
  () =>
    verifyUnsignedReceiptAndInput(
      [rawJsonFile(UNSIGNED_RECEIPT_FILENAME, duplicateUnsignedCandidateSha)],
      signingInput,
      identity,
      unsignedArtifact,
    ),
);
const signingReceiptJson = JSON.stringify(signingReceipt);
const duplicateSigningBoolean = signingReceiptJson.replace(
  '"byte_invariance":true',
  '"byte_invariance":false,"byte_invariance":true',
);
assert.notEqual(
  duplicateSigningBoolean,
  signingReceiptJson,
  "duplicate signing receipt fixture was not created",
);
expectFailure(
  NEGATIVE_CASES.duplicateSchemaField,
  /must not contain duplicate fields/,
  () =>
    verifySigningReceiptAndArtifacts(
      [rawJsonFile(SIGNING_RECEIPT_FILENAME, duplicateSigningBoolean)],
      signedArtifact,
      identity,
      unsignedReceiptArtifact,
    ),
);

const unsignedWrongTypes: ReadonlyArray<
  readonly [string, string, unknown, RegExp]
> = [
  ["schema_version", "schema_version", "1", /schema_version mismatch/],
  ["github_run_id", "github_run_id", 33308322091, /github_run_id mismatch/],
  ["candidate_sha", "candidate_sha", 62, /candidate_sha mismatch/],
  [
    "unsigned_artifact_id",
    "unsigned_artifact_id",
    4100000001,
    /unsigned_artifact_id mismatch/,
  ],
  [
    "unsigned_artifact_archive_sha256",
    "unsigned_artifact_archive_sha256",
    unsignedArtifact.archiveSha256.toUpperCase(),
    /canonical lowercase SHA-256/,
  ],
  [
    "installer_size_bytes",
    "installer_size_bytes",
    String(installerBytes.byteLength),
    /positive safe integer/,
  ],
  [
    "installer_sha256",
    "installer_sha256",
    unsignedReceipt.installer_sha256.toUpperCase(),
    /canonical lowercase SHA-256/,
  ],
];
for (const [label, field, value, expectedMessage] of unsignedWrongTypes) {
  const wrongTypeReceipt = {
    ...unsignedReceipt,
    [field]: value,
  };
  expectFailure(`unsigned receipt wrong type: ${label}`, expectedMessage, () =>
    verifyUnsignedReceiptAndInput(
      [jsonFile(UNSIGNED_RECEIPT_FILENAME, wrongTypeReceipt)],
      signingInput,
      identity,
      unsignedArtifact,
    ),
  );
}

const signingWrongTypes: ReadonlyArray<
  readonly [string, string, unknown, RegExp]
> = [
  [
    "signed_artifact_id",
    "signed_artifact_id",
    4100000003,
    /signed_artifact_id mismatch/,
  ],
  [
    "signed_artifact_archive_sha256",
    "signed_artifact_archive_sha256",
    signedArtifactArchive.archiveSha256.toUpperCase(),
    /canonical lowercase SHA-256/,
  ],
  [
    "unsigned_receipt_artifact_id",
    "unsigned_receipt_artifact_id",
    4100000002,
    /unsigned_receipt_artifact_id mismatch/,
  ],
  [
    "unsigned_receipt_artifact_archive_sha256",
    "unsigned_receipt_artifact_archive_sha256",
    unsignedReceiptArtifact.archiveSha256.toUpperCase(),
    /canonical lowercase SHA-256/,
  ],
  [
    "unsigned_receipt_sha256",
    "unsigned_receipt_sha256",
    42,
    /canonical lowercase SHA-256/,
  ],
  [
    "installer_size_bytes",
    "installer_size_bytes",
    String(installerBytes.byteLength),
    /positive safe integer/,
  ],
  ["byte_invariance", "byte_invariance", "true", /byte_invariance mismatch/],
  [
    "cryptographic_signature_verified",
    "cryptographic_signature_verified",
    1,
    /cryptographic_signature_verified mismatch/,
  ],
];
for (const [label, field, value, expectedMessage] of signingWrongTypes) {
  const wrongTypeReceipt = {
    ...signingReceipt,
    [field]: value,
  };
  expectFailure(`signing receipt wrong type: ${label}`, expectedMessage, () =>
    verifySigningReceiptAndArtifacts(
      [jsonFile(SIGNING_RECEIPT_FILENAME, wrongTypeReceipt)],
      signedArtifact,
      identity,
      unsignedReceiptArtifact,
    ),
  );
}

expectFailure(
  NEGATIVE_CASES.extraReceiptArtifactFile,
  /unsigned receipt artifact/,
  () =>
    verifyUnsignedReceiptAndInput(
      [unsignedReceiptFile, jsonFile("foreign-receipt.json", unsignedReceipt)],
      signingInput,
      identity,
      unsignedArtifact,
    ),
);
expectFailure(
  NEGATIVE_CASES.extraReceiptArtifactFile,
  /signing receipt artifact/,
  () =>
    verifySigningReceiptAndArtifacts(
      [
        jsonFile(SIGNING_RECEIPT_FILENAME, signingReceipt),
        jsonFile("foreign-receipt.json", signingReceipt),
      ],
      signedArtifact,
      identity,
      unsignedReceiptArtifact,
    ),
);

expectFailure(
  NEGATIVE_CASES.foreignInstaller,
  /signed acceptance artifact/,
  () =>
    verifySigningReceiptAndArtifacts(
      [jsonFile(SIGNING_RECEIPT_FILENAME, signingReceipt)],
      [
        signedArtifact[1],
        { name: "Foreign_0.9.6-api.1_x64-setup.exe", bytes: installerBytes },
      ],
      identity,
      unsignedReceiptArtifact,
    ),
);
expectFailure(NEGATIVE_CASES.extraInstaller, /signed acceptance artifact/, () =>
  verifySigningReceiptAndArtifacts(
    [jsonFile(SIGNING_RECEIPT_FILENAME, signingReceipt)],
    [
      ...signedArtifact,
      { name: "Foreign_0.9.6-api.1_x64-setup.exe", bytes: installerBytes },
    ],
    identity,
    unsignedReceiptArtifact,
  ),
);
expectFailure(
  NEGATIVE_CASES.signedInstallerChange,
  /pre_sign_installer_sha256 mismatch/,
  () =>
    verifySigningReceiptAndArtifacts(
      [jsonFile(SIGNING_RECEIPT_FILENAME, signingReceipt)],
      [{ name: expectedInstaller, bytes: oneByteChanged }, signedArtifact[1]],
      identity,
      unsignedReceiptArtifact,
    ),
);
const changedSignature = Uint8Array.from(signatureBytes);
changedSignature[0] ^= 1;
expectFailure(NEGATIVE_CASES.signatureChange, /signature_sha256 mismatch/, () =>
  verifySigningReceiptAndArtifacts(
    [jsonFile(SIGNING_RECEIPT_FILENAME, signingReceipt)],
    [
      signedArtifact[0],
      { name: `${expectedInstaller}.sig`, bytes: changedSignature },
    ],
    identity,
    unsignedReceiptArtifact,
  ),
);

const falseByteInvariance = clone(signingReceipt);
falseByteInvariance.byte_invariance = false;
expectFailure(
  NEGATIVE_CASES.falseByteInvariance,
  /byte_invariance mismatch/,
  () =>
    verifySigningReceiptAndArtifacts(
      [jsonFile(SIGNING_RECEIPT_FILENAME, falseByteInvariance)],
      signedArtifact,
      identity,
      unsignedReceiptArtifact,
    ),
);
const falseCryptographicVerification = clone(signingReceipt);
falseCryptographicVerification.cryptographic_signature_verified = false;
expectFailure(
  NEGATIVE_CASES.falseCryptographicVerification,
  /cryptographic_signature_verified mismatch/,
  () =>
    verifySigningReceiptAndArtifacts(
      [jsonFile(SIGNING_RECEIPT_FILENAME, falseCryptographicVerification)],
      signedArtifact,
      identity,
      unsignedReceiptArtifact,
    ),
);

expectFailure("invalid expected unsigned artifact ID", /artifact ID/, () =>
  verifyUnsignedReceiptAndInput([unsignedReceiptFile], signingInput, identity, {
    ...unsignedArtifact,
    artifactId: "0",
  }),
);
expectFailure(
  "invalid expected unsigned artifact archive digest",
  /archive SHA-256/,
  () =>
    verifyUnsignedReceiptAndInput(
      [unsignedReceiptFile],
      signingInput,
      identity,
      {
        ...unsignedArtifact,
        archiveSha256: unsignedArtifact.archiveSha256.toUpperCase(),
      },
    ),
);
expectFailure(
  "invalid expected unsigned receipt artifact ID",
  /artifact ID/,
  () =>
    verifySigningReceiptAndArtifacts(
      [jsonFile(SIGNING_RECEIPT_FILENAME, signingReceipt)],
      signedArtifact,
      identity,
      { ...unsignedReceiptArtifact, artifactId: "not-an-id" },
    ),
);
expectFailure(
  "invalid expected unsigned receipt digest",
  /receipt SHA-256/,
  () =>
    verifySigningReceiptAndArtifacts(
      [jsonFile(SIGNING_RECEIPT_FILENAME, signingReceipt)],
      signedArtifact,
      identity,
      { ...unsignedReceiptArtifact, receiptSha256: "f".repeat(63) },
    ),
);
expectFailure("invalid expected signed artifact ID", /artifact ID/, () =>
  verifySigningReceiptAndArtifacts(
    [jsonFile(SIGNING_RECEIPT_FILENAME, signingReceipt)],
    signedArtifact,
    identity,
    unsignedReceiptArtifact,
    { ...signedArtifactArchive, artifactId: "0" },
  ),
);
expectFailure(
  "invalid expected signed artifact digest",
  /archive SHA-256/,
  () =>
    verifySigningReceiptAndArtifacts(
      [jsonFile(SIGNING_RECEIPT_FILENAME, signingReceipt)],
      signedArtifact,
      identity,
      unsignedReceiptArtifact,
      {
        ...signedArtifactArchive,
        archiveSha256: signedArtifactArchive.archiveSha256.toUpperCase(),
      },
    ),
);

console.log("handy-api receipt contract: all assertions passed");
