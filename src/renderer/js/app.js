import { $, h, icon, formatSize, fileIcon, snack, hideSnack, ltr, bidiName, confirmDialog } from './dom.js';
import { Theme } from './theme.js';
import { renderAdmin } from './admin.js';

const api = window.api;
const root = () => $('#root');
let progressHandler = null;

export const S = { settings: null, notice: null, session: null, cwd: null, crumbs: [], entries: [], drives: [], driveId: '', code: '', showCode: false, busy: false };

let cleanup = () => {};
export function go(render) {
  cleanup(); cleanup = () => {};
  root().replaceChildren();
  const r = render();
  if (typeof r === 'function') cleanup = r;
}
export function goHome() { go(renderHome); }

const THEME_ICON = { system: 'brightness_auto', light: 'light_mode', dark: 'dark_mode' };
const THEME_LABEL = { system: 'ערכת נושא: לפי המערכת', light: 'ערכת נושא: בהירה', dark: 'ערכת נושא: כהה' };

export function topBar({ title, leading, actions = [] }) {
  const themeBtn = h('md-icon-button', { 'aria-label': THEME_LABEL[Theme.mode], title: THEME_LABEL[Theme.mode],
    onClick: () => { const m = Theme.cycle(); themeBtn.setAttribute('aria-label', THEME_LABEL[m]); themeBtn.title = THEME_LABEL[m]; themeBtn.firstChild.textContent = THEME_ICON[m]; snack(THEME_LABEL[m], { ms: 2000 }); } },
    icon(THEME_ICON[Theme.mode]));
  return h('header', { class: 'app-bar' },
    leading || h('md-icon', { class: 'brand-icon', text: 'shield_lock' }),
    h('h1', { class: 'md-typescale-title-large app-title', text: title }),
    h('span', { class: 'spacer' }), ...actions, themeBtn);
}

export function lockCountdown(seconds, onTick, onDone) {
  let left = seconds;
  onTick(left);
  const t = setInterval(() => { left -= 1; if (left <= 0) { clearInterval(t); onDone(); } else onTick(left); }, 1000);
  return () => clearInterval(t);
}

// lastPing = הפעם האחרונה שהתהליך הראשי שמע מהממשק (ping או קריאה שמאריכה את הכניסה). לפיו מחושבת אזהרת הניתוק.
let lastPing = 0;
const touched = () => { lastPing = Date.now(); };
function activity() { const t = Date.now(); if (t - lastPing > 10_000) { lastPing = t; api.ping(); } }
['pointerdown', 'keydown', 'wheel'].forEach(ev => window.addEventListener(ev, activity, { passive: true }));

export async function startApp() {
  api.onCopyProgress(p => progressHandler && progressHandler(p));
  api.onSessionExpired(who => {
    S.session = null; S.code = '';
    go(renderHome);
    snack(who === 'admin' ? 'כניסת הניהול הסתיימה בגלל חוסר פעילות' : 'הכניסה הסתיימה בגלל חוסר פעילות', { ms: 6000 });
  });
  const st = await api.state();
  S.settings = st.settings; S.notice = st.notice;
  if (st.needsSetup) go(renderSetup);
  else { go(renderHome); noticeSnack(); }
}

function noticeSnack() {
  if (S.notice === 'migrated-v1') snack('הנתונים הישנים הומרו לפורמט המאובטח. קודים שכבר חולקו ממשיכים לעבוד.', { ms: 9000 });
  else if (S.notice === 'restored-backup') snack('קובץ הנתונים היה פגום – נטען הגיבוי האחרון.', { error: true, ms: 9000 });
  S.notice = null;
}

function renderSetup() {
  const pw1 = h('md-outlined-text-field', { label: 'סיסמת ניהול', type: 'password', autocomplete: 'new-password', 'supporting-text': 'לפחות 6 תווים' });
  const pw2 = h('md-outlined-text-field', { label: 'אימות סיסמה', type: 'password', autocomplete: 'new-password' });
  const err = h('div', { class: 'form-error md-typescale-body-medium', hidden: true });
  const submit = async () => {
    err.hidden = true;
    if (pw1.value !== pw2.value) { err.textContent = 'הסיסמאות אינן זהות'; err.hidden = false; return; }
    const r = await api.setupAdmin(pw1.value);
    if (!r.ok) { err.textContent = r.msg; err.hidden = false; return; }
    snack('סיסמת הניהול נשמרה');
    go(renderHome); noticeSnack();
  };
  [pw1, pw2].forEach(f => f.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); }));
  root().append(
    topBar({ title: 'שיעורי חתנים' }),
    h('main', { class: 'center' },
      h('section', { class: 'card narrow' },
        h('md-icon', { class: 'hero-icon', text: 'key' }),
        h('h2', { class: 'md-typescale-headline-small', text: 'הגדרה ראשונה' }),
        h('p', { class: 'md-typescale-body-large muted', text: 'בחר סיסמת ניהול. בעזרתה תנפיק קודים ותנהל גישה. אין סיסמת ברירת מחדל, ואם תאבד אותה לא ניתן לשחזר אותה.' }),
        pw1, pw2, err,
        h('div', { class: 'row end' }, h('md-filled-button', { text: 'שמור והמשך', onClick: submit })))));
}

function renderHome() {
  S.code = ''; S.session = null;
  let lockStop = null; let locked = false;

  const display = h('div', { class: 'code-display md-typescale-headline-medium', dir: 'ltr', 'aria-live': 'polite' });
  const errEl = h('div', { class: 'form-error md-typescale-body-medium', hidden: true, role: 'alert' });
  const enter = h('md-filled-button', { text: 'כניסה', disabled: true, onClick: () => submit() }, h('md-icon', { slot: 'icon', text: 'login' }));
  const eye = h('md-icon-button', { 'aria-label': 'הצג/הסתר קוד', onClick: () => { S.showCode = !S.showCode; eye.firstChild.textContent = S.showCode ? 'visibility_off' : 'visibility'; paint(); } },
    icon(S.showCode ? 'visibility_off' : 'visibility'));

  function paint() {
    if (!S.code) { display.textContent = 'הקלד או הקש את הקוד'; display.classList.add('placeholder'); }
    else {
      display.classList.remove('placeholder');
      const chars = [...S.code].map(c => (S.showCode ? c : '●'));
      display.textContent = chars.map((c, i) => (i && i % 4 === 0 ? ' ' : '') + c).join('');
    }
    enter.disabled = locked || S.code.length < 8 || S.busy;
  }
  const press = d => { if (locked || S.busy || S.code.length >= 20) return; S.code += d; errEl.hidden = true; paint(); };
  const back = () => { if (locked || S.busy) return; S.code = S.code.slice(0, -1); errEl.hidden = true; paint(); };

  async function submit() {
    if (locked || S.busy || S.code.length < 8) return;
    S.busy = true; paint();
    const r = await api.verifyCode(S.code);
    S.busy = false;
    S.code = ''; paint();
    if (r.ok) { S.session = r; go(renderFiles); return; }
    display.classList.remove('shake'); void display.offsetWidth; display.classList.add('shake');
    errEl.hidden = false;
    if (r.locked && r.retryAfter) {
      locked = true; paint();
      lockStop = lockCountdown(r.retryAfter, n => { errEl.textContent = `יותר מדי ניסיונות. אפשר לנסות שוב בעוד ${n} שניות`; },
        () => { locked = false; errEl.hidden = true; paint(); });
    } else errEl.textContent = r.msg || 'קוד שגוי';
  }

  const keypad = h('div', { class: 'keypad', dir: 'ltr' },
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => h('md-filled-tonal-button', { class: 'key', text: String(n), onClick: () => press(String(n)) })),
    h('md-icon-button', { class: 'key-back', 'aria-label': 'מחק ספרה', onClick: back }, icon('backspace')),
    h('md-filled-tonal-button', { class: 'key', text: '0', onClick: () => press('0') }),
    enter);

  const onKey = e => {
    if (e.target.closest && e.target.closest('md-dialog')) return;
    if (/^\d$/.test(e.key)) press(e.key);
    else if (e.key === 'Backspace') back();
    else if (e.key === 'Enter') submit();
  };
  window.addEventListener('keydown', onKey);

  root().append(
    topBar({ title: 'שיעורי חתנים', actions: [
      h('md-icon-button', { 'aria-label': 'כניסת ניהול', title: 'כניסת ניהול', onClick: () => go(renderAdminLogin) }, icon('admin_panel_settings'))] }),
    h('main', { class: 'center' },
      h('section', { class: 'card narrow' },
        h('h2', { class: 'md-typescale-headline-small', text: 'הזנת קוד גישה' }),
        h('p', { class: 'md-typescale-body-medium muted', text: 'הקוד שקיבלת פותח גישה לתיקייה המיועדת לך בלבד.' }),
        h('div', { class: 'code-row' }, display, eye),
        errEl, keypad)));
  paint();
  return () => { window.removeEventListener('keydown', onKey); lockStop && lockStop(); };
}

function renderAdminLogin() {
  let lockStop = null;
  const pw = h('md-outlined-text-field', { label: 'סיסמת ניהול', type: 'password', autocomplete: 'current-password' });
  const err = h('div', { class: 'form-error md-typescale-body-medium', hidden: true, role: 'alert' });
  const btn = h('md-filled-button', { text: 'כניסה', onClick: () => submit() });
  async function submit() {
    btn.disabled = true; err.hidden = true;
    const r = await api.adminLogin(pw.value);
    pw.value = '';
    if (r.ok) { S.settings = r.settings; go(renderAdmin); return; }
    err.hidden = false;
    if (r.locked && r.retryAfter) {
      lockStop = lockCountdown(r.retryAfter, n => { err.textContent = `יותר מדי ניסיונות. נסה שוב בעוד ${n} שניות`; btn.disabled = true; }, () => { err.hidden = true; btn.disabled = false; });
    } else { err.textContent = r.msg || 'סיסמה שגויה'; btn.disabled = false; }
  }
  pw.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  root().append(
    topBar({ title: 'כניסת ניהול', leading: h('md-icon-button', { 'aria-label': 'חזרה', onClick: () => go(renderHome) }, icon('arrow_forward')) }),
    h('main', { class: 'center' },
      h('section', { class: 'card narrow' },
        h('md-icon', { class: 'hero-icon', text: 'admin_panel_settings' }),
        h('h2', { class: 'md-typescale-headline-small', text: 'כניסת מנהל' }),
        pw, err,
        h('div', { class: 'row end' }, h('md-text-button', { text: 'ביטול', onClick: () => go(renderHome) }), btn))));
  setTimeout(() => pw.focus(), 50);
  return () => lockStop && lockStop();
}

function renderFiles() {
  S.cwd = null; S.crumbs = []; S.entries = []; S.drives = []; S.driveId = '';
  const sess = S.session;

  const crumbsEl = h('nav', { class: 'crumbs', 'aria-label': 'נתיב' });
  const listEl = h('md-list', { class: 'file-list' });
  const listCard = h('section', { class: 'card list-card' }, crumbsEl, h('md-divider'), listEl);

  const driveSel = h('md-outlined-select', { label: 'יעד', class: 'grow' });
  driveSel.addEventListener('change', () => { S.driveId = driveSel.value; updateCopyState(); });
  const refreshBtn = h('md-icon-button', { 'aria-label': 'רענון רשימת היעדים', title: 'רענון', onClick: () => refreshDrives(true) }, icon('refresh'));
  const driveHint = h('div', { class: 'md-typescale-body-small muted' });
  const folderName = h('md-outlined-text-field', { label: 'שם התיקייה ביעד (אופציונלי)', 'supporting-text': 'ריק = אותו שם כמו כאן' });
  const copyAll = h('md-filled-button', { text: 'העתק את התיקייה הנוכחית', onClick: () => doCopy(S.cwd, true, folderName.value.trim() || null) },
    h('md-icon', { slot: 'icon', text: 'folder_copy' }));
  const side = h('aside', { class: 'card side' },
    h('h3', { class: 'md-typescale-title-medium', text: 'העתקה ליעד' }),
    h('div', { class: 'md-typescale-body-small muted', text: 'דיסק נשלף או טלפון. כדי להעתיק קובץ אחד, לחץ על החץ שלידו ברשימה.' }),
    h('div', { class: 'row' }, driveSel, refreshBtn), driveHint,
    h('md-divider'),
    h('h3', { class: 'md-typescale-title-small', text: 'העתקת כל התיקייה הנוכחית' }),
    folderName, copyAll);

  const exit = h('md-icon-button', { 'aria-label': 'יציאה', title: 'יציאה', onClick: logout }, icon('logout'));
  // תגיות מידע בלבד (לא כפתורים)
  const chips = [h('span', { class: 'info-chip' }, icon('sell'), h('span', { text: sess.label || 'הקבצים שלי' }))];
  if (sess.oneTime) chips.push(h('span', { class: 'info-chip warn' }, icon('info'), h('span', { text: 'קוד חד-פעמי: אחרי היציאה לא תוכל להיכנס שוב. העתק את כל מה שצריך לפני שתצא' })));
  let copied = false;

  root().append(
    topBar({ title: 'הקבצים שלי', leading: exit }),
    h('main', { class: 'files-layout' }, h('div', { class: 'chips' }, ...chips), listCard, side));

  async function logout() {
    if (sess.oneTime && copied && !await confirmDialog({
      title: 'לצאת?', body: 'הקוד שלך חד-פעמי וכבר נוצל. אחרי היציאה לא תוכל להיכנס שוב עם הקוד הזה. ודא שהעתקת את כל מה שצריך.',
      confirmText: 'יציאה' })) return;
    await api.endSession(); S.session = null; go(renderHome);
  }

  function renderCrumbs() {
    crumbsEl.replaceChildren();
    S.crumbs.forEach((c, i) => {
      if (i) crumbsEl.append(h('md-icon', { class: 'sep', text: 'chevron_left' }));
      const last = i === S.crumbs.length - 1;
      crumbsEl.append(last
        ? h('span', { class: 'crumb-current md-typescale-title-medium', 'aria-current': 'page', text: c.name })
        : h('md-text-button', { text: c.name, onClick: () => goToCrumb(i) }));
    });
  }

  // כפתורי ההעתקה פעילים רק כשנבחר יעד
  function updateCopyState() {
    copyAll.disabled = !S.cwd || !S.driveId;
    folderName.disabled = !S.cwd;
    listEl.querySelectorAll('.copy-btn').forEach(b => { b.disabled = !S.driveId; });
    const usable = S.drives.filter(d => !d.locked);
    if (usable.length && !S.driveId) driveHint.textContent = 'בחר יעד כדי להעתיק.';
    else if (driveHint.textContent === 'בחר יעד כדי להעתיק.') driveHint.textContent = '';
  }

  function renderList() {
    listEl.replaceChildren();
    if (!S.entries.length) {
      listEl.append(h('div', { class: 'empty' }, h('md-icon', { text: 'folder_off' }), h('div', { class: 'md-typescale-body-large', text: 'התיקייה ריקה' })));
      updateCopyState();
      return;
    }
    for (const e of S.entries) {
      const copyBtn = h('md-filled-tonal-icon-button', { slot: 'end', class: 'copy-btn', 'aria-label': `העתק את ${e.name}`, title: 'העתק ליעד',
        onClick: ev => { ev.stopPropagation(); doCopy(e.path, e.isDir, null); } }, icon('download'));
      const item = h('md-list-item', { type: e.isDir ? 'button' : 'text', class: 'file-item' },
        h('md-icon', { slot: 'start', class: e.isDir ? 'icon-folder' : 'icon-file', text: e.isDir ? 'folder' : fileIcon(e.name) }),
        h('div', { slot: 'headline', text: bidiName(e.name) }),
        h('div', { slot: 'supporting-text', text: e.isDir ? 'תיקייה' : ltr(formatSize(e.size)) }),
        copyBtn);
      if (e.isDir) item.addEventListener('click', () => openDir(e.path, e.name, false));
      listEl.append(item);
    }
    updateCopyState();
  }

  async function openDir(p, name, reset) {
    const r = await api.listFolder(p);
    if (!r.ok) { if (r.auth) return expired(); snack(r.msg, { error: true }); return; }
    touched();
    S.cwd = r.path; S.entries = r.entries;
    if (reset) S.crumbs = [{ name, path: r.path }]; else S.crumbs.push({ name, path: r.path });
    renderCrumbs(); renderList();
  }
  function goToCrumb(i) {
    const c = S.crumbs[i];
    S.crumbs = S.crumbs.slice(0, i);
    if (c.path === null) showRoots(); else openDir(c.path, c.name, S.crumbs.length === 0);
  }
  function showRoots() {
    S.cwd = null; S.crumbs = [{ name: 'התיקיות שלי', path: null }];
    S.entries = sess.roots.map(r => ({ name: r.name, path: r.path, isDir: true, size: 0 }));
    renderCrumbs(); renderList();
  }
  function expired() { S.session = null; go(renderHome); snack('הכניסה הסתיימה – יש להזין קוד מחדש', { error: true }); }

  async function refreshDrives(manual = false) {
    refreshBtn.disabled = true;
    const r = await api.listDrives();
    refreshBtn.disabled = false;
    if (!r.ok) { if (r.auth) expired(); return; }
    touched();
    S.drives = r.drives;
    // קודם בוחרים את היעד, ורק אז בונים את האפשרויות, כדי שהאפשרות הנבחרת תוצג בשדה
    const usable = r.drives.filter(d => !d.locked);
    if (!usable.some(d => d.id === S.driveId)) S.driveId = usable.length === 1 ? usable[0].id : '';
    driveSel.replaceChildren(...r.drives.map(d => {
      const text = d.label + (d.free ? ` · פנוי ${ltr(formatSize(d.free))}` : '');
      // display-text: הטקסט שמוצג בשדה עצמו. בלעדיו השדה נשאר ריק כשהאפשרות נבחרת לפני שהיא מצוירת
      return h('md-select-option', { value: d.id, selected: d.id === S.driveId, disabled: d.locked, 'display-text': d.label },
        h('div', { slot: 'headline', text }));
    }));
    driveSel.value = S.driveId;
    driveHint.textContent = !r.drives.length ? 'לא נמצא דיסק נשלף או טלפון. חבר אותו ולחץ על רענון.'
      : r.drives.some(d => d.locked) ? 'הטלפון מחובר אבל לא נגיש: פתח את המסך ובחר "העברת קבצים" בהתראה שבטלפון, ואז לחץ על רענון.' : '';
    updateCopyState();
    if (manual && r.drives.length) snack(`נמצאו ${r.drives.length} יעדים`);
  }

  async function doCopy(src, isDir, customName) {
    if (!S.driveId) { snack('יש לבחור יעד קודם', { error: true }); if (!S.drives.length) refreshDrives(); return; }
    const bar = h('md-linear-progress', { indeterminate: true });
    const nameEl = h('div', { class: 'md-typescale-body-medium muted', text: '' });
    const isPhone = (S.drives.find(d => d.id === S.driveId) || {}).kind === 'mtp';
    if (isPhone) nameEl.textContent = 'מעתיק לטלפון. אל תנתק את הכבל עד שההעתקה תסתיים.';
    const dlg = h('md-dialog', { class: 'progress-dialog' },
      h('div', { slot: 'headline', text: 'מעתיק…' }), h('div', { slot: 'content' }, bar, nameEl),
      isPhone ? h('div', { slot: 'actions' }, h('md-text-button', { text: 'ביטול', onClick: () => api.cancelCopy() })) : null);
    dlg.addEventListener('cancel', e => e.preventDefault());
    document.body.append(dlg);
    let shown = false;
    const t = setTimeout(() => { shown = true; dlg.show(); }, 350);
    progressHandler = p => { if (p.total > 1) { bar.indeterminate = false; bar.value = p.done / p.total; } if (!isPhone) nameEl.textContent = p.name; };
    S.busy = true; touched();
    const r = await api.copyItem({ path: src, drive: S.driveId, customName });
    S.busy = false; touched();
    clearTimeout(t); progressHandler = null;
    dlg.addEventListener('closed', () => dlg.remove());
    if (shown) dlg.close(); else dlg.remove();
    if (r.ok) copied = true;
    if (r.ok) snack(`✓ הועתק ${isPhone ? 'לטלפון' : 'לדיסק'}: ${r.destName}${r.files > 1 ? ` (${r.files} קבצים)` : ''}`, { ms: 6000 });
    else if (r.auth) expired();
    else if (r.cancelled) snack(r.msg || 'ההעתקה בוטלה');
    else snack(r.msg || 'ההעתקה נכשלה', { error: true, ms: 7000 });
  }

  // אזהרה לפני ניתוק בגלל חוסר פעילות (הניתוק עצמו נאכף בתהליך הראשי)
  const idle = sess.idleSeconds || 0;
  const warnBefore = Math.min(30, Math.floor(idle / 2));
  let warned = false;
  const idleTimer = idle ? setInterval(() => {
    const left = Math.ceil(idle - (Date.now() - lastPing) / 1000);
    if (!S.busy && left > 0 && left <= warnBefore) {
      warned = true;
      snack(`הכניסה תסתיים בעוד ${left} שניות בגלל חוסר פעילות. לחץ על המסך כדי להישאר.`, { error: true, ms: 1500 });
    } else if (warned && left > warnBefore) { warned = false; hideSnack(); }
  }, 1000) : null;

  touched();
  if (sess.roots.length === 1) openDir(sess.roots[0].path, sess.roots[0].name, true); else showRoots();
  refreshDrives();
  const onFocus = () => refreshDrives();
  window.addEventListener('focus', onFocus);
  return () => { window.removeEventListener('focus', onFocus); if (idleTimer) clearInterval(idleTimer); };
}
