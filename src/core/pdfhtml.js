'use strict';
/** HTML להדפסת קודים ל-PDF. Chromium מטפל בעברית/RTL; כל הערכים עוברים escape. */
const { pathToFileURL } = require('url');
const path = require('path');

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const group4 = code => code.replace(/(\d{4})(?=\d)/g, '$1 ');
const fmtDate = iso => { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };

function renderCodesHtml({ title, label, folderNames, codes, expiryDate, maxUses, fontsDir }) {
  const fontHe = pathToFileURL(path.join(fontsDir, 'heebo-hebrew-wght-normal.woff2')).href;
  const fontLa = pathToFileURL(path.join(fontsDir, 'heebo-latin-wght-normal.woff2')).href;
  const usesText = maxUses === 0 ? 'ללא הגבלת שימושים' : maxUses === 1 ? 'שימוש חד-פעמי' : `עד ${maxUses} שימושים`;

  const cards = codes.map((c, i) => `
    <div class="card">
      <div class="top"><span>${esc(title || 'שיעורי חתנים')}</span><span>#${i + 1}</span></div>
      <div class="code" dir="ltr">${esc(group4(c))}</div>
      <div class="bottom">${esc(usesText)}${expiryDate ? ` · בתוקף עד ${esc(fmtDate(expiryDate))}` : ''}</div>
    </div>`).join('');

  return `<!doctype html>
<html lang="he" dir="rtl"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src file:">
<style>
@font-face{font-family:Heebo;font-weight:100 900;src:url("${fontHe}") format("woff2");unicode-range:U+0590-05FF,U+200C-2010,U+20AA,U+FB1D-FB4F}
@font-face{font-family:Heebo;font-weight:100 900;src:url("${fontLa}") format("woff2");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@page{size:A4;margin:14mm}
*{box-sizing:border-box}
body{margin:0;font-family:Heebo,Arial,sans-serif;color:#1b1b1f}
h1{font-size:20pt;margin:0 0 4px;font-weight:700}
.meta{font-size:10pt;color:#44474f;margin-bottom:10px}
.rule{border:0;border-top:1px solid #c4c6d0;margin:8px 0 12px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:8mm 6mm}
.card{border:1.2px dashed #74777f;border-radius:10px;padding:8px 12px;break-inside:avoid;height:25mm;display:flex;flex-direction:column;justify-content:space-between}
.top{display:flex;justify-content:space-between;font-size:8.5pt;color:#44474f}
.code{font-family:"Courier New",monospace;font-weight:700;font-size:17pt;letter-spacing:.06em;text-align:center}
.bottom{font-size:8pt;color:#8a1c1c;text-align:center}
</style></head><body>
<h1>${esc(title || 'שיעורי חתנים – קודי גישה')}</h1>
<div class="meta">${label ? `תווית: ${esc(label)} · ` : ''}תיקיות: ${esc(folderNames.join(', '))} · סה"כ ${codes.length} קודים · ${esc(usesText)}${expiryDate ? ` · תוקף עד ${esc(fmtDate(expiryDate))}` : ''}</div>
<hr class="rule">
<div class="grid">${cards}</div>
</body></html>`;
}

module.exports = { renderCodesHtml, esc, group4 };
