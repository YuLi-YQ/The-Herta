/**
 * Release gate: refuse to build a RELEASE installer that would come out
 * unsigned (audit 2026-08-05, S6).
 *
 * WHY THIS EXISTS. electron-builder does not fail when signing credentials
 * are missing or malformed — it logs "skipped macOS application code signing"
 * or "signing is not configured", exits 0, and produces an installer that
 * looks exactly like a signed one until a user's machine rejects it. The yml
 * carried the intent ("The RELEASE pipeline must flip this to true") but no
 * pipeline existed to flip anything, and `pnpm dist` had no assertion at all.
 * A truncated base64, a wrong CSC_KEY_PASSWORD, or a secret that simply is
 * not exported in that shell would ship an unsigned build to the update feed.
 *
 * Two failure modes this closes:
 *   1. silently-unsigned release artifacts;
 *   2. WORSE — an unsigned build shipped while `win.publisherName` is set:
 *      electron-updater then verifies the downloaded installer's Authenticode
 *      subject and REJECTS it, so every existing install stops updating and
 *      the fix cannot be delivered by the updater itself.
 *
 *   node scripts/check-signing-env.mjs win|mac
 *
 * Checks presence and basic shape only — it cannot verify a certificate is
 * valid, which is what the post-build verification in the release workflow is
 * for.
 */
import { existsSync } from "node:fs";

const target = process.argv[2];
if (target !== "win" && target !== "mac") {
  console.error("usage: check-signing-env.mjs win|mac");
  process.exit(2);
}

const problems = [];
const note = (...lines) => problems.push(lines);

/** A credential that is present but obviously truncated is worse than absent:
 *  it fails deep inside the signer with an opaque message. */
function checkCscLink(value) {
  if (value.startsWith("/") || value.includes(":\\") || value.startsWith(".")) {
    if (!existsSync(value)) {
      note(
        `CSC_LINK points at a file that does not exist: ${value}`,
        "Either fix the path or pass the certificate as base64 instead.",
      );
    }
    return;
  }
  // Base64 form. A real .p12 is comfortably over 1KB encoded; anything much
  // smaller is a truncated secret, which is the classic CI paste error.
  const compact = value.replace(/\s/g, "");
  if (compact.length < 800) {
    note(
      `CSC_LINK looks truncated (${compact.length} base64 chars)`,
      "A Developer ID / OV certificate is normally >1000 chars once encoded.",
      "Re-copy the secret — a partial paste fails deep inside the signer.",
    );
  }
  if (!/^[A-Za-z0-9+/=]+$/.test(compact)) {
    note(
      "CSC_LINK is neither an existing file path nor valid base64",
      "Expected either a path to the .p12/.pfx or its base64 contents.",
    );
  }
}

const env = process.env;

if (env.CSC_LINK === undefined || env.CSC_LINK === "") {
  note(
    "CSC_LINK is not set — the build would be UNSIGNED",
    target === "mac"
      ? "Set it to the base64 of your Developer ID Application .p12."
      : "Set it to the base64 of your code-signing .pfx (or a path to it).",
  );
} else {
  checkCscLink(env.CSC_LINK);
}

if (env.CSC_KEY_PASSWORD === undefined || env.CSC_KEY_PASSWORD === "") {
  note("CSC_KEY_PASSWORD is not set — the certificate cannot be unlocked");
}

if (target === "mac") {
  // Notarization credentials: either the App Store Connect API key (preferred
  // for CI — no Apple ID, no app-specific password to rotate) or the Apple ID
  // triple. Missing notarization is not "unsigned", but it still means
  // Gatekeeper blocks the download on first launch.
  const hasApiKey =
    env.APPLE_API_KEY !== undefined &&
    env.APPLE_API_KEY_ID !== undefined &&
    env.APPLE_API_ISSUER !== undefined;
  const hasAppleId =
    env.APPLE_ID !== undefined &&
    env.APPLE_APP_SPECIFIC_PASSWORD !== undefined &&
    env.APPLE_TEAM_ID !== undefined;
  if (!hasApiKey && !hasAppleId) {
    note(
      "no notarization credentials — Gatekeeper will block the download",
      "Set either APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER (preferred),",
      "or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID.",
    );
  }
  if (hasApiKey && !existsSync(env.APPLE_API_KEY)) {
    note(
      `APPLE_API_KEY points at a missing file: ${env.APPLE_API_KEY}`,
      "It must be a path to the AuthKey_XXXX.p8 downloaded from App Store Connect.",
    );
  }
}

if (problems.length > 0) {
  console.error(`\n[signing] REFUSING to build a ${target} RELEASE:\n`);
  for (const lines of problems) {
    console.error(`  - ${lines[0]}`);
    for (const l of lines.slice(1)) console.error(`      ${l}`);
  }
  console.error(
    "\n  This gate exists because electron-builder does NOT fail on missing",
  );
  console.error(
    "  credentials — it would exit 0 and hand you an unsigned installer.",
  );
  console.error("  For an intentionally unsigned build, use `pnpm dist`.\n");
  process.exit(1);
}

console.log(`[signing] ${target}: credentials present`);
