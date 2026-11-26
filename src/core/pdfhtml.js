'use strict';
/**
 * HTML להדפסת קודים ל-PDF. Chromium מטפל בעברית/RTL; כל הערכים עוברים escape.
 * עיצוב (גרסה 2.2.0): רק כרטיסים לגזירה, בשחור-לבן (מיועד למדפסת שחור-לבן, בלי רקעים צבעוניים).
 * 12 כרטיסים בעמוד (2 בשורה), קו גזירה מקווקו, הקוד בגדול בתוך מסגרת.
 */
const { pathToFileURL } = require('url');
const path = require('path');

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const group4 = code => code.replace(/(\d{4})(?=\d)/g, '$1 ');
const fmtDate = iso => { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };

/** כותרת תחתונה של Chromium (מספרי עמודים). רצה מחוץ לעמוד, ולכן בפונט מערכת. */
const FOOTER_TEMPLATE = `<div dir="rtl" style="width:100%;font-family:Arial,sans-serif;font-size:7.5pt;color:#000;text-align:center;padding:0 14mm">
עמוד <span class="pageNumber"></span> מתוך <span class="totalPages"></span></div>`;

function renderCodesHtml({ title, label, folderNames, codes, expiryDate, maxUses, fontsDir }) {
  const fontHe = pathToFileURL(path.join(fontsDir, 'heebo-hebrew-wght-normal.woff2')).href;
  const fontLa = pathToFileURL(path.join(fontsDir, 'heebo-latin-wght-normal.woff2')).href;
  const usesText = maxUses === 0 ? 'ללא הגבלת שימושים' : maxUses === 1 ? 'שימוש חד-פעמי' : `עד ${maxUses} שימושים`;
  const expiryText = expiryDate ? `בתוקף עד ${fmtDate(expiryDate)}` : 'ללא תאריך תפוגה';
  const heading = title || label || 'שיעורי חתנים';
  const sub = label && label !== heading ? label : '';
  const folders = folderNames.join(' · ');

  const cards = codes.map((c, i) => `
    <div class="cut"><div class="card">
      <div class="band"><span class="brand">${esc(heading)}</span><span class="num" dir="ltr">${i + 1} / ${codes.length}</span></div>
      <div class="inner">
        ${sub ? `<div class="label">${esc(sub)}</div>` : ''}
        <div class="code" dir="ltr">${esc(group4(c))}</div>
        <div class="folders">${esc(folders)}</div>
        <div class="terms"><span>${esc(usesText)}</span><span class="dot">|</span><span>${esc(expiryText)}</span></div>
      </div>
    </div></div>`).join('');

  return `<!doctype html>
<html lang="he" dir="rtl"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src file:">
<style>
@font-face{font-family:Heebo;font-weight:100 900;src:url("${fontHe}") format("woff2");unicode-range:U+0590-05FF,U+200C-2010,U+20AA,U+FB1D-FB4F}
@font-face{font-family:Heebo;font-weight:100 900;src:url("${fontLa}") format("woff2");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@page{size:A4;margin:12mm 12mm 15mm}
*{box-sizing:border-box}
body{margin:0;font-family:Heebo,Arial,sans-serif;color:#000;background:#fff}
.grid{display:flex;flex-wrap:wrap}
.cut{width:50%;padding:2.5mm;border:0.7px dashed #000;break-inside:avoid;page-break-inside:avoid}
.card{border:1.2px solid #000;border-radius:8px;height:38.5mm;display:flex;flex-direction:column}
.band{display:flex;justify-content:space-between;align-items:baseline;gap:3mm;padding:1.8mm 4mm 1.4mm;border-bottom:1.2px solid #000;font-size:9pt}
.brand{font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.num{font-size:8pt;font-variant-numeric:tabular-nums;white-space:nowrap}
.inner{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:1mm 4mm 1.6mm;gap:1mm;text-align:center}
.label{font-size:8.5pt;font-weight:600;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.code{font-weight:800;font-size:19pt;letter-spacing:.08em;font-variant-numeric:tabular-nums;border:1.8px solid #000;border-radius:6px;padding:.3mm 4mm;white-space:nowrap}
.folders{font-size:7.5pt;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.terms{font-size:7.5pt;font-weight:600}
.terms .dot{margin:0 1.5mm;font-weight:400}
</style></head><body>
<div class="grid">${cards}</div>
</body></html>`;
}

module.exports = { renderCodesHtml, esc, group4, FOOTER_TEMPLATE };
