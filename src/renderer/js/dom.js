// עזרי DOM. אף ערך מהנתונים לא נכנס ל-innerHTML – רק textContent / תכונות.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value' || k === 'checked' || k === 'selected' || k === 'disabled') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}

// בידי: מספרים ויחידות (4.3 MB, 0 / 1) מוצגים כגוש LTR אחד.
// שם קובץ מבודד (FSI): הכיוון נקבע לפי האות החזקה הראשונה, כך ש-"סיכום שיעור.pdf" נשאר בסדר הטבעי ו-"Lesson 1.pdf" מוצג משמאל לימין.
export const ltr = s => `\u2066${s}\u2069`;
export const bidiName = n => `\u2068${n}\u2069`;

export const icon = name => h('md-icon', { text: name });

// הגבלת אורך בלי maxlength: ב-RTL מונה התווים של md-outlined-text-field מוצג הפוך ("80 / 17")
export function limitLen(field, n) {
  field.addEventListener('input', () => { if (field.value.length > n) field.value = field.value.slice(0, n); });
  return field;
}

export function formatSize(bytes) {
  if (!bytes) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${parseFloat((bytes / 1024 ** i).toFixed(1))} ${u[i]}`;
}

export const formatDate = ms => ms ? new Date(ms).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' }) : '—';
export const isoToHe = iso => { if (!iso) return '—'; const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };

const FILE_ICONS = {
  pdf: 'picture_as_pdf', doc: 'description', docx: 'description', txt: 'article', rtf: 'article',
  xls: 'table_chart', xlsx: 'table_chart', csv: 'table_chart', ppt: 'slideshow', pptx: 'slideshow',
  mp4: 'movie', avi: 'movie', mkv: 'movie', mov: 'movie', mp3: 'audio_file', wav: 'audio_file', m4a: 'audio_file',
  jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image',
  zip: 'folder_zip', rar: 'folder_zip', '7z': 'folder_zip', exe: 'terminal', msi: 'terminal'
};
export const fileIcon = name => FILE_ICONS[(name.split('.').pop() || '').toLowerCase()] || 'draft';

let snackTimer;
export function snack(msg, { error = false, ms = 4000 } = {}) {
  let el = $('#snackbar');
  if (!el) { el = h('div', { id: 'snackbar', role: 'status', 'aria-live': 'polite' }); document.body.append(el); }
  el.textContent = msg;
  el.className = 'snackbar show' + (error ? ' error' : '');
  clearTimeout(snackTimer);
  snackTimer = setTimeout(() => el.classList.remove('show'), ms);
}

export function hideSnack() {
  const el = $('#snackbar');
  clearTimeout(snackTimer);
  if (el) el.classList.remove('show');
}

export function confirmDialog({ title, body, confirmText = 'אישור', danger = false }) {
  return new Promise(resolve => {
    const dlg = h('md-dialog', {},
      h('div', { slot: 'headline', text: title }),
      h('div', { slot: 'content', text: body }),
      h('div', { slot: 'actions' },
        h('md-text-button', { text: 'ביטול', onClick: () => dlg.close('cancel') }),
        h('md-filled-button', { class: danger ? 'danger' : '', text: confirmText, onClick: () => dlg.close('ok') })));
    dlg.addEventListener('closed', () => { resolve(dlg.returnValue === 'ok'); dlg.remove(); });
    document.body.append(dlg);
    dlg.show();
  });
}
