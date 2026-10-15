'use strict';
/**
 * Vault – שכבת הנתונים והחוקים של SecureCopy (ללא תלות ב-Electron, ניתנת לבדיקה).
 *  - קודי תלמידים נשמרים כגיבוב בלבד (SHA-256 + salt). בטבלה מוצגות 4 הספרות האחרונות.
 *  - סיסמת ניהול: scrypt. אין סיסמת ברירת מחדל – בהפעלה הראשונה מגדירים אחת.
 *  - נעילה מדורגת אחרי ניסיונות כושלים (נשמרת גם אחרי הפעלה מחדש).
 *  - שימוש חד-פעמי: קוד "נצרך" בהעתקה המוצלחת הראשונה (maxUses; 0 = ללא הגבלה).
 *  - כתיבה אטומית + גיבוי אחרון; יומן פעילות בקובץ נפרד.
 */
const fs = require('fs');
const path = require('path');
const { randHex, hashCode, hashPassword, verifyPassword, randomDigits } = require('./crypto');
const { realOrNull } = require('./pathguard');

const DEFAULTS = Object.freeze({ codeLength: 12, studentIdleSeconds: 300, adminIdleSeconds: 600 });
const LIMITS = Object.freeze({ minCodeLength: 8, maxCodeLength: 20, maxBatch: 500, minPassword: 6 });
const LOCK_AFTER = 5;
const LOCK_BASE_MS = 30_000;
const LOCK_MAX_MS = 15 * 60_000;
const LOG_MAX_BYTES = 1_000_000;

const pathKey = p => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
const cleanName = s => String(s ?? '').trim().slice(0, 80);
const dirExists = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

class Vault {
  constructor({ dataDir, now = () => Date.now() }) {
    this.dir = dataDir;
    this.now = now;
    this.file = path.join(dataDir, 'data.json');
    this.logFile = path.join(dataDir, 'activity.log');
    this.data = null;
    this.loadNotice = null;
  }

  load() {
    fs.mkdirSync(this.dir, { recursive: true });
    let raw = null;
    for (const f of [this.file, this.file + '.bak']) {
      if (!fs.existsSync(f)) continue;
      try { raw = JSON.parse(fs.readFileSync(f, 'utf8')); if (f.endsWith('.bak')) this.loadNotice = 'restored-backup'; break; }
      catch { /* ננסה את הגיבוי */ }
    }
    if (raw && raw.version === undefined && (raw.codes || raw.adminCode)) raw = this._migrateV1(raw);
    this.data = this._normalize(raw);
    return this;
  }

  _normalize(raw) {
    const d = raw && typeof raw === 'object' ? raw : {};
    const out = {
      version: 3,
      salt: typeof d.salt === 'string' && d.salt ? d.salt : randHex(16),
      admin: d.admin && d.admin.hash && d.admin.salt ? d.admin : null,
      settings: { ...DEFAULTS, ...(d.settings || {}) },
      folders: d.folders && typeof d.folders === 'object' ? d.folders : {},
      codes: d.codes && typeof d.codes === 'object' ? d.codes : {},
      security: {
        code:  { fails: 0, lockedUntil: 0, ...(d.security?.code  || {}) },
        admin: { fails: 0, lockedUntil: 0, ...(d.security?.admin || {}) }
      }
    };
    // המרה: קודים שמחזיקים נתיבים ישירים (גרסאות קודמות) הופכים להפניות לספריית התיקיות
    const byPath = new Map(Object.values(out.folders).map(f => [pathKey(f.path), f.id]));
    for (const r of Object.values(out.codes)) {
      if (Array.isArray(r.folderIds)) continue;
      r.folderIds = [];
      for (const p of (Array.isArray(r.folders) ? r.folders : [])) {
        const key = pathKey(p);
        let id = byPath.get(key);
        if (!id) {
          id = randHex(6);
          out.folders[id] = { id, name: path.basename(p) || p, path: p, note: '', createdAt: this.now() };
          byPath.set(key, id);
        }
        if (!r.folderIds.includes(id)) r.folderIds.push(id);
      }
      delete r.folders;
    }
    return out;
  }

  /** המרה מהגרסה הישנה (קודים וסיסמה בטקסט גלוי). */
  _migrateV1(old) {
    try { fs.copyFileSync(this.file, path.join(this.dir, 'data.v1.backup.json')); } catch {}
    const salt = randHex(16);
    const codes = {};
    for (const [code, e] of Object.entries(old.codes || {})) {
      const folders = (Array.isArray(e.folder) ? e.folder : (e.folder ? [e.folder] : [])).filter(Boolean);
      codes[hashCode(salt, code)] = {
        id: randHex(6), hint: String(code).slice(-4), label: e.label || '', folders,
        expiryDate: e.expiryDate || null,
        maxUses: 0, uses: 0,          // קודים שכבר חולקו נשארים ללא הגבלה, כדי לא לשבור אותם
        createdAt: this.now(), lastUsedAt: null
      };
    }
    const admin = old.adminCode && old.adminCode !== '999999' ? hashPassword(old.adminCode) : null;
    this.loadNotice = 'migrated-v1';
    return { version: 2, salt, admin, settings: { ...DEFAULTS, codeLength: old.codeLength || DEFAULTS.codeLength }, codes };
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    if (fs.existsSync(this.file)) { try { fs.copyFileSync(this.file, this.file + '.bak'); } catch {} }
    fs.renameSync(tmp, this.file);
  }

  _lockState(bucket) {
    const s = this.data.security[bucket];
    const left = s.lockedUntil - this.now();
    return left > 0 ? { locked: true, retryAfter: Math.ceil(left / 1000) } : { locked: false, retryAfter: 0 };
  }
  _fail(bucket) {
    const s = this.data.security[bucket];
    s.fails += 1;
    if (s.fails >= LOCK_AFTER) s.lockedUntil = this.now() + Math.min(LOCK_BASE_MS * 2 ** (s.fails - LOCK_AFTER), LOCK_MAX_MS);
    this.save();
    return this._lockState(bucket);
  }
  _clearFails(bucket) {
    const s = this.data.security[bucket];
    if (s.fails || s.lockedUntil) { s.fails = 0; s.lockedUntil = 0; this.save(); }
  }

  needsSetup() { return !this.data.admin; }

  setupAdmin(password) {
    if (this.data.admin) return { ok: false, msg: 'כבר הוגדרה סיסמת ניהול' };
    const err = this._passwordError(password);
    if (err) return { ok: false, msg: err };
    this.data.admin = hashPassword(password);
    this.save();
    this.log('admin_setup');
    return { ok: true };
  }

  verifyAdmin(password) {
    const lock = this._lockState('admin');
    if (lock.locked) return { ok: false, ...lock, msg: 'יותר מדי ניסיונות' };
    if (this.data.admin && verifyPassword(String(password ?? ''), this.data.admin)) {
      this._clearFails('admin');
      this.log('admin_login');
      return { ok: true };
    }
    const after = this._fail('admin');
    this.log('admin_login_fail');
    return { ok: false, ...after, msg: 'סיסמה שגויה' };
  }

  changeAdminPassword(oldPassword, newPassword) {
    if (!this.data.admin || !verifyPassword(String(oldPassword ?? ''), this.data.admin)) return { ok: false, msg: 'הסיסמה הנוכחית שגויה' };
    const err = this._passwordError(newPassword);
    if (err) return { ok: false, msg: err };
    this.data.admin = hashPassword(newPassword);
    this.save();
    this.log('admin_password_changed');
    return { ok: true };
  }

  _passwordError(p) {
    if (typeof p !== 'string' || p.length < LIMITS.minPassword) return `סיסמה חייבת להכיל לפחות ${LIMITS.minPassword} תווים`;
    if (p === '999999' || p === '123456') return 'סיסמה קלה מדי';
    return null;
  }

  getSettings() { return { ...this.data.settings }; }

  updateSettings(patch) {
    const s = this.data.settings;
    const num = (v, lo, hi) => { const n = Math.trunc(Number(v)); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };
    const cl = num(patch.codeLength, LIMITS.minCodeLength, LIMITS.maxCodeLength);
    const si = num(patch.studentIdleSeconds, 30, 3600);
    const ai = num(patch.adminIdleSeconds, 60, 3600);
    if (patch.codeLength !== undefined && cl === null) return { ok: false, msg: `אורך קוד: ${LIMITS.minCodeLength}–${LIMITS.maxCodeLength}` };
    if (patch.studentIdleSeconds !== undefined && si === null) return { ok: false, msg: 'זמן חוסר פעילות לתלמיד: 30–3600 שניות' };
    if (patch.adminIdleSeconds !== undefined && ai === null) return { ok: false, msg: 'זמן חוסר פעילות למנהל: 60–3600 שניות' };
    if (cl !== null) s.codeLength = cl;
    if (si !== null) s.studentIdleSeconds = si;
    if (ai !== null) s.adminIdleSeconds = ai;
    this.save();
    return { ok: true, settings: this.getSettings() };
  }

  /** מכין אצווה בזיכרון בלבד; commitBatch שומר אחרי שה-PDF נכתב בהצלחה. */
  prepareBatch({ folderIds, label, count, codeLength, expiryDate, maxUses }) {
    const n = Math.trunc(Number(count));
    const len = Math.trunc(Number(codeLength ?? this.data.settings.codeLength));
    const uses = maxUses === undefined || maxUses === null || maxUses === '' ? 1 : Math.trunc(Number(maxUses));
    if (!Array.isArray(folderIds) || !folderIds.length) return { ok: false, msg: 'יש לבחור לפחות תיקייה אחת' };
    if (!folderIds.every(id => this.data.folders[id])) return { ok: false, msg: 'אחת התיקיות שנבחרו כבר לא קיימת ברשימה' };
    if (!(n >= 1 && n <= LIMITS.maxBatch)) return { ok: false, msg: `כמות בין 1 ל-${LIMITS.maxBatch}` };
    if (!(len >= LIMITS.minCodeLength && len <= LIMITS.maxCodeLength)) return { ok: false, msg: `אורך קוד: ${LIMITS.minCodeLength}–${LIMITS.maxCodeLength}` };
    if (!(uses >= 0 && uses <= 1000)) return { ok: false, msg: 'מספר שימושים: 0 (ללא הגבלה) עד 1000' };
    if (expiryDate && !parseDate(expiryDate)) return { ok: false, msg: 'תאריך תוקף לא תקין' };

    const items = [];
    const seen = new Set();
    while (items.length < n) {
      const code = randomDigits(len);
      const digest = hashCode(this.data.salt, code);
      if (seen.has(digest) || this.data.codes[digest]) continue;
      seen.add(digest);
      items.push({
        code, digest,
        record: {
          id: randHex(6), hint: code.slice(-4), label: String(label || '').slice(0, 80),
          folderIds: [...new Set(folderIds)], expiryDate: expiryDate || null,
          maxUses: uses, uses: 0, createdAt: this.now(), lastUsedAt: null
        }
      });
    }
    return { ok: true, items };
  }

  commitBatch(items) {
    for (const it of items) this.data.codes[it.digest] = it.record;
    this.save();
    this.log('codes_issued', { count: items.length, label: items[0]?.record.label || '' });
  }

  listCodes() {
    const t = this.now();
    return Object.values(this.data.codes)
      .map(r => ({ ...r, folders: this.foldersByIds(r.folderIds).map(({ id, name, path: p }) => ({ id, name, path: p })), status: statusOf(r, t) }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  _findById(id) {
    for (const [digest, r] of Object.entries(this.data.codes)) if (r.id === id) return [digest, r];
    return [null, null];
  }

  updateCode(id, patch) {
    const [, r] = this._findById(id);
    if (!r) return { ok: false, msg: 'הקוד לא נמצא' };
    if (patch.folderIds !== undefined) {
      if (!Array.isArray(patch.folderIds) || !patch.folderIds.length) return { ok: false, msg: 'יש להשאיר לפחות תיקייה אחת' };
      if (!patch.folderIds.every(fid => this.data.folders[fid])) return { ok: false, msg: 'אחת התיקיות שנבחרו כבר לא קיימת ברשימה' };
      r.folderIds = [...new Set(patch.folderIds)];
    }
    if (patch.label !== undefined) r.label = String(patch.label).slice(0, 80);
    if (patch.expiryDate !== undefined) {
      if (patch.expiryDate && !parseDate(patch.expiryDate)) return { ok: false, msg: 'תאריך תוקף לא תקין' };
      r.expiryDate = patch.expiryDate || null;
    }
    if (patch.maxUses !== undefined) {
      const n = Math.trunc(Number(patch.maxUses));
      if (!(n >= 0 && n <= 1000)) return { ok: false, msg: 'מספר שימושים לא תקין' };
      r.maxUses = n;
    }
    this.save();
    this.log('code_updated', { hint: r.hint });
    return { ok: true };
  }

  resetUsage(ids) {
    let n = 0;
    for (const id of ids) { const [, r] = this._findById(id); if (r) { r.uses = 0; n++; } }
    if (n) { this.save(); this.log('usage_reset', { count: n }); }
    return { ok: true, count: n };
  }

  deleteCodes(ids) {
    const set = new Set(ids);
    let n = 0;
    for (const [digest, r] of Object.entries(this.data.codes)) if (set.has(r.id)) { delete this.data.codes[digest]; n++; }
    if (n) { this.save(); this.log('codes_deleted', { count: n }); }
    return { ok: true, count: n };
  }

  deleteExpired() {
    const t = this.now();
    return this.deleteCodes(Object.values(this.data.codes).filter(r => statusOf(r, t) === 'expired').map(r => r.id));
  }

  // ─── ספריית תיקיות ─────────────────────────────────────────────────────
  foldersByIds(ids) { return (ids || []).map(id => this.data.folders[id]).filter(Boolean); }

  _folderUses(id) { return Object.values(this.data.codes).filter(r => r.folderIds.includes(id)).length; }

  listFolders() {
    return Object.values(this.data.folders)
      .map(f => ({ ...f, uses: this._folderUses(f.id), exists: dirExists(f.path) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'he'));
  }

  /** p חייב להיות נתיב מאומת (realpath) – האימות נעשה בתהליך הראשי. */
  addFolder({ name, path: p, note }) {
    if (typeof p !== 'string' || !p) return { ok: false, msg: 'נתיב לא תקין' };
    const dup = Object.values(this.data.folders).find(f => pathKey(f.path) === pathKey(p));
    if (dup) return { ok: false, msg: `התיקייה כבר קיימת ברשימה (${dup.name})`, existingId: dup.id };
    const id = randHex(6);
    this.data.folders[id] = { id, name: cleanName(name) || path.basename(p) || p, path: p, note: String(note || '').slice(0, 200), createdAt: this.now() };
    this.save();
    this.log('folder_added', { name: this.data.folders[id].name });
    return { ok: true, id };
  }

  /** שינוי נתיב מתעדכן אוטומטית בכל הקודים שמשתמשים בתיקייה, כי הם מצביעים עליה לפי מזהה. */
  updateFolder(id, patch) {
    const f = this.data.folders[id];
    if (!f) return { ok: false, msg: 'התיקייה לא נמצאה ברשימה' };
    if (patch.path !== undefined) {
      if (typeof patch.path !== 'string' || !patch.path) return { ok: false, msg: 'נתיב לא תקין' };
      const dup = Object.values(this.data.folders).find(o => o.id !== id && pathKey(o.path) === pathKey(patch.path));
      if (dup) return { ok: false, msg: `נתיב זה כבר קיים ברשימה (${dup.name})` };
      f.path = patch.path;
    }
    if (patch.name !== undefined) f.name = cleanName(patch.name) || path.basename(f.path) || f.path;
    if (patch.note !== undefined) f.note = String(patch.note || '').slice(0, 200);
    this.save();
    this.log('folder_updated', { name: f.name, count: this._folderUses(id) });
    return { ok: true, uses: this._folderUses(id) };
  }

  /** תיקייה שמשמשת קודים לא נמחקת אלא אם ביקשו במפורש (detach), ואז היא מוסרת גם מהקודים. */
  removeFolder(id, { detach = false } = {}) {
    const f = this.data.folders[id];
    if (!f) return { ok: false, msg: 'התיקייה לא נמצאה ברשימה' };
    const uses = this._folderUses(id);
    if (uses && !detach) return { ok: false, inUse: uses, msg: `התיקייה משמשת ${uses} קודים` };
    for (const r of Object.values(this.data.codes)) r.folderIds = r.folderIds.filter(x => x !== id);
    delete this.data.folders[id];
    this.save();
    this.log('folder_removed', { name: f.name, count: uses });
    return { ok: true, detached: uses };
  }

  checkCode(code) {
    const lock = this._lockState('code');
    if (lock.locked) return { ok: false, ...lock, msg: 'יותר מדי ניסיונות' };

    const clean = typeof code === 'string' && /^\d{4,32}$/.test(code) ? code : null;
    const digest = clean ? hashCode(this.data.salt, clean) : null;
    const r = digest ? this.data.codes[digest] : null;
    if (!r) {
      const after = this._fail('code');
      this.log('login_fail');
      return { ok: false, ...after, msg: 'קוד שגוי' };
    }
    this._clearFails('code');

    const st = statusOf(r, this.now());
    if (st === 'expired') { this.log('login_denied', { hint: r.hint, label: r.label, reason: 'expired' }); return { ok: false, msg: `פג תוקף הקוד (${r.expiryDate})` }; }
    if (st === 'used')    { this.log('login_denied', { hint: r.hint, label: r.label, reason: 'used' });    return { ok: false, msg: 'הקוד כבר נוצל' }; }

    if (!r.folderIds.length) return { ok: false, msg: 'לא שויכה תיקייה לקוד זה' };
    const folders = [];
    for (const f of this.foldersByIds(r.folderIds)) {
      const real = realOrNull(f.path);
      if (real && dirExists(real) && !folders.some(x => x.path === real)) folders.push({ name: f.name, path: real });
    }
    if (!folders.length) return { ok: false, msg: 'התיקייה לא נמצאה במחשב' };
    const roots = folders.map(f => f.path);

    this.log('login', { hint: r.hint, label: r.label });
    return { ok: true, id: r.id, hint: r.hint, label: r.label, maxUses: r.maxUses, roots, folders };
  }

  markUsed(id) {
    const [, r] = this._findById(id);
    if (!r) return;
    r.uses += 1;
    r.lastUsedAt = this.now();
    this.save();
  }

  log(type, detail = {}) {
    try {
      if (fs.existsSync(this.logFile) && fs.statSync(this.logFile).size > LOG_MAX_BYTES) {
        fs.renameSync(this.logFile, path.join(this.dir, 'activity.old.log'));
      }
      fs.appendFileSync(this.logFile, JSON.stringify({ t: this.now(), type, ...detail }) + '\n', 'utf8');
    } catch { /* יומן הוא best-effort */ }
  }

  readLog(limit = 300) {
    try {
      const lines = fs.readFileSync(this.logFile, 'utf8').split('\n').filter(Boolean);
      return lines.slice(-limit).reverse().map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  }
}

function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], 23, 59, 59, 999);
  return d.getMonth() === +m[2] - 1 ? d : null;
}

function statusOf(r, nowMs) {
  const exp = r.expiryDate ? parseDate(r.expiryDate) : null;
  if (exp && nowMs > exp.getTime()) return 'expired';
  if (r.maxUses > 0 && r.uses >= r.maxUses) return 'used';
  return 'active';
}

module.exports = { Vault, DEFAULTS, LIMITS, parseDate, statusOf };
