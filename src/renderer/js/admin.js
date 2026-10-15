import { h, icon, limitLen, formatDate, isoToHe, snack, confirmDialog, ltr } from './dom.js';
import { S, goHome, topBar } from './app.js';

const api = window.api;
const A = api.admin;

const LOG_LABELS = {
  login: ['login', 'כניסה'], login_fail: ['gpp_bad', 'ניסיון כניסה כושל'], login_denied: ['block', 'כניסה נדחתה'],
  copy: ['content_copy', 'העתקה'], copy_fail: ['error', 'העתקה נכשלה'],
  codes_issued: ['add_card', 'הונפקו קודים'], codes_deleted: ['delete', 'קודים נמחקו'], code_updated: ['edit', 'קוד עודכן'], usage_reset: ['restart_alt', 'שימוש אופס'],
  admin_login: ['admin_panel_settings', 'כניסת מנהל'], admin_login_fail: ['gpp_bad', 'כניסת מנהל כושלת'],
  folder_added: ['create_new_folder', 'תיקייה נוספה'], folder_updated: ['edit', 'תיקייה עודכנה'], folder_removed: ['folder_delete', 'תיקייה הוסרה'],
  admin_setup: ['key', 'הגדרת סיסמת מנהל'], admin_password_changed: ['password', 'סיסמת מנהל הוחלפה']
};
const REASONS = { expired: 'פג תוקף', used: 'הקוד נוצל' };
const STATUS = { active: ['פעיל', 'st-active'], used: ['נוצל', 'st-used'], expired: ['פג תוקף', 'st-expired'] };

function authFail(r) {
  if (r && r.auth) { goHome(); snack('כניסת הניהול פגה – יש להיכנס שוב', { error: true }); return true; }
  return false;
}

export function renderAdmin() {
  const tabs = [['codes', 'קודים', 'pin'], ['issue', 'הנפקה', 'add_card'], ['folders', 'תיקיות', 'folder_managed'], ['log', 'יומן', 'history'], ['settings', 'הגדרות', 'tune']];
  const tabEls = tabs.map(([id, label, ic]) => h('md-primary-tab', { 'aria-controls': 'panel-' + id }, h('md-icon', { slot: 'icon', text: ic }), label));
  const tabBar = h('md-tabs', {}, ...tabEls);
  const body = h('main', { class: 'admin-body' });

  const exit = h('md-icon-button', { 'aria-label': 'יציאה מניהול', title: 'יציאה', onClick: async () => { await api.adminLogout(); goHome(); } }, icon('logout'));
  document.getElementById('root').append(topBar({ title: 'ניהול', leading: exit }), tabBar, body);

  const builders = { codes: CodesPanel, issue: IssuePanel, folders: FoldersPanel, log: LogPanel, settings: SettingsPanel };
  function show(id) {
    body.replaceChildren();
    const p = builders[id]();
    p.id = 'panel-' + id;
    body.append(p);
    const idx = tabs.findIndex(t => t[0] === id);
    if (tabBar.activeTabIndex !== idx) tabBar.activeTabIndex = idx;
  }
  tabBar.addEventListener('change', () => show(tabs[tabBar.activeTabIndex][0]));
  S.adminShow = show;
  tabBar.activeTabIndex = 0;
  show('codes');
}

function CodesPanel() {
  const selected = new Set();
  let all = [];
  const search = h('md-outlined-text-field', { label: 'חיפוש לפי תווית, תיקייה או 4 ספרות אחרונות', class: 'grow' }, h('md-icon', { slot: 'leading-icon', text: 'search' }));
  const count = h('span', { class: 'md-typescale-body-medium muted' });
  const selCount = h('span', { class: 'md-typescale-body-medium muted sel-count' });
  const tbody = h('tbody');
  const selAll = h('md-checkbox', { 'aria-label': 'בחר הכל' });

  const btnReset = h('md-filled-tonal-button', { text: 'אפס שימוש', onClick: async () => {
    if (!selected.size) return snack('לא נבחרו קודים', { error: true });
    const r = await A.resetUsage([...selected]); if (authFail(r)) return;
    snack(`אופס השימוש ב-${r.count} קודים`); load(); } }, h('md-icon', { slot: 'icon', text: 'restart_alt' }));
  const btnDel = h('md-outlined-button', { class: 'danger-outline', text: 'מחק נבחרים', onClick: async () => {
    if (!selected.size) return snack('לא נבחרו קודים', { error: true });
    if (!await confirmDialog({ title: 'מחיקת קודים', body: `למחוק ${selected.size} קודים? לא ניתן לשחזר.`, confirmText: 'מחק', danger: true })) return;
    const r = await A.deleteCodes([...selected]); if (authFail(r)) return;
    selected.clear(); snack(`נמחקו ${r.count} קודים`); load(); } }, h('md-icon', { slot: 'icon', text: 'delete' }));
  // הפעולות על קודים נבחרים פעילות רק כשיש בחירה
  function updateSel() {
    btnReset.disabled = btnDel.disabled = !selected.size;
    selCount.textContent = selected.size ? `${selected.size} נבחרו` : '';
  }
  const btnExp = h('md-text-button', { text: 'מחק פגי תוקף', onClick: async () => {
    if (!await confirmDialog({ title: 'מחיקת קודים שפג תוקפם', body: 'כל הקודים שתאריך התוקף שלהם עבר יימחקו.', confirmText: 'מחק', danger: true })) return;
    const r = await A.deleteExpired(); if (authFail(r)) return;
    snack(`נמחקו ${r.count} קודים`); load(); } });

  const filtered = () => {
    const q = search.value.trim().toLowerCase();
    return all.filter(c => !q || c.hint.includes(q) || (c.label || '').toLowerCase().includes(q) || c.folders.some(f => f.name.toLowerCase().includes(q)));
  };
  async function load() {
    const r = await A.listCodes(); if (authFail(r)) return;
    all = r.codes;
    for (const id of [...selected]) if (!all.some(c => c.id === id)) selected.delete(id);
    selAll.checked = false;
    draw(); updateSel();
  }
  function draw() {
    const rows = filtered();
    count.textContent = `${rows.length} מתוך ${all.length} קודים`;
    tbody.replaceChildren();
    if (!rows.length) {
      tbody.append(h('tr', {}, h('td', { colspan: 8, class: 'empty-cell', text: all.length ? 'אין תוצאות' : 'עוד לא הונפקו קודים. עבור ללשונית "הנפקה".' })));
      return;
    }
    for (const c of rows) {
      const cb = h('md-checkbox', { 'aria-label': 'בחר קוד', checked: selected.has(c.id) });
      cb.addEventListener('change', () => { cb.checked ? selected.add(c.id) : selected.delete(c.id); updateSel(); });
      const [stText, stClass] = STATUS[c.status];
      tbody.append(h('tr', {},
        h('td', {}, cb),
        h('td', { class: 'mono', dir: 'ltr', text: '•••• •••• ' + c.hint }),
        h('td', { text: c.label || '—' }),
        h('td', { class: 'folders-cell' }, ...(c.folders.length ? c.folders.map(f => h('div', { class: 'folder-name', title: f.path, text: f.name })) : [h('div', { class: 'muted', text: 'ללא תיקייה' })])),
        h('td', { text: c.expiryDate ? ltr(isoToHe(c.expiryDate)) : '—' }),
        h('td', { text: c.maxUses === 0 ? `${ltr(c.uses)} מתוך ללא הגבלה` : `${ltr(c.uses + ' / ' + c.maxUses)}` }),
        h('td', {}, h('span', { class: 'status ' + stClass, text: stText })),
        h('td', {}, h('md-icon-button', { 'aria-label': 'עריכה', title: 'עריכה', onClick: () => editDialog(c, load) }, icon('edit')))));
    }
  }
  selAll.addEventListener('change', () => {
    filtered().forEach(c => selAll.checked ? selected.add(c.id) : selected.delete(c.id));
    document.querySelectorAll('tbody md-checkbox').forEach(cb => { cb.checked = selAll.checked; });
    updateSel();
  });
  search.addEventListener('input', draw);
  load();

  return h('section', { class: 'panel' },
    h('div', { class: 'toolbar' }, search, selCount, btnReset, btnDel, btnExp),
    h('div', { class: 'info-line' }, icon('info'), h('span', { class: 'md-typescale-body-small muted', text: 'מטעמי אבטחה הקודים נשמרים מוצפנים ואינם ניתנים לצפייה אחרי ההנפקה – מוצגות רק 4 הספרות האחרונות.' })),
    h('div', { class: 'table-wrap card' },
      h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, h('th', {}, selAll), ...['קוד', 'תווית', 'תיקיות', 'תוקף', 'שימושים', 'סטטוס', ''].map(t => h('th', { text: t })))),
        tbody)),
    count);
}

// ─── ספריית תיקיות: דיאלוג הוספה/עריכה ובורר ──────────────────────────────
function folderDialog(existing, onSaved) {
  const name = limitLen(h('md-outlined-text-field', { label: 'שם התיקייה (יוצג גם לתלמיד)', value: existing?.name || '' }), 80);
  const pathF = h('md-outlined-text-field', { label: 'נתיב התיקייה', value: existing?.path || '', dir: 'ltr' });
  const note = limitLen(h('md-outlined-text-field', { label: 'הערה (אופציונלי)', value: existing?.note || '' }), 200);
  const err = h('div', { class: 'form-error md-typescale-body-medium', hidden: true });
  const pick = h('md-filled-tonal-button', { text: 'בחר תיקייה…', onClick: async () => {
    const r = await A.pickFolder(); if (authFail(r)) return;
    if (r.path) { pathF.value = r.path; if (!name.value.trim()) name.value = r.path.split(/[\\/]/).filter(Boolean).pop() || r.path; }
  } }, h('md-icon', { slot: 'icon', text: 'folder_open' }));
  const info = existing && existing.uses
    ? h('div', { class: 'info-line' }, icon('info'), h('span', { class: 'md-typescale-body-small', text: `התיקייה משמשת ${existing.uses} קודים. שינוי הנתיב יחול עליהם מיד.` })) : null;
  const dlg = h('md-dialog', { class: 'wide-dialog' },
    h('div', { slot: 'headline', text: existing ? 'עריכת תיקייה' : 'הוספת תיקייה' }),
    h('div', { slot: 'content', class: 'dialog-form' }, name, h('div', { class: 'row' }, pathF, pick), note, info, err),
    h('div', { slot: 'actions' },
      h('md-text-button', { text: 'ביטול', onClick: () => dlg.close() }),
      h('md-filled-button', { text: 'שמור', onClick: async () => {
        err.hidden = true;
        const body = { name: name.value, path: pathF.value.trim(), note: note.value };
        const r = existing ? await A.updateFolder(existing.id, body) : await A.addFolder(body);
        if (authFail(r)) return;
        if (!r.ok) { err.textContent = r.msg; err.hidden = false; return; }
        dlg.close(); snack(existing ? 'התיקייה עודכנה' : 'התיקייה נוספה');
        onSaved && onSaved(r.id || existing.id);
      } })));
  dlg.addEventListener('closed', () => dlg.remove());
  document.body.append(dlg); dlg.show();
}

/** בורר תיקיות מתוך הספרייה (תיבות סימון). selected = קבוצת מזהים. */
function folderPicker(initialIds, onChange = () => {}) {
  const selected = new Set(initialIds);
  const list = h('div', { class: 'folders-list' });
  let all = [];
  async function load() {
    const r = await A.listFolders(); if (authFail(r)) return;
    all = r.folders; for (const id of [...selected]) if (!all.some(f => f.id === id)) selected.delete(id);
    draw(); onChange();
  }
  function draw() {
    list.replaceChildren();
    if (!all.length) { list.append(h('div', { class: 'muted md-typescale-body-medium', text: 'עוד לא נוספו תיקיות. הוסף תיקייה ראשונה:' })); return; }
    for (const f of all) {
      const cb = h('md-checkbox', { 'aria-label': `בחר את ${f.name}`, checked: selected.has(f.id) });
      cb.addEventListener('change', () => { cb.checked ? selected.add(f.id) : selected.delete(f.id); onChange(); });
      list.append(h('label', { class: 'folder-row pick' }, cb,
        h('div', { class: 'folder-info' }, h('div', { class: 'folder-name', text: f.name }), h('div', { class: 'folder-path', dir: 'ltr', title: f.path, text: f.path })),
        f.exists ? null : h('span', { class: 'status st-expired', text: 'לא נמצאה' })));
    }
  }
  load();
  const add = h('md-text-button', { text: 'תיקייה חדשה…', onClick: () => folderDialog(null, async id => { selected.add(id); await load(); }) },
    h('md-icon', { slot: 'icon', text: 'create_new_folder' }));
  return { el: h('div', { class: 'folder-editor' }, list, h('div', { class: 'row' }, add)), ids: () => [...selected],
    names: () => all.filter(f => selected.has(f.id)).map(f => f.name) };
}

function editDialog(c, reload) {
  const ed = folderPicker(c.folderIds);
  const label = limitLen(h('md-outlined-text-field', { label: 'תווית', value: c.label || '' }), 80);
  const expiry = h('md-outlined-text-field', { label: 'תוקף עד (אופציונלי)', type: 'date', value: c.expiryDate || '' });
  const uses = h('md-outlined-text-field', { label: 'מספר שימושים (0 = ללא הגבלה)', type: 'number', min: 0, max: 1000, value: String(c.maxUses) });
  const err = h('div', { class: 'form-error md-typescale-body-medium', hidden: true });
  const dlg = h('md-dialog', { class: 'wide-dialog' },
    h('div', { slot: 'headline', text: `עריכת קוד ••••${c.hint}` }),
    h('div', { slot: 'content', class: 'dialog-form' }, label, h('div', { class: 'md-typescale-title-small', text: 'תיקיות' }), ed.el, expiry, uses, err),
    h('div', { slot: 'actions' },
      h('md-text-button', { text: 'ביטול', onClick: () => dlg.close() }),
      h('md-filled-button', { text: 'שמור', onClick: async () => {
        const r = await A.updateCode(c.id, { label: label.value, folderIds: ed.ids(), expiryDate: expiry.value || null, maxUses: uses.value === '' ? 1 : Number(uses.value) });
        if (authFail(r)) return;
        if (!r.ok) { err.textContent = r.msg; err.hidden = false; return; }
        dlg.close(); snack('עודכן בהצלחה'); reload();
      } })));
  dlg.addEventListener('closed', () => dlg.remove());
  document.body.append(dlg); dlg.show();
}

function IssuePanel() {
  const ed = folderPicker([], () => summarize());
  const label = limitLen(h('md-outlined-text-field', { label: 'תווית (למשל שם כיתה/קורס)' }), 80);
  const title = limitLen(h('md-outlined-text-field', { label: 'כותרת בעמוד ה-PDF', 'supporting-text': 'ריק = כמו התווית' }), 80);
  const count = h('md-outlined-text-field', { label: 'כמות קודים', type: 'number', min: 1, max: 500, value: '10' });
  const length = h('md-outlined-text-field', { label: 'אורך קוד', type: 'number', min: 8, max: 20, value: String(S.settings.codeLength || 12) });
  const uses = h('md-outlined-text-field', { label: 'מספר שימושים לקוד', type: 'number', min: 0, max: 1000, value: '1', 'supporting-text': '1 = חד-פעמי · 0 = ללא הגבלה' });
  const expiry = h('md-outlined-text-field', { label: 'תוקף עד (אופציונלי)', type: 'date' });
  const err = h('div', { class: 'form-error md-typescale-body-medium', hidden: true });
  const btn = h('md-filled-button', { text: 'הנפק ושמור PDF', onClick: submit }, h('md-icon', { slot: 'icon', text: 'picture_as_pdf' }));
  const summary = h('div', { class: 'info-line md-typescale-body-medium' });

  // סיכום של מה שעומד להיות מונפק, מתעדכן תוך כדי מילוי הטופס
  function summarize() {
    const n = Number(count.value), u = uses.value === '' ? 1 : Number(uses.value);
    const names = ed.names();
    const kind = u === 0 ? 'ללא הגבלת שימוש' : u === 1 ? 'חד-פעמיים' : `ל-${u} שימושים`;
    const where = !names.length ? 'בלי תיקייה (בחר לפחות אחת)' : names.length === 1 ? `לתיקייה "${names[0]}"` : `ל-${names.length} תיקיות`;
    const until = expiry.value ? `, בתוקף עד ${isoToHe(expiry.value)}` : ', ללא תאריך תפוגה';
    summary.replaceChildren(icon('summarize'), h('span', { text: `יונפקו ${n || 0} קודים ${kind} ${where}${until}.` }));
  }
  [count, uses, expiry].forEach(f => ['input', 'change'].forEach(ev => f.addEventListener(ev, summarize)));
  summarize();

  async function submit() {
    err.hidden = true; btn.disabled = true;
    const r = await A.issue({
      folderIds: ed.ids(), label: label.value.trim(), pageTitle: title.value.trim() || label.value.trim(),
      count: Number(count.value), codeLength: Number(length.value), expiryDate: expiry.value || null,
      maxUses: uses.value === '' ? 1 : Number(uses.value)
    });
    btn.disabled = false;
    if (authFail(r)) return;
    if (r.ok) { snack(`✓ הונפקו ${r.count} קודים והקובץ נפתח. שמור אותו – הקודים לא יוצגו שוב.`, { ms: 8000 }); S.adminShow('codes'); }
    else if (r.cancelled) snack(r.msg);
    else { err.textContent = r.msg || 'ההנפקה נכשלה'; err.hidden = false; }
  }

  return h('section', { class: 'panel' },
    h('div', { class: 'card form-card' },
      h('h2', { class: 'md-typescale-title-large', text: 'הנפקת קודים חדשים' }),
      h('div', { class: 'md-typescale-title-small', text: 'תיקיות שהקוד יפתח' }), ed.el,
      h('md-divider'),
      h('div', { class: 'grid2' }, label, title, count, length, uses, expiry),
      summary, err, h('div', { class: 'row end' }, btn),
      h('p', { class: 'md-typescale-body-small muted', text: 'הקודים נוצרים רק אחרי שה-PDF נשמר בהצלחה. אין דרך לראות אותם שוב לאחר מכן.' })));
}

// ─── לשונית תיקיות ────────────────────────────────────────────────────────
function FoldersPanel() {
  const tbody = h('tbody');
  const count = h('span', { class: 'md-typescale-body-medium muted' });
  async function load() {
    const r = await A.listFolders(); if (authFail(r)) return;
    count.textContent = `${r.folders.length} תיקיות`;
    tbody.replaceChildren();
    if (!r.folders.length) tbody.append(h('tr', {}, h('td', { colspan: 6, class: 'empty-cell', text: 'עוד לא נוספו תיקיות. לחץ "הוסף תיקייה".' })));
    for (const f of r.folders) {
      tbody.append(h('tr', {},
        h('td', { class: 'folder-name', text: f.name }),
        h('td', { class: 'folders-cell' }, h('div', { class: 'folder-tag', title: f.path, text: f.path })),
        h('td', { text: f.note || '—' }),
        h('td', { text: String(f.uses) }),
        h('td', {}, h('span', { class: 'status ' + (f.exists ? 'st-active' : 'st-expired'), text: f.exists ? 'קיימת' : 'לא נמצאה' })),
        h('td', {},
          h('md-icon-button', { 'aria-label': `עריכת ${f.name}`, title: 'עריכה', onClick: () => folderDialog(f, load) }, icon('edit')),
          h('md-icon-button', { 'aria-label': `הסרת ${f.name}`, title: 'הסרה', onClick: () => remove(f) }, icon('delete')))));
    }
  }
  async function remove(f) {
    const inUse = f.uses > 0;
    const ok = await confirmDialog({
      title: 'הסרת תיקייה מהרשימה',
      body: inUse
        ? `התיקייה "${f.name}" משמשת ${f.uses} קודים. אם תסיר אותה, היא תוסר גם מהקודים האלה (קוד שיישאר בלי תיקיות לא יוכל להיכנס). הקבצים עצמם לא יימחקו.`
        : `להסיר את "${f.name}" מהרשימה? הקבצים עצמם לא יימחקו.`,
      confirmText: 'הסר', danger: true
    });
    if (!ok) return;
    const r = await A.removeFolder(f.id, { detach: inUse }); if (authFail(r)) return;
    if (!r.ok) { snack(r.msg || 'ההסרה נכשלה', { error: true }); return; }
    snack(inUse ? `התיקייה הוסרה מ-${r.detached} קודים` : 'התיקייה הוסרה'); load();
  }
  load();
  return h('section', { class: 'panel' },
    h('div', { class: 'toolbar' }, h('span', { class: 'md-typescale-title-medium grow', text: 'התיקיות שלי' }),
      h('md-filled-button', { text: 'הוסף תיקייה', onClick: () => folderDialog(null, load) }, h('md-icon', { slot: 'icon', text: 'create_new_folder' }))),
    h('div', { class: 'info-line' }, icon('info'), h('span', { class: 'md-typescale-body-small muted', text: 'הקודים מצביעים על התיקיות כאן. עריכת נתיב של תיקייה מעדכנת מיד את כל הקודים שמשתמשים בה. השם שמוגדר כאן מוצג לתלמיד.' })),
    h('div', { class: 'table-wrap card' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, ...['שם', 'נתיב', 'הערה', 'קודים', 'סטטוס', ''].map(t => h('th', { text: t })))), tbody)),
    count);
}

function LogPanel() {
  const tbody = h('tbody');
  async function load() {
    const r = await A.readLog(); if (authFail(r)) return;
    tbody.replaceChildren();
    if (!r.entries.length) tbody.append(h('tr', {}, h('td', { colspan: 3, class: 'empty-cell', text: 'היומן ריק' })));
    for (const e of r.entries) {
      const [ic, text] = LOG_LABELS[e.type] || ['info', e.type];
      const parts = [];
      if (e.label) parts.push(e.label);
      if (e.hint) parts.push('••••' + e.hint);
      if (e.name) parts.push(e.name + (e.files > 1 ? ` (${e.files} קבצים)` : ''));
      if (e.count) parts.push(e.count === 1 ? 'קוד אחד' : `${e.count} קודים`);
      if (e.reason) parts.push(REASONS[e.reason] || e.reason);
      tbody.append(h('tr', {}, h('td', { text: ltr(formatDate(e.t)) }), h('td', {}, h('span', { class: 'log-type' }, icon(ic), text)), h('td', { text: parts.join(' · ') || '—' })));
    }
  }
  load();
  return h('section', { class: 'panel' },
    h('div', { class: 'toolbar' }, h('span', { class: 'md-typescale-title-medium grow', text: 'יומן פעילות (300 האירועים האחרונים)' }),
      h('md-filled-tonal-button', { text: 'רענון', onClick: load }, h('md-icon', { slot: 'icon', text: 'refresh' }))),
    h('div', { class: 'table-wrap card' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, ...['זמן', 'אירוע', 'פרטים'].map(t => h('th', { text: t })))), tbody)));
}

function SettingsPanel() {
  const st = S.settings;
  const cl = h('md-outlined-text-field', { label: 'אורך קוד ברירת מחדל', type: 'number', min: 8, max: 20, value: String(st.codeLength) });
  // זמני הניתוק מוצגים בדקות ונשמרים בשניות
  const si = h('md-outlined-text-field', { label: 'ניתוק תלמיד לאחר חוסר פעילות (דקות)', type: 'number', min: 0.5, max: 60, step: 0.5, value: String(st.studentIdleSeconds / 60), 'supporting-text': 'בין חצי דקה ל-60 דקות' });
  const ai = h('md-outlined-text-field', { label: 'ניתוק מנהל לאחר חוסר פעילות (דקות)', type: 'number', min: 1, max: 60, step: 0.5, value: String(st.adminIdleSeconds / 60), 'supporting-text': 'בין דקה ל-60 דקות' });
  const msg1 = h('div', { class: 'form-error md-typescale-body-medium', hidden: true });
  const save = h('md-filled-button', { text: 'שמור הגדרות', onClick: async () => {
    msg1.hidden = true;
    const sMin = Number(si.value), aMin = Number(ai.value);
    const bad = !(sMin >= 0.5 && sMin <= 60) ? 'זמן הניתוק לתלמיד צריך להיות בין חצי דקה ל-60 דקות'
      : !(aMin >= 1 && aMin <= 60) ? 'זמן הניתוק למנהל צריך להיות בין דקה ל-60 דקות' : '';
    if (bad) { msg1.textContent = bad; msg1.hidden = false; return; }
    const r = await A.saveSettings({ codeLength: Number(cl.value), studentIdleSeconds: Math.round(sMin * 60), adminIdleSeconds: Math.round(aMin * 60) });
    if (authFail(r)) return;
    if (r.ok) { S.settings = r.settings; snack('ההגדרות נשמרו'); } else { msg1.textContent = r.msg; msg1.hidden = false; }
  } });

  const oldP = h('md-outlined-text-field', { label: 'סיסמה נוכחית', type: 'password', autocomplete: 'current-password' });
  const newP = h('md-outlined-text-field', { label: 'סיסמה חדשה', type: 'password', autocomplete: 'new-password', 'supporting-text': 'לפחות 6 תווים' });
  const newP2 = h('md-outlined-text-field', { label: 'אימות סיסמה חדשה', type: 'password', autocomplete: 'new-password' });
  const msg2 = h('div', { class: 'form-error md-typescale-body-medium', hidden: true });
  const change = h('md-filled-tonal-button', { text: 'החלף סיסמה', onClick: async () => {
    msg2.hidden = true;
    if (newP.value !== newP2.value) { msg2.textContent = 'הסיסמאות החדשות אינן זהות'; msg2.hidden = false; return; }
    const r = await A.changePassword(oldP.value, newP.value);
    if (authFail(r)) return;
    if (r.ok) { oldP.value = newP.value = newP2.value = ''; snack('הסיסמה הוחלפה'); } else { msg2.textContent = r.msg; msg2.hidden = false; }
  } });

  return h('section', { class: 'panel' },
    h('div', { class: 'card form-card' },
      h('h2', { class: 'md-typescale-title-large', text: 'אבטחה ושימוש' }), cl, si, ai, msg1, h('div', { class: 'row end' }, save)),
    h('div', { class: 'card form-card' },
      h('h2', { class: 'md-typescale-title-large', text: 'החלפת סיסמת ניהול' }), oldP, newP, newP2, msg2, h('div', { class: 'row end' }, change)));
}
