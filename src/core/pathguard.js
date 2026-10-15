'use strict';
/**
 * pathguard – הגנה על נתיבים.
 * כל פעולת קבצים של תלמיד עוברת כאן: הנתיב חייב להיות בתוך אחת מתיקיות הקוד.
 * ההשוואה נעשית על נתיב אמיתי (realpath), כך ש-.. וקישורים סימבוליים/Junction לא עוקפים אותה.
 */
const fs = require('fs');
const path = require('path');

function realOrNull(p) {
  try { return fs.realpathSync.native(p); } catch { return null; }
}

function isInside(root, target) {
  if (!root || !target) return false;
  const rel = path.relative(root, target);
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  return rel.split(path.sep)[0] !== '..';
}

function resolveInside(roots, p) {
  if (typeof p !== 'string' || !p || p.includes('\0')) return null;
  const real = realOrNull(path.resolve(p));
  if (!real) return null;
  return roots.some(r => isInside(r, real)) ? real : null;
}

function sanitizeName(name, fallback = 'תיקייה') {
  let s = String(name ?? '').normalize('NFC');
  s = s.replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_');
  s = s.replace(/[. ]+$/g, '');
  s = s.trim();
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(s)) s = '_' + s;
  if (!s || s === '.' || s === '..') s = fallback;
  return s.slice(0, 120);
}

function uniqueName(dir, name) {
  if (!fs.existsSync(path.join(dir, name))) return name;
  const ext = path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  for (let i = 1; i < 10000; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
  throw new Error('לא נמצא שם פנוי ביעד');
}

function isFilesystemRoot(p) {
  const resolved = path.resolve(p);
  return path.parse(resolved).root === resolved;
}

module.exports = { realOrNull, isInside, resolveInside, sanitizeName, uniqueName, isFilesystemRoot };
