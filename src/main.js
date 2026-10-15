'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, session } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const { pathToFileURL } = require('url');

// השם המוצג של התוכנה הוא "שיעורי חתנים" (קודם: SecureCopy).
// תיקיית הנתונים נשארת %APPDATA%\SecureCopy בכוונה, כדי שקודים שכבר חולקו ימשיכו לעבוד. אין לשנות.
const APP_TITLE = 'שיעורי חתנים';
const DATA_DIR_NAME = 'SecureCopy';
// בבדיקות (לא באפליקציה ארוזה) אפשר להפנות את הנתונים לתיקייה אחרת
if (!app.isPackaged && process.env.SECURECOPY_DATA_DIR) app.setPath('userData', process.env.SECURECOPY_DATA_DIR);
else app.setPath('userData', path.join(app.getPath('appData'), DATA_DIR_NAME));

const { Vault } = require('./core/vault');
const { Sessions } = require('./core/sessions');
const { resolveInside, realOrNull, isInside, isFilesystemRoot } = require('./core/pathguard');
const { getRemovableDrives } = require('./core/drives');
const { copyItem } = require('./core/copier');
const { getMtpDrives, copyToMtp } = require('./core/mtp');
const { renderCodesHtml } = require('./core/pdfhtml');

const INDEX_URL = pathToFileURL(path.join(__dirname, 'renderer', 'index.html')).href;
const FONTS_DIR = path.join(__dirname, 'renderer', 'fonts');
const HIDDEN = new Set(['desktop.ini', 'thumbs.db', '.ds_store']);

let mainWindow = null;
let vault = null;
let sessions = null;
let copying = false;
let copyAbort = null;

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100, height: 760, minWidth: 820, minHeight: 600,
    show: false, autoHideMenuBar: true, title: APP_TITLE,
    backgroundColor: '#fdfbff',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
      devTools: !app.isPackaged, spellcheck: false
    }
  });
  mainWindow.setMenu(null);
  mainWindow.loadURL(INDEX_URL);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', e => e.preventDefault());
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  Menu.setApplicationMenu(null);

  vault = new Vault({ dataDir: app.getPath('userData') }).load();
  sessions = new Sessions(() => vault.getSettings());
  createWindow();

  setInterval(() => {
    for (const who of sessions.sweep()) mainWindow?.webContents.send('session-expired', who);
  }, 5000);
});

app.on('window-all-closed', () => app.quit());

function fromUi(e) { return e.senderFrame && e.senderFrame.url === INDEX_URL; }
function handle(channel, fn) {
  ipcMain.handle(channel, async (e, ...args) => {
    if (!fromUi(e)) return { ok: false, msg: 'בקשה לא מורשית' };
    try { return await fn(e, ...args); }
    catch (err) { console.error(channel, err); return { ok: false, msg: 'שגיאה פנימית' }; }
  });
}
const needAdmin = () => sessions.touchAdmin();
const DENIED = { ok: false, msg: 'נדרשת כניסת מנהל', auth: true };
const EXPIRED = { ok: false, msg: 'הכניסה פגה – יש להזין קוד מחדש', auth: true };

async function validateFolders(list) {
  if (!Array.isArray(list) || !list.length) return { ok: false, msg: 'יש לבחור לפחות תיקייה אחת' };
  const out = [];
  for (const f of list) {
    if (typeof f !== 'string') return { ok: false, msg: 'נתיב לא תקין' };
    const real = realOrNull(path.resolve(f));
    if (!real || !(await fsp.stat(real).then(s => s.isDirectory(), () => false))) return { ok: false, msg: `התיקייה לא נמצאה: ${f}` };
    if (isFilesystemRoot(real)) return { ok: false, msg: 'אסור לשתף שורש של דיסק שלם – בחר תיקייה ספציפית' };
    if (isInside(real, app.getPath('userData'))) return { ok: false, msg: 'התיקייה כוללת את נתוני התוכנה ולכן אי אפשר לשתף אותה' };
    if (!out.includes(real)) out.push(real);
  }
  return { ok: true, folders: out };
}

handle('app:state', () => {
  sessions.endAll();
  return { ok: true, needsSetup: vault.needsSetup(), notice: vault.loadNotice, settings: vault.getSettings(), platform: process.platform };
});
handle('app:ping', () => { sessions.touchStudent(); sessions.touchAdmin(); return { ok: true }; });
handle('setup:admin', (_e, pw) => vault.setupAdmin(pw));

// ─── תלמיד ──────────────────────────────────────────────────────────────
handle('student:login', (_e, code) => {
  sessions.endAll();
  const r = vault.checkCode(code);
  if (!r.ok) return { ok: false, msg: r.msg, retryAfter: r.retryAfter || 0, locked: !!r.locked };
  sessions.startStudent({ id: r.id, hint: r.hint, label: r.label, roots: r.roots });
  return {
    ok: true, label: r.label, oneTime: r.maxUses === 1,
    roots: r.folders.map(f => ({ name: f.name, path: f.path })),
    idleSeconds: vault.getSettings().studentIdleSeconds
  };
});
handle('student:logout', () => { if (copyAbort) copyAbort.abort(); sessions.endAll(); return { ok: true }; });
handle('student:cancel-copy', () => { if (copyAbort) copyAbort.abort(); return { ok: true }; });

handle('student:list', async (_e, dir) => {
  const s = sessions.touchStudent(); if (!s) return EXPIRED;
  const real = resolveInside(s.roots, dir);
  if (!real) return { ok: false, msg: 'התיקייה אינה זמינה' };
  const out = [];
  for (const d of await fsp.readdir(real, { withFileTypes: true })) {
    if (d.name.startsWith('.') || HIDDEN.has(d.name.toLowerCase())) continue;
    const p = path.join(real, d.name);
    if (d.isSymbolicLink()) { const rr = realOrNull(p); if (!rr || !s.roots.some(r => isInside(r, rr))) continue; }
    try {
      const st = await fsp.stat(p);
      out.push({ name: d.name, path: p, isDir: st.isDirectory(), size: st.isFile() ? st.size : 0, mtime: st.mtimeMs });
    } catch { /* פריט שאי אפשר לקרוא */ }
  }
  out.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name, 'he', { numeric: true }));
  return { ok: true, path: real, entries: out };
});

// יעדים אפשריים: דיסקים נשלפים + טלפונים (MTP, Windows בלבד). הרשימה נבנית תמיד בצד הראשי.
async function listDestinations() {
  const [vols, phones] = await Promise.all([getRemovableDrives(), process.platform === 'win32' ? getMtpDrives() : []]);
  return [...vols, ...phones];
}

handle('student:drives', async () => {
  if (!sessions.touchStudent()) return EXPIRED;
  const drives = await listDestinations();
  return { ok: true, drives: drives.map(({ id, label, size, free, kind, locked }) => ({ id, label, size, free, kind: kind || 'volume', locked: !!locked })) };
});

handle('student:copy', async (e, { path: src, drive, customName } = {}) => {
  const s = sessions.touchStudent(); if (!s) return EXPIRED;
  if (copying) return { ok: false, msg: 'העתקה אחרת עדיין מתבצעת' };
  const real = resolveInside(s.roots, src);
  if (!real) return { ok: false, msg: 'הפריט אינו זמין' };

  // היעד נקבע רק מתוך רשימת היעדים שזוהתה כרגע – לא מנתיב שהגיע מהממשק
  const target = (await listDestinations()).find(d => d.id === drive);
  if (!target) return { ok: false, msg: 'הדיסק הנשלף לא נמצא – חבר אותו ולחץ על רענון' };
  if (target.locked) return { ok: false, msg: 'הטלפון נעול או לא במצב "העברת קבצים" – פתח את המסך ובחר "העברת קבצים"' };
  if (target.kind !== 'mtp' && isInside(real, target.path)) return { ok: false, msg: 'אי אפשר להעתיק תיקייה לתוך עצמה' };

  copying = true;
  copyAbort = new AbortController();
  let last = 0;
  try {
    const onProgress = p => {
      const t = Date.now();
      if (t - last > 100 || p.done === p.total) { last = t; e.sender.send('copy-progress', p); }
    };
    const r = target.kind === 'mtp'
      ? await copyToMtp({ id: target.id, srcReal: real, customName, onProgress, signal: copyAbort.signal })
      : await copyItem(real, target.path, customName, onProgress);
    if (r.ok) {
      if (!s.counted) { s.counted = true; vault.markUsed(s.id); }
      vault.log('copy', { hint: s.hint, label: s.label, name: path.basename(real), files: r.files, bytes: r.bytes });
    } else {
      vault.log('copy_fail', { hint: s.hint, label: s.label, name: path.basename(real), reason: r.msg });
    }
    return { ok: r.ok, cancelled: !!r.cancelled, msg: r.msg, destName: r.dest ? path.basename(r.dest) : undefined, files: r.files, bytes: r.bytes };
  } finally { copying = false; copyAbort = null; }
});

// ─── מנהל ───────────────────────────────────────────────────────────────
handle('admin:login', (_e, pw) => {
  sessions.endAll();
  const r = vault.verifyAdmin(pw);
  if (!r.ok) return { ok: false, msg: r.msg, retryAfter: r.retryAfter || 0, locked: !!r.locked };
  sessions.startAdmin();
  return { ok: true, settings: vault.getSettings() };
});
handle('admin:logout', () => { sessions.endAll(); return { ok: true }; });
handle('admin:codes', () => needAdmin() ? { ok: true, codes: vault.listCodes() } : DENIED);

handle('admin:pick-folder', async () => {
  if (!needAdmin()) return DENIED;
  const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  return { ok: true, path: r.canceled ? null : r.filePaths[0] };
});

handle('admin:issue', async (_e, opts = {}) => {
  if (!needAdmin()) return DENIED;
  const batch = vault.prepareBatch({ ...opts, folderIds: opts.folderIds });
  if (!batch.ok) return batch;
  const folderNames = vault.foldersByIds(opts.folderIds).map(f => f.name);

  const save = await dialog.showSaveDialog(mainWindow, {
    title: 'שמירת PDF קודים',
    defaultPath: `קודים_${(opts.label || 'כללי').replace(/[\\/:*?"<>|]/g, '_')}.pdf`,
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  });
  if (save.canceled) return { ok: false, cancelled: true, msg: 'השמירה בוטלה – לא נוצרו קודים' };

  // ה-PDF נוצר קודם; הקודים נשמרים בנתונים רק אם הוא נכתב בהצלחה
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'securecopy-'));
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    const html = renderCodesHtml({
      title: opts.pageTitle, label: opts.label, folderNames,
      codes: batch.items.map(i => i.code), expiryDate: opts.expiryDate || null,
      maxUses: batch.items[0].record.maxUses, fontsDir: FONTS_DIR
    });
    const htmlPath = path.join(tmp, 'codes.html');
    await fsp.writeFile(htmlPath, html, 'utf8');
    await win.loadFile(htmlPath);
    await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
    const pdf = await win.webContents.printToPDF({ pageSize: 'A4', printBackground: true, preferCSSPageSize: true });
    await fsp.writeFile(save.filePath, pdf);
  } catch (err) {
    console.error('pdf', err);
    return { ok: false, msg: 'יצירת ה-PDF נכשלה – לא נוצרו קודים' };
  } finally {
    win.destroy();
    fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
  vault.commitBatch(batch.items);
  shell.openPath(save.filePath);
  return { ok: true, count: batch.items.length };
});

handle('admin:update-code', (_e, id, patch = {}) => needAdmin() ? vault.updateCode(id, patch) : DENIED);

// ─── ספריית תיקיות ──────────────────────────────────────────────────────
handle('admin:folders', () => needAdmin() ? { ok: true, folders: vault.listFolders() } : DENIED);
handle('admin:folder-add', async (_e, { name, path: p, note } = {}) => {
  if (!needAdmin()) return DENIED;
  const v = await validateFolders([p]);
  if (!v.ok) return v;
  return vault.addFolder({ name, path: v.folders[0], note });
});
handle('admin:folder-update', async (_e, id, patch = {}) => {
  if (!needAdmin()) return DENIED;
  const clean = { name: patch.name, note: patch.note };
  if (patch.path !== undefined) {
    const v = await validateFolders([patch.path]);
    if (!v.ok) return v;
    clean.path = v.folders[0];
  }
  return vault.updateFolder(id, clean);
});
handle('admin:folder-remove', (_e, id, opts = {}) => needAdmin() ? vault.removeFolder(id, { detach: !!opts.detach }) : DENIED);
handle('admin:reset-usage',    (_e, ids) => needAdmin() ? vault.resetUsage(Array.isArray(ids) ? ids : []) : DENIED);
handle('admin:delete-codes',   (_e, ids) => needAdmin() ? vault.deleteCodes(Array.isArray(ids) ? ids : []) : DENIED);
handle('admin:delete-expired', ()        => needAdmin() ? vault.deleteExpired() : DENIED);
handle('admin:get-settings',   ()        => needAdmin() ? { ok: true, settings: vault.getSettings() } : DENIED);
handle('admin:save-settings',  (_e, p)   => needAdmin() ? vault.updateSettings(p || {}) : DENIED);
handle('admin:change-password',(_e, o, n)=> needAdmin() ? vault.changeAdminPassword(o, n) : DENIED);
handle('admin:log',            ()        => needAdmin() ? { ok: true, entries: vault.readLog(300) } : DENIED);
