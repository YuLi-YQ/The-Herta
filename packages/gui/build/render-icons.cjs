/**
 * Render the app mark (R75) from build/icon.svg and build/icon-small.svg:
 *   build/icon.png               1024 px (electron-builder, mac/linux)
 *   resources/herta-icon.png      256 px (window and tray)
 *   build/icon.ico                16–256 px, PNG frames; 16/24/32 use the small variant
 *   src/renderer/assets/atelier-mark.svg   a copy of icon.svg
 * Uses Electron's own Chromium, offscreen and transparent, so the gradients
 * and curves render exactly as the SVG says. Run from packages/gui:
 *   node_modules/electron/dist/electron.exe build/render-icons.cjs [--preview <dir>]
 * With --preview, only writes 1024/256/48/32/16 PNGs into <dir>.
 */
const { app, BrowserWindow } = require("electron");
const { copyFileSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");

const BUILD = __dirname;
const GUI = resolve(BUILD, "..");
const preview = process.argv.includes("--preview")
  ? resolve(process.argv[process.argv.indexOf("--preview") + 1])
  : null;

app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.disableHardwareAcceleration();

/** One offscreen window, reused: each render sizes it, swaps the SVG in and
 *  captures it (a fresh window per size failed to load intermittently). */
let win = null;
async function render(svgFile, size) {
  const svg = readFileSync(join(BUILD, svgFile), "utf8").replace(
    "<svg ",
    `<svg width="${size}" height="${size}" `,
  );
  if (!win) {
    win = new BrowserWindow({
      width: 1024,
      height: 1024,
      useContentSize: true,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      webPreferences: { offscreen: true },
    });
    await win.loadURL(
      "data:text/html;charset=utf-8,<!doctype html><html><body style='margin:0;background:transparent;overflow:hidden'></body></html>",
    );
  }
  win.setContentSize(size, size);
  await win.webContents.executeJavaScript(
    `document.body.innerHTML = ${JSON.stringify(svg)}; new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))`,
  );
  await new Promise((done) => setTimeout(done, 120));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  const exact =
    image.getSize().width === size
      ? image
      : image.resize({ width: size, height: size, quality: "best" });
  return exact.toPNG();
}

function ico(frames) {
  const header = Buffer.alloc(6 + 16 * frames.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach(({ size, png }, index) => {
    const at = 6 + 16 * index;
    header.writeUInt8(size === 256 ? 0 : size, at);
    header.writeUInt8(size === 256 ? 0 : size, at + 1);
    header.writeUInt8(0, at + 2);
    header.writeUInt8(0, at + 3);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(png.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...frames.map((f) => f.png)]);
}

app.whenReady().then(async () => {
  try {
    if (preview) {
      mkdirSync(preview, { recursive: true });
      for (const [file, size] of [["icon.svg", 1024], ["icon.svg", 256], ["icon.svg", 48], ["icon-small.svg", 32], ["icon-small.svg", 16]])
        writeFileSync(join(preview, `${file.replace(".svg", "")}-${size}.png`), await render(file, size));
    } else {
      writeFileSync(join(BUILD, "icon.png"), await render("icon.svg", 1024));
      writeFileSync(join(GUI, "resources", "herta-icon.png"), await render("icon.svg", 256));
      const frames = [];
      for (const size of [16, 24, 32, 48, 64, 128, 256])
        frames.push({ size, png: await render(size <= 32 ? "icon-small.svg" : "icon.svg", size) });
      writeFileSync(join(BUILD, "icon.ico"), ico(frames));
      copyFileSync(join(BUILD, "icon.svg"), join(GUI, "src", "renderer", "assets", "atelier-mark.svg"));
    }
    console.log("icons rendered");
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
