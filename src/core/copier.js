'use strict';
/**
 * העתקה לדיסק היעד. מקבל נתיבי מקור כבר מאומתים ושורש יעד מאומת.
 * לא עוקב אחרי קישורים סימבוליים, לא דורס (name (1)), ומנקה תיקייה חלקית אם ההעתקה נכשלה.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { sanitizeName, uniqueName } = require('./pathguard');

async function scan(src) {
  let files = 0, bytes = 0;
  const walk = async dir => {
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) { files++; bytes += (await fsp.stat(p)).size; }
    }
  };
  await walk(src);
  return { files, bytes };
}

async function copyTree(src, dest, tick) {
  await fsp.mkdir(dest, { recursive: true });
  for (const e of await fsp.readdir(src, { withFileTypes: true })) {
    if (e.isSymbolicLink()) continue;
    const s = path.join(src, e.name);
    const d = path.join(dest, sanitizeName(e.name, 'file'));
    if (e.isDirectory()) await copyTree(s, d, tick);
    else if (e.isFile()) { await fsp.copyFile(s, d, fs.constants.COPYFILE_EXCL); tick(e.name); }
  }
}

function friendlyError(e) {
  switch (e && e.code) {
    case 'ENOSPC': return 'אין מספיק מקום בדיסק היעד';
    case 'EACCES': case 'EPERM': return 'אין הרשאת כתיבה לדיסק היעד';
    case 'EROFS': return 'הדיסק מוגן מפני כתיבה';
    case 'ENOENT': return 'הדיסק או הקובץ אינם זמינים יותר';
    case 'EBUSY': return 'הקובץ בשימוש ולא ניתן להעתיקו כרגע';
    default: return 'ההעתקה נכשלה' + (e && e.message ? ` (${e.message})` : '');
  }
}

async function copyItem(srcReal, driveRoot, customName, onProgress = () => {}) {
  let created = null;
  try {
    const st = await fsp.lstat(srcReal);
    if (st.isSymbolicLink()) return { ok: false, msg: 'לא ניתן להעתיק קישור סימבולי' };

    if (st.isFile()) {
      const name = uniqueName(driveRoot, sanitizeName(path.basename(srcReal), 'file'));
      const dest = path.join(driveRoot, name);
      onProgress({ done: 0, total: 1, name });
      await fsp.copyFile(srcReal, dest, fs.constants.COPYFILE_EXCL);
      onProgress({ done: 1, total: 1, name });
      return { ok: true, dest, files: 1, bytes: st.size };
    }

    if (st.isDirectory()) {
      const name = uniqueName(driveRoot, sanitizeName(customName || path.basename(srcReal)));
      const dest = path.join(driveRoot, name);
      const { files, bytes } = await scan(srcReal);
      if (!files) return { ok: false, msg: 'התיקייה ריקה – אין מה להעתיק' };
      created = dest;
      let done = 0;
      await copyTree(srcReal, dest, n => { done++; onProgress({ done, total: files, name: n }); });
      created = null;
      return { ok: true, dest, files, bytes };
    }
    return { ok: false, msg: 'סוג פריט לא נתמך' };
  } catch (e) {
    if (created) { try { await fsp.rm(created, { recursive: true, force: true }); } catch {} }
    return { ok: false, msg: friendlyError(e) };
  }
}

module.exports = { copyItem, friendlyError };
