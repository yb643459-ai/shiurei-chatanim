// הרצת האפליקציה האמיתית (Electron) מול ממשק אמיתי, עם דיסק נשלף מדומה ודיאלוגים מוחלפים.
const path = require('path'), fs = require('fs'), os = require('os');
const ROOT = path.resolve(__dirname, '..');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-shots-')); console.log('screenshots:', OUT);
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-data-'));
const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-shared-'));
const usb = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-usb-'));
const secret = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-secret-'));
fs.writeFileSync(path.join(secret, 'private.txt'), 'TOP SECRET');
fs.mkdirSync(path.join(shared, 'שיעורים', 'חומש'), { recursive: true });
fs.writeFileSync(path.join(shared, 'סיכום שיעור.pdf'), Buffer.alloc(250000, 1));
fs.writeFileSync(path.join(shared, 'הקלטה.mp3'), Buffer.alloc(4_500_000, 2));
fs.writeFileSync(path.join(shared, 'שיעורים', 'דף א.docx'), 'x');
fs.writeFileSync(path.join(shared, 'שיעורים', 'חומש', 'פרשה.txt'), 'y');
try { fs.symlinkSync(secret, path.join(shared, 'קישור-חשוד'), 'dir'); } catch {}
process.env.SECURECOPY_DATA_DIR = data;

const { app, BrowserWindow, dialog, shell } = require('electron');
app.commandLine.appendSwitch('no-sandbox'); app.commandLine.appendSwitch('disable-gpu');

const drives = require(ROOT + '/src/core/drives');
drives.getRemovableDrives = async () => [{ id: 'E:\\', path: usb, label: 'תלמידים (E:)', size: 8e9, free: 5e9 }];
// טלפון אמיתי שמחובר למחשב לא ייכנס לבדיקה (הוא היה מוסיף יעד שני)
require(ROOT + '/src/core/mtp').getMtpDrives = async () => [];
const pdfPath = path.join(os.tmpdir(), 'codes-test.pdf');
try { fs.rmSync(pdfPath); } catch {}
dialog.showSaveDialog = async () => ({ canceled: false, filePath: pdfPath });
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [shared] });
shell.openPath = async () => '';

let codes = [];
const { Vault } = require(ROOT + '/src/core/vault');
const origCommit = Vault.prototype.commitBatch;
Vault.prototype.commitBatch = function (items) { codes = items.map(i => i.code); return origCommit.call(this, items); };

require(ROOT + '/src/main.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = '') => { results.push([ok, name, extra]); console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  → ' + extra : '')); };

app.whenReady().then(async () => {
  await sleep(2500);
  const win = BrowserWindow.getAllWindows()[0];
  win.setSize(1100, 760);
  win.webContents.on('console-message', e => { const m = e.message ?? ''; if ((e.level === 'error' || e.level === 3 || e.level === 2) && m) console.log('[renderer]', m); });
  const ev = js => win.webContents.executeJavaScript(js);
  const shot = async n => { await sleep(600); fs.writeFileSync(`${OUT}/${n}.png`, (await win.webContents.capturePage()).toPNG()); };
  const field = lbl => `[...document.querySelectorAll('md-outlined-text-field')].find(f => f.label === ${JSON.stringify(lbl)})`;
  const setField = (lbl, v) => ev(`(${field(lbl)}).value = ${JSON.stringify(v)}`);
  const clickBtn = txt => ev(`[...document.querySelectorAll('md-filled-button,md-filled-tonal-button,md-text-button,md-outlined-button')].find(b => b.textContent.includes(${JSON.stringify(txt)})).click()`);
  const typeCode = async c => { for (const d of c) await ev(`[...document.querySelectorAll('.key')].find(b => b.textContent.trim() === '${d}').click()`); };
  const waitFor = async (js, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(js)) return true; await sleep(150); } return false; };
  const snackText = () => ev(`document.querySelector('#snackbar')?.textContent || ''`);
  const text = async () => (await ev(`document.body.innerText`)).replace(/[\u200E\u2066\u2069]/g, '');

  try {
    await shot('01-setup');
    check('first run shows setup', (await text()).includes('הגדרה ראשונה'));
    await setField('סיסמת ניהול', '999999'); await setField('אימות סיסמה', '999999'); await clickBtn('שמור והמשך'); await sleep(300);
    check('weak default password rejected', (await text()).includes('קלה מדי'));
    await setField('סיסמת ניהול', 'admin-Pass1'); await setField('אימות סיסמה', 'admin-Pass1'); await clickBtn('שמור והמשך'); await sleep(500);
    check('setup completes → code screen', (await text()).includes('הזנת קוד גישה'));
    await typeCode('12345678'); await shot('02-home-typing');

    await ev(`document.querySelector('[data-aria-label="כניסת ניהול"]').click()`); await sleep(400);
    await shot('03-admin-login');
    await setField('סיסמת ניהול', 'wrong'); await clickBtn('כניסה'); await sleep(500);
    check('wrong admin password rejected', (await text()).includes('סיסמה שגויה'));
    await setField('סיסמת ניהול', 'admin-Pass1'); await clickBtn('כניסה'); await sleep(700);
    check('admin login works', (await text()).includes('ניהול'));
    await shot('04-admin-codes-empty');

    await ev(`document.querySelectorAll('md-primary-tab')[2].click()`); await sleep(500);
    await clickBtn('הוסף תיקייה'); await sleep(600);
    await clickBtn('בחר תיקייה'); await sleep(500);
    await shot('04b-folder-dialog');
    await clickBtn('שמור'); await sleep(700);
    check('folder added to library', (await text()).includes('1 תיקיות'));
    await shot('04c-folders-tab');
    await ev(`document.querySelectorAll('md-primary-tab')[1].click()`); await sleep(500);
    await ev(`document.querySelector('.folders-list md-checkbox').click()`); await sleep(300);
    await setField('תווית (למשל שם כיתה/קורס)', 'כיתה ח׳ – שיעור 3');
    await setField('כותרת בעמוד ה-PDF', 'שיעורי הרב');
    await setField('כמות קודים', '6'); await setField('תוקף עד (אופציונלי)', '2026-12-31');
    await ev(`document.querySelectorAll('md-outlined-text-field').forEach(f => f.dispatchEvent(new Event('change'))); true`); await sleep(200);
    const summary = await text();
    check('issue summary describes the batch', summary.includes('יונפקו 6 קודים חד-פעמיים') && summary.includes('בתוקף עד 31/12/2026'));
    await shot('05-issue-form');
    await clickBtn('הנפק ושמור PDF'); await sleep(4000);
    const pdfOk = fs.existsSync(pdfPath) && fs.readFileSync(pdfPath).slice(0, 4).toString() === '%PDF';
    check('PDF created via printToPDF', pdfOk, pdfOk ? fs.statSync(pdfPath).size + ' bytes' : '');
    check('6 codes issued & committed', codes.length === 6 && codes.every(c => /^\d{12}$/.test(c)));
    const dataRaw = fs.readFileSync(path.join(data, 'data.json'), 'utf8');
    check('no plaintext codes/password on disk', !codes.some(c => dataRaw.includes(c)) && !dataRaw.includes('admin-Pass1'));
    await shot('06-admin-codes');
    const btnState = () => ev(`[...document.querySelectorAll('md-filled-tonal-button, md-outlined-button')].filter(b => /אפס שימוש|מחק נבחרים/.test(b.textContent)).map(b => b.disabled)`);
    check('code actions disabled with no selection', (await btnState()).every(d => d));
    await ev(`document.querySelector('tbody md-checkbox').click()`); await sleep(300);
    check('code actions enabled after selecting one', (await btnState()).every(d => !d) && (await text()).includes('1 נבחרו'));
    await shot('06b-admin-codes-selected');
    await ev(`document.querySelector('tbody md-checkbox').click()`); await sleep(200);
    await ev(`document.querySelectorAll('md-primary-tab')[3].click()`); await sleep(500); await shot('07-admin-log');
    check('log names the number of codes', (await text()).includes('6 קודים'));
    await ev(`document.querySelectorAll('md-primary-tab')[4].click()`); await sleep(500); await shot('08-admin-settings');
    check('idle timeout shown in minutes', (await ev(`(${field('ניתוק תלמיד לאחר חוסר פעילות (דקות)')}).value`)) === '5');
    const fl = await ev(`window.api.admin.listFolders()`);
    check('folder in use by 6 codes', fl.ok && fl.folders.length === 1 && fl.folders[0].uses === 6);
    const fid = fl.folders[0].id;
    const rm2 = await ev(`window.api.admin.removeFolder(${JSON.stringify(fid)}, {})`);
    check('removing in-use folder is blocked', rm2.ok === false && rm2.inUse === 6);
    const upd = await ev(`window.api.admin.updateFolder(${JSON.stringify(fid)}, {name:'שיעורי השבוע', path:${JSON.stringify(shared)}, note:'x'})`);
    check('folder rename propagates', upd.ok === true && upd.uses === 6);
    await ev(`document.querySelector('[data-aria-label="יציאה מניהול"]').click()`);
    await waitFor(`document.querySelectorAll('.key').length === 10`);
    const denied = await ev(`window.api.admin.listCodes()`);
    check('admin API denied without admin session', denied.ok === false && denied.auth === true);
    const deniedIssue = await ev(`window.api.admin.issue({folders:['/'],count:1})`);
    check('issue API denied without admin session', deniedIssue.ok === false);

    await typeCode('000000000000'); await clickBtn('כניסה'); await sleep(500);
    check('wrong student code rejected', (await text()).includes('קוד שגוי'));
    const c1 = codes[0];
    await typeCode(c1); await shot('09-home-typed-masked'); await clickBtn('כניסה');
    await waitFor(`document.querySelectorAll('.file-item').length > 0`);
    check('student enters folder', (await text()).includes('סיכום שיעור.pdf'));
    const names = await ev(`[...document.querySelectorAll('.file-item')].map(e => e.querySelector('[slot=headline]').textContent)`);
    check('symlink pointing outside is hidden', !names.includes('קישור-חשוד'), names.join(' | '));
    await shot('10-files');

    const outside = await ev(`window.api.listFolder(${JSON.stringify(secret)})`);
    check('list outside shared root blocked', outside.ok === false);
    const trav = await ev(`window.api.listFolder(${JSON.stringify(shared + '/../' + path.basename(secret))})`);
    check('path traversal blocked', trav.ok === false);
    const drvList = await ev(`window.api.listDrives()`);
    const cp1 = await ev(`window.api.copyItem({path:${JSON.stringify(path.join(secret, 'private.txt'))}, drive:${JSON.stringify(drvList.drives[0].id)}})`);
    check('copy of file outside root blocked', cp1.ok === false && !fs.existsSync(path.join(usb, 'private.txt')));
    const cp2 = await ev(`window.api.copyItem({path:${JSON.stringify(path.join(shared, 'סיכום שיעור.pdf'))}, drive:${JSON.stringify(os.tmpdir())}})`);
    check('copy to arbitrary (non-removable) destination blocked', cp2.ok === false);
    const cp3 = await ev(`window.api.copyItem({path:${JSON.stringify(path.join(shared, 'סיכום שיעור.pdf'))}, drive:'C:\\\\'})`);
    check('copy to unlisted drive blocked', cp3.ok === false);
    check('nothing leaked to the drive by blocked attempts', fs.readdirSync(usb).length === 0, fs.readdirSync(usb).join(','));

    const noDriveSel = await ev(`window.api.copyItem({path:${JSON.stringify(path.join(shared, 'סיכום שיעור.pdf'))}, drive:''})`);
    check('copy with empty drive is refused', noDriveSel.ok === false && fs.readdirSync(usb).length === 0, noDriveSel.msg);
    check('single removable drive is preselected', (await ev(`document.querySelector('md-outlined-select').value`)) === 'E:\\');
    const shownDrive = await ev(`document.querySelector('md-outlined-select').displayText || ''`);
    check('preselected drive is shown in the field', shownDrive.includes('תלמידים'), shownDrive);
    check('copy buttons enabled once a destination is chosen', await ev(`[...document.querySelectorAll('.copy-btn')].every(b => !b.disabled)`));
    await ev(`document.querySelector('.file-item [data-aria-label^="העתק את סיכום"]').click()`); await sleep(1200);
    check('file copied to removable drive', fs.existsSync(path.join(usb, 'סיכום שיעור.pdf')) && fs.statSync(path.join(usb, 'סיכום שיעור.pdf')).size === 250000, await snackText());
    await shot('11-copy-success');
    await ev(`document.querySelector('.file-item [data-aria-label^="העתק את סיכום"]').click()`); await sleep(1000);
    check('second copy does not overwrite', fs.existsSync(path.join(usb, 'סיכום שיעור (1).pdf')));
    await ev(`[...document.querySelectorAll('.file-item')].find(e => e.textContent.includes('שיעורים')).click()`); await sleep(600);
    await setField('שם התיקייה ביעד (אופציונלי)', 'שיעורי השבוע');
    await clickBtn('העתק את התיקייה הנוכחית'); await sleep(1500);
    check('folder copy with custom name (nested files)', fs.existsSync(path.join(usb, 'שיעורי השבוע', 'חומש', 'פרשה.txt')) && fs.existsSync(path.join(usb, 'שיעורי השבוע', 'דף א.docx')));
    await shot('12-files-subfolder');

    await ev(`document.querySelector('[data-aria-label="יציאה"]').click()`); await sleep(600);
    check('exit after using a one-time code asks for confirmation', (await text()).includes('לא תוכל להיכנס שוב עם הקוד הזה'));
    await shot('12b-exit-confirm');
    await clickBtn('יציאה'); await sleep(600);
    await typeCode(c1); await clickBtn('כניסה'); await sleep(700);
    check('one-time code is rejected after use', (await text()).includes('הקוד כבר נוצל'));
    await typeCode(codes[1]); await clickBtn('כניסה'); await sleep(700);
    check('another fresh code still works', (await text()).includes('סיכום שיעור.pdf'));
    // אזהרת חוסר פעילות: מקדמים את השעון של הממשק בלבד, כך שנשארו 10 שניות לפני הניתוק
    await ev(`(async () => { const idle = (await window.api.state()).settings.studentIdleSeconds; const real = Date.now.bind(Date); window.__realNow = real; Date.now = () => real() + (idle - 10) * 1000; })()`);
    await sleep(1500);
    check('idle warning shown before logout', (await snackText()).includes('הכניסה תסתיים בעוד'), await snackText());
    await shot('13a-idle-warning');
    await ev(`Date.now = window.__realNow; true`); await sleep(1500);
    check('idle warning hidden after activity', !(await ev(`document.querySelector('#snackbar').classList.contains('show')`)));
    await ev(`document.querySelector('[data-aria-label="יציאה"]').click()`); await sleep(500);

    for (let i = 0; i < 5; i++) { await typeCode('99999999'); await clickBtn('כניסה'); await sleep(250); }
    await sleep(400); await shot('13-locked');
    check('lockout after repeated failures', (await text()).includes('יותר מדי ניסיונות'));
    await typeCode(codes[2]);
    const state = await ev(`document.querySelector('.code-display').textContent`);
    check('keypad disabled while locked', state.includes('הקלד'), state);

    await ev(`document.querySelector('[data-aria-label^="ערכת נושא"]').click()`); await sleep(200);
    await ev(`document.querySelector('[data-aria-label^="ערכת נושא"]').click()`); await sleep(400);
    check('dark theme applied', (await ev(`document.documentElement.dataset.theme`)) === 'dark');
    await shot('14-dark-home');
  } catch (e) { check('harness exception', false, String(e && e.stack || e)); }

  const fails = results.filter(r => !r[0]);
  console.log(`\n${results.length - fails.length}/${results.length} passed`);
  app.exit(fails.length ? 1 : 0);
});
