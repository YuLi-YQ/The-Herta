/**
 * Fetch the display face (R76): Noto Serif SC SemiBold (SIL OFL 1.1), subset to
 * exactly the characters of the fixed lines it sets — the persona headlines
 * and the brand — so it costs tens of kilobytes, not the megabytes a CJK face
 * weighs. Google Fonts' css2 API cuts the subset (`text=`); the script records
 * the lines, the characters, the bytes and the SHA-256 beside the file, and
 * fetches the licence the font ships under.
 *
 *   node packages/gui/scripts/fetch-display-font.mjs
 *
 * Change a line below only together with the component that shows it, then
 * re-run: display-font.test.ts fails while a shown line has a character the
 * subset lacks.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const GUI = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FONTS = join(GUI, "src", "renderer", "assets", "fonts");
const LICENCE = join(GUI, "resources", "licenses", "NotoSerifSC-OFL.txt");

export const DISPLAY_LINES = [
  "把难题拿来，别让我无聊。",
  "这次，有什么有趣的事？",
  "黑塔的会客室",
  "The Herta",
  "THE HERTA / WORKBENCH",
];
const FAMILY = "Noto Serif SC";
const WEIGHT = 600;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

const chars = [...new Set(DISPLAY_LINES.join(""))].sort().join("");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function get(url) {
  const response = await fetch(url, { headers: { "User-Agent": UA } });
  if (!response.ok) throw new Error(`${response.status} for ${url}`);
  return response;
}

const css = await (
  await get(
    `https://fonts.googleapis.com/css2?family=${encodeURIComponent(FAMILY)}:wght@${WEIGHT}&text=${encodeURIComponent(chars)}`,
  )
).text();
const urls = [...css.matchAll(/url\((https:[^)]+)\) format\('woff2'\)/g)].map((m) => m[1]);
if (urls.length !== 1) throw new Error(`expected one woff2 subset, got ${urls.length}`);
const font = Buffer.from(await (await get(urls[0])).arrayBuffer());
const licence = Buffer.from(
  await (
    await get("https://raw.githubusercontent.com/google/fonts/main/ofl/notoserifsc/OFL.txt")
  ).arrayBuffer(),
);
mkdirSync(FONTS, { recursive: true });
writeFileSync(join(FONTS, "herta-display.woff2"), font);
writeFileSync(LICENCE, licence);
const manifest = {
  family: FAMILY,
  weight: WEIGHT,
  licence: "SIL Open Font License 1.1 (resources/licenses/NotoSerifSC-OFL.txt)",
  source: "Google Fonts css2 API, text= subset",
  lines: DISPLAY_LINES,
  chars,
  bytes: font.length,
  sha256: sha256(font),
  licenceSha256: sha256(licence),
};
writeFileSync(join(FONTS, "herta-display.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ chars: chars.length, bytes: font.length, sha256: manifest.sha256 }));
