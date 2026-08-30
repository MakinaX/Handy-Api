// Portable installs can't self-update in place (no installer, and Windows won't
// let a running exe replace itself). Instead of dumping the user on the releases
// page to hand-pick one of ~27 assets, deep-link the NSIS setup.exe for their
// platform and architecture.
//
// The updater manifest (`Update.rawJson`) proposes the versioned URL, but the
// portable path accepts it only when repository, tag, product filename, target,
// query, and fragment match this release contract exactly.

const PORTABLE_RELEASES_BASE = "https://github.com/MakinaX/Handy-Api/releases";
export const PORTABLE_RELEASES_URL = `${PORTABLE_RELEASES_BASE}/latest`;

const FORK_VERSION_PATTERN = /^\d+\.\d+\.\d+-api\.\d+$/;
const WINDOWS_BUNDLE_ARCH: Record<string, string> = {
  x86_64: "x64",
  aarch64: "arm64",
};

/**
 * Pick the NSIS installer URL for the running target out of the update manifest.
 * Falls back to the generic releases page whenever there is no matching entry —
 * e.g. a portable install on a platform Handy ships no NSIS bundle for.
 *
 * @param rawJson `Update.rawJson`, the deserialized `latest.json` manifest
 * @param platformName value from `@tauri-apps/plugin-os` `platform()`
 * @param archName value from `@tauri-apps/plugin-os` `arch()` ("x86_64", "aarch64")
 */
export function resolvePortableInstallerUrl(
  rawJson: Record<string, unknown> | undefined,
  platformName: string,
  archName: string,
): string {
  // NSIS is a Windows-only bundle; nothing else has an installer to link to.
  if (platformName !== "windows") return PORTABLE_RELEASES_URL;

  const platforms = rawJson?.platforms;
  if (!platforms || typeof platforms !== "object") return PORTABLE_RELEASES_URL;

  const version = rawJson.version;
  if (typeof version !== "string" || !FORK_VERSION_PATTERN.test(version)) {
    return PORTABLE_RELEASES_URL;
  }

  const bundleArch = WINDOWS_BUNDLE_ARCH[archName];
  if (!bundleArch) return PORTABLE_RELEASES_URL;

  const entry = (platforms as Record<string, unknown>)[
    `windows-${archName}-nsis`
  ];
  if (!entry || typeof entry !== "object") return PORTABLE_RELEASES_URL;

  const url = (entry as Record<string, unknown>).url;
  const expectedUrl =
    `${PORTABLE_RELEASES_BASE}/download/v${version}/` +
    `Handy.API_${version}_${bundleArch}-setup.exe`;

  // `latest.json` is not itself authenticated. The normal Tauri updater checks
  // the installer signature, but the portable path opens a browser download.
  // Require the one exact HTTPS fork/tag/product artifact before deep-linking;
  // any foreign host, repository, tag, filename, query, or fragment fails shut
  // to the known fork release page.
  return typeof url === "string" && url === expectedUrl
    ? url
    : PORTABLE_RELEASES_URL;
}
