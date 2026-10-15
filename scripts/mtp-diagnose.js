// כלי אבחון לטלפון: מדפיס מה Windows מדווח על התקנים ניידים. הרצה: npm run diagnose:mtp (עם הטלפון מחובר ופתוח, במצב "העברת קבצים")
'use strict';
const { defaultRunPs, parseJson } = require('../src/core/mtp');
(async () => {
  if (process.platform !== 'win32') { console.log('הכלי הזה עובד ב-Windows בלבד.'); return; }
  const out = await defaultRunPs({ action: 'list', all: true }, 60000);
  const arr = parseJson(out);
  if (!arr) { console.log('לא התקבלה תשובה מ-PowerShell.\nפלט גולמי:', out); return; }
  console.log(JSON.stringify(arr, null, 2));
  const devs = arr.filter(d => d.isDevice);
  console.log(`\nזוהו ${devs.length} התקנים ניידים:`);
  for (const d of devs) console.log(` - ${d.name}  | אחסון: ${d.storages.map(s => s.name).join(', ') || '(אין – הטלפון נעול או לא במצב העברת קבצים)'}`);
})();
