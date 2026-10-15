// בדיקת העתקה קטנה לטלפון בלי הממשק. הרצה: npm run test:mtp-copy   (או: node scripts/mtp-copy-test.js --nopump להשוואה)
// עם הטלפון מחובר, פתוח ובמצב "העברת קבצים". יוצר קובץ בדיקה של 200KB ומעתיק אותו.
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { getMtpDrives, copyToMtp, defaultRunPs } = require('../src/core/mtp');
(async () => {
  if (process.platform !== 'win32') return console.log('הכלי הזה עובד ב-Windows בלבד.');
  const noPump = process.argv.includes('--nopump');
  const t0 = Date.now(); const lap = m => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
  const drives = (await getMtpDrives()).filter(d => !d.locked);
  lap(`נמצאו ${drives.length} יעדי טלפון: ${drives.map(d => d.label).join(' | ') || '—'}`);
  if (!drives.length) return console.log('אין טלפון נגיש. פתח את המסך ובחר "העברת קבצים".');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sc-t-')), `בדיקה-${Date.now()}.txt`);
  fs.writeFileSync(file, Buffer.alloc(200 * 1024, 65));
  const runPs = (args, ms, signal) => defaultRunPs(noPump ? { ...args, pump: false } : args, ms, signal);
  lap(`מעתיק קובץ בדיקה (${noPump ? 'בלי' : 'עם'} עיבוד הודעות) אל ${drives[0].label}`);
  const r = await copyToMtp({ id: drives[0].id, srcReal: file, runPs, onProgress: p => lap(`התקדמות ${p.done}/${p.total}`) });
  lap('תוצאה: ' + JSON.stringify(r));
  console.log(r.ok ? '\nהצליח. בדוק שהקובץ מופיע בתיקיית Download בטלפון.' : '\nנכשל. שלח לי את הפלט הזה.');
})();
