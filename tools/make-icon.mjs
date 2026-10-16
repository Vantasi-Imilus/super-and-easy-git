// Renders assets/icon.svg into PNGs using Electron's own rasterizer (there is
// no other SVG renderer guaranteed to exist on a bare machine).
//
//   npx electron tools/make-icon.mjs
//
// Outputs:
//   assets/icon.png       1024x1024, used by BrowserWindow and electron-builder
//   build/icon.png        same image (electron-builder's conventional location)
//   build/icons/*.png     one file per size, for eyeballing small sizes
import { app, BrowserWindow } from 'electron';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SIZES = [1024, 256, 128, 64, 48, 32, 16];

// Hidden-window capture is more reliable with software rasterization.
app.disableHardwareAcceleration();

async function captureWithRetry(win, attempts = 4) {
  let lastError = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const image = await win.webContents.capturePage();
      const png = image.toPNG();
      if (png.length > 0) return png;
      lastError = new Error('捕获结果为空');
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * (i + 1)));
  }
  throw lastError;
}

async function renderSize(svgDataUrl, size) {
  const win = new BrowserWindow({
    width: size,
    height: size,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { sandbox: true, contextIsolation: true, offscreen: false },
  });
  const html = `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">
    <img src="${svgDataUrl}" width="${size}" height="${size}" style="display:block">
  </body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  // Give the compositor a beat to paint before capturing.
  await new Promise((resolve) => setTimeout(resolve, 150));
  const png = await captureWithRetry(win);
  win.destroy();
  return png;
}

async function main() {
  const svg = await fsp.readFile(path.join(ROOT, 'assets', 'icon.svg'), 'utf8');
  const svgDataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

  const outDir = path.join(ROOT, 'build', 'icons');
  await fsp.mkdir(outDir, { recursive: true });

  for (const size of SIZES) {
    const png = await renderSize(svgDataUrl, size);
    await fsp.writeFile(path.join(outDir, `icon-${size}.png`), png);
    if (size === 1024) {
      await fsp.mkdir(path.join(ROOT, 'assets'), { recursive: true });
      await fsp.mkdir(path.join(ROOT, 'build'), { recursive: true });
      await fsp.writeFile(path.join(ROOT, 'assets', 'icon.png'), png);
      await fsp.writeFile(path.join(ROOT, 'build', 'icon.png'), png);
    }
    console.log(`icon-${size}.png: ${png.length} bytes${size === 1024 ? ' (also assets/icon.png, build/icon.png)' : ''}`);
  }
  console.log('图标生成完成');
}

// Each render destroys its window; without this Electron would treat the app as
// finished and quit after the first size.
app.on('window-all-closed', () => {});

app.whenReady().then(() => {
  main()
    .then(() => {
      console.log('图标生成完成');
      app.quit();
    })
    .catch((err) => {
      console.error(`图标生成失败：${err.stack}`);
      app.exit(1);
    });
});
