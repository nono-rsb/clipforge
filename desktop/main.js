// ClipForge en application PC (Electron) : sa propre fenêtre, un installateur et les mises à jour automatiques.
// Le serveur local (server.js) tourne dans l'app ; la page est la même que dans le navigateur.
const { app, BrowserWindow, Menu, ipcMain, session, shell } = require('electron');
const path = require('path');
const fs = require('fs');

if (!app.requestSingleInstanceLock()) app.quit();
else run();

function run() {
  process.env.CLIPFORGE_DATA = app.getPath('userData');
  process.env.NO_OPEN = '1';
  const SAVE = path.join(app.getPath('downloads'), 'ClipForge');
  const STATE = path.join(app.getPath('userData'), 'fenetre.json');
  let win = null;

  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  // Port fixe : l'adresse ne change pas, donc les réglages et projets enregistrés restent.
  async function startServer() {
    // Dans l'app installée server.js est à côté ; en développement il est à la racine du dépôt.
    const { start } = require(fs.existsSync(path.join(__dirname, 'server.js')) ? './server.js' : '../server.js');
    for (let port = 5174; port < 5184; port++) {
      try { return await start(port); } catch (e) { if (e.code !== 'EADDRINUSE') throw e; }
    }
    return start(0);
  }

  // Les exports vont dans Téléchargements\ClipForge, sans boîte « Enregistrer sous » à chaque fois.
  function freeName(file) {
    const { dir, name, ext } = path.parse(file);
    let out = file;
    for (let i = 2; fs.existsSync(out); i++) out = path.join(dir, `${name} (${i})${ext}`);
    return out;
  }
  function handleDownloads() {
    session.defaultSession.on('will-download', (_, item) => {
      fs.mkdirSync(SAVE, { recursive: true });
      item.setSavePath(freeName(path.join(SAVE, item.getFilename())));
      item.once('done', (__, state) => {
        if (state === 'completed' && win) win.webContents.send('saved', item.getSavePath());
      });
    });
    ipcMain.on('show', (_, file) => {
      const p = path.resolve(String(file));
      if (p.startsWith(SAVE)) shell.showItemInFolder(p);
    });
  }

  function loadState() {
    try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; }
  }
  function saveState() {
    if (!win) return;
    try { fs.writeFileSync(STATE, JSON.stringify({ ...win.getNormalBounds(), max: win.isMaximized() })); } catch {}
  }

  async function createWindow() {
    const url = await startServer();
    const st = loadState();
    win = new BrowserWindow({
      width: st.width || 1440, height: st.height || 900, x: st.x, y: st.y,
      minWidth: 900, minHeight: 600,
      title: 'ClipForge', backgroundColor: '#0b0b12', show: false,
      icon: path.join(__dirname, 'icon.png'),
      webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false },
    });
    if (st.max) win.maximize();
    win.once('ready-to-show', () => win.show());
    win.on('close', saveState);
    win.on('closed', () => { win = null; });
    // Les liens externes (GitHub, aide…) s'ouvrent dans le navigateur habituel.
    win.webContents.setWindowOpenHandler(({ url: u }) => {
      if (/^https?:/.test(u)) shell.openExternal(u);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, u) => {
      if (!u.startsWith(url)) { e.preventDefault(); shell.openExternal(u); }
    });
    win.loadURL(url);
  }

  Menu.setApplicationMenu(null);
  app.whenReady().then(async () => {
    handleDownloads();
    await createWindow();
    if (app.isPackaged) {
      // Nouvelle version publiée sur GitHub : téléchargée en fond, installée à la prochaine ouverture.
      try { require('electron-updater').autoUpdater.checkForUpdatesAndNotify().catch(() => {}); } catch {}
    }
  });
  app.on('window-all-closed', () => app.quit());
}
