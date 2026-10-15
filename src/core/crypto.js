'use strict';
const crypto = require('crypto');

const randHex = (n = 16) => crypto.randomBytes(n).toString('hex');

/** גיבוב קוד תלמיד: SHA-256 עם salt ייחודי להתקנה (חיפוש לפי מפתח, לכן אין צורך ב-KDF איטי). */
function hashCode(salt, code) {
  return crypto.createHash('sha256').update(`${salt}:${code}`).digest('hex');
}

function hashPassword(password, saltHex = randHex(16)) {
  const hash = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 }).toString('hex');
  return { salt: saltHex, hash };
}

function verifyPassword(password, rec) {
  if (!rec || !rec.salt || !rec.hash) return false;
  const { hash } = hashPassword(password, rec.salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(rec.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function randomDigits(length) {
  let s = '';
  for (let i = 0; i < length; i++) s += crypto.randomInt(0, 10);
  return s;
}

module.exports = { randHex, hashCode, hashPassword, verifyPassword, randomDigits };
