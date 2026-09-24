const { app, BrowserWindow, shell, ipcMain, dialog } = require('electron');
const path = require('path');
const ffmpegOps = require('./ffmpeg-ops');
const keystore = require('./keystore');
const ffmpegRender = require('./ffmpeg-render');

const VIDEO_FILTERS = [
  { name: 'Video files', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi'] },
  { name: 'All files', extensions: ['*'] },
];

let mainWin = null;
function createWindow() {
  const win = mainWin = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1040,
    minHeight: 700,
    title: 'Video Editor',
    backgroundColor: '#f4f7fc',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // WebCodecs (used by the "Fast render" button) needs a secure context;
      // file:// loads already count as secure in Electron, so no flags needed here.
    },
  });

  win.loadFile(path.join(__dirname, 'editor.html'));

  // Open any target="_blank" links in the system browser instead of a new Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ---- IPC bridge for window.vem (see preload.js) --------------------------
ipcMain.handle('vem:pick-video', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Choose a video',
    properties: ['openFile'],
    filters: VIDEO_FILTERS,
  });
  if (canceled || !filePaths[0]) return null;
  return filePaths[0];
});

ipcMain.handle('vem:probe', async (_e, filePath) => {
  try {
    return { ok: true, data: await ffmpegOps.probe(filePath) };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('vem:detect-scenes', async (_e, filePath, sensitivity) => {
  try {
    return { ok: true, data: await ffmpegOps.detectScenes(filePath, sensitivity) };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('vem:make-proxy', async (_e, filePath) => {
  try {
    return { ok: true, data: await ffmpegOps.makeProxy(filePath) };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

const MEDIA_FILTERS = [
  { name: 'Video or image', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'png', 'jpg', 'jpeg', 'webp'] },
];
ipcMain.handle('vem:pick-media', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Choose a replacement clip or image',
    properties: ['openFile'],
    filters: MEDIA_FILTERS,
  });
  if (canceled || !filePaths[0]) return null;
  return filePaths[0];
});

ipcMain.handle('vem:pick-save-path', async (_e, defaultName) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWin, {
    title: 'Save rendered video',
    defaultPath: String(defaultName || 'rendered.mp4'),
    filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
  });
  return canceled ? null : filePath;
});

// The renderer asks for the exact output geometry so it can draw the
// rounded-corner mask and border PNGs at the right pixel size.
ipcMain.handle('vem:get-geometry', (_e, args) => ffmpegRender.computeGeometry(args));

let activeRender = null;
ipcMain.handle('vem:render', async (e, spec) => {
  if (activeRender) return { ok: false, error: 'A render is already running.' };
  const ctl = { cancelled: false, proc: null };
  activeRender = ctl;
  try {
    const data = await ffmpegRender.render(
      spec,
      (p) => { if (!e.sender.isDestroyed()) e.sender.send('vem:render-progress', p); },
      ctl
    );
    return { ok: true, data };
  } catch (err) {
    const msg = String(err.message || err);
    return { ok: false, cancelled: msg === 'cancelled', error: msg };
  } finally {
    activeRender = null;
  }
});
ipcMain.handle('vem:cancel-render', () => {
  if (activeRender) {
    activeRender.cancelled = true;
    if (activeRender.proc) { try { activeRender.proc.kill('SIGKILL'); } catch (_) {} }
  }
  return true;
});

ipcMain.handle('vem:get-key', (_e, name) => keystore.getKey(name));
ipcMain.handle('vem:set-key', (_e, name, value) => keystore.setKey(name, value));

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
