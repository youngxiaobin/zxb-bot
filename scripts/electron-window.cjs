const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

app.disableHardwareAcceleration();

const url = process.env.PA_DESKTOP_URL;
const shot =
  process.env.PA_ELECTRON_SHOT ??
  path.join(process.cwd(), "artifacts", "electron-window.png");
if (!url) {
  process.stderr.write("缺少 PA_DESKTOP_URL\n");
  process.exit(2);
}

app
  .whenReady()
  .then(async () => {
    const win = new BrowserWindow({
      width: 1200,
      height: 800,
      show: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.webContents.on("did-fail-load", (_event, code, description) => {
      process.stderr.write(`did-fail-load ${code} ${description}\n`);
    });
    await win.loadURL(url);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const title = win.webContents.getTitle();
    process.stdout.write(`electron-title ${title}\n`);
    fs.mkdirSync(require("node:path").dirname(shot), { recursive: true });
    const png = (await win.capturePage()).toPNG();
    if (png.length < 1000) {
      process.stderr.write(`electron-shot empty bytes=${png.length}\n`);
      app.exit(1);
      return;
    }
    fs.writeFileSync(shot, png);
    process.stdout.write(`electron-shot ${shot} bytes=${png.length}\n`);
    app.exit(0);
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    app.exit(1);
  });

setTimeout(() => {
  process.stderr.write("electron-window 超时\n");
  app.exit(1);
}, 20000).unref?.();
