'use strict';
/**
 * תמיכה בהתקנים ניידים (טלפון אנדרואיד במצב "העברת קבצים", פרוטוקול MTP) ב-Windows.
 * ל-MTP אין אות כונן ואי אפשר לכתוב אליו עם fs, ולכן עובדים דרך מנגנון ה-Shell של Windows (כמו סייר הקבצים).
 *
 * הערות:
 *  - כל הערכים עוברים ל-PowerShell כ-JSON במשתנה סביבה, לא בתוך טקסט הסקריפט (אין הזרקת פקודות).
 *  - ההעתקה נעשית מתיקיית ביניים זמנית (staging) כדי לשלוט בשם הסופי ולא לדרוס. התיקייה נמחקת תמיד בסוף.
 *  - ההעתקה עצמה (CopyHere) אסינכרונית ומציגה חלון של Windows; ההשלמה מזוהה בבדיקה חוזרת של התוצאה בטלפון.
 */
const { execFile } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { sanitizeName } = require('./pathguard');
const { copyItem } = require('./copier');

const PS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Out-Json($o) { [Console]::Out.Write((ConvertTo-Json -InputObject $o -Depth 6 -Compress)) }
$a = $env:SC_ARGS | ConvertFrom-Json
try { Add-Type -AssemblyName System.Windows.Forms } catch {}
$sh = New-Object -ComObject Shell.Application
$pc = $sh.NameSpace(17)

# המתנה שמעבדת הודעות Windows: פעולות MTP ב-Shell רצות על ה-thread הזה, ובלי עיבוד הודעות ההעתקה עלולה להיתקע
function Wait-Pump($ms) {
  $end = (Get-Date).AddMilliseconds($ms)
  while ((Get-Date) -lt $end) {
    if ($a.pump -ne $false) { try { [System.Windows.Forms.Application]::DoEvents() } catch {} }
    Start-Sleep -Milliseconds 40
  }
}

function Item-Name($i) {
  $n = $null
  try { $n = [string]$i.ExtendedProperty('System.FileName') } catch {}
  if ([string]::IsNullOrEmpty($n)) { $n = [string]$i.Name }
  return $n
}
function Item-Size($i) {
  # בטלפון (MTP) המאפיין Size תמיד 0; הגודל האמיתי נמצא ב-System.Size
  $n = [int64]0
  try { $n = [int64]$i.ExtendedProperty('System.Size') } catch {}
  try { if ([int64]$i.Size -gt $n) { $n = [int64]$i.Size } } catch {}
  return $n
}
function Find-Item($folder, $name) {
  foreach ($i in $folder.Items()) { if (($i.Name -eq $name) -or ((Item-Name $i) -eq $name)) { return $i } }
  return $null
}
function Count-Files($folder) {
  $n = 0
  foreach ($i in $folder.Items()) { if ($i.IsFolder) { $n += Count-Files $i.GetFolder } else { $n++ } }
  return $n
}
function Get-Dest {
  $dev = $null
  foreach ($i in $pc.Items()) { if ($i.Name -eq $a.dev) { $dev = $i; break } }
  if (-not $dev) { return @{ err = 'nodevice' } }
  $stor = $null
  try { foreach ($s in $dev.GetFolder.Items()) { if ($s.IsFolder -and ($s.Name -eq $a.stor)) { $stor = $s; break } } } catch {}
  if (-not $stor) { return @{ err = 'nostorage' } }
  $dest = $stor.GetFolder
  $sub = ''
  foreach ($s in $dest.Items()) { if ($s.IsFolder -and (($s.Name -eq 'Download') -or ($s.Name -eq 'Downloads'))) { $dest = $s.GetFolder; $sub = [string]$s.Name; break } }
  return @{ err = $null; dest = $dest; sub = $sub }
}

if ($a.action -eq 'list') {
  $res = @()
  foreach ($i in $pc.Items()) {
    $p = [string]$i.Path
    $isDev = (-not $i.IsFileSystem) -and ($p -match '(?i)usb#|\\\\\?\\')
    $stors = @()
    if ($isDev -or $a.all) {
      try { foreach ($s in $i.GetFolder.Items()) { if ($s.IsFolder) { $stors += [pscustomobject]@{ name = [string]$s.Name } } } } catch {}
    }
    $res += [pscustomobject]@{ name = [string]$i.Name; path = $p; isFileSystem = [bool]$i.IsFileSystem; isDevice = [bool]$isDev; storages = @($stors) }
  }
  Out-Json @($res)
  exit 0
}

$d = Get-Dest
if ($d.err) { Out-Json @{ ok = $false; code = $d.err }; exit 0 }

if ($a.action -eq 'names') {
  $names = @()
  foreach ($s in $d.dest.Items()) { $names += (Item-Name $s) }
  Out-Json @{ ok = $true; names = @($names); sub = $d.sub }
  exit 0
}

if ($a.action -eq 'copy') {
  $d.dest.CopyHere([string]$a.stagePath, 20)
  $deadline = (Get-Date).AddSeconds([int]$a.timeoutSec)
  $stable = 0
  while ((Get-Date) -lt $deadline) {
    Wait-Pump 400
    $t = Find-Item $d.dest $a.name
    $good = $false
    if ($t) {
      if ($a.isDir) { $good = ((Count-Files $t.GetFolder) -ge [int]$a.expect) }
      else { $good = ((Item-Size $t) -ge [int64]$a.size) }
    }
    if ($good) { $stable++ } else { $stable = 0 }
    if ($stable -ge 2) { Out-Json @{ ok = $true; sub = $d.sub }; exit 0 }
  }
  Out-Json @{ ok = $false; code = 'timeout' }
  exit 0
}
Out-Json @{ ok = $false; code = 'badaction' }
`;

function defaultRunPs(args, timeoutMs = 20000, signal) {
  if (process.platform !== 'win32') return Promise.resolve(null);
  const encoded = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64');
  return new Promise(resolve => {
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 8 << 20, signal, env: { ...process.env, SC_ARGS: JSON.stringify(args) } },
      (err, stdout) => resolve(err ? null : stdout));
  });
}

function parseJson(out) {
  if (typeof out !== 'string') return null;
  const i = out.search(/[\[{]/);
  if (i < 0) return null;
  try { return JSON.parse(out.slice(i)); } catch { return null; }
}

// ─── מזהה יעד ───────────────────────────────────────────────────────────
const encodeId = (dev, stor) => 'mtp:' + Buffer.from(JSON.stringify([dev, stor]), 'utf8').toString('base64url');
function decodeId(id) {
  if (typeof id !== 'string' || !id.startsWith('mtp:')) return null;
  try {
    const arr = JSON.parse(Buffer.from(id.slice(4), 'base64url').toString('utf8'));
    return Array.isArray(arr) && arr.length === 2 && arr.every(s => typeof s === 'string' && s) ? { dev: arr[0], stor: arr[1] } : null;
  } catch { return null; }
}

/** רשימת טלפונים/התקנים ניידים. מחזיר אלמנטים תואמי רשימת הדיסקים, עם kind:'mtp'. */
async function getMtpDrives(runPs = defaultRunPs) {
  const arr = parseJson(await runPs({ action: 'list' }, 20000));
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const d of arr) {
    if (!d || !d.isDevice || !d.name) continue;
    const stors = Array.isArray(d.storages) ? d.storages : [];
    if (!stors.length) {
      out.push({ id: encodeId(d.name, '-'), kind: 'mtp', locked: true, label: `${d.name} (טלפון) – נעול או לא במצב "העברת קבצים"`, size: 0, free: 0 });
      continue;
    }
    for (const s of stors) {
      if (!s || !s.name) continue;
      out.push({ id: encodeId(d.name, s.name), kind: 'mtp', locked: false, label: `${d.name} (טלפון) – ${s.name}`, size: 0, free: 0 });
    }
  }
  return out;
}

function uniqueFrom(namesLower, name) {
  if (!namesLower.has(name.toLowerCase())) return name;
  const ext = path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  for (let i = 1; i < 10000; i++) {
    const c = `${base} (${i})${ext}`;
    if (!namesLower.has(c.toLowerCase())) return c;
  }
  throw new Error('לא נמצא שם פנוי');
}

// קבצי מערכת של Windows שה-Shell לא מעתיק לטלפון. אם הם נשארים בתיקיית הביניים, ספירת הקבצים לא תגיע ליעד.
const SHELL_SKIPPED = new Set(['desktop.ini', 'thumbs.db']);

/** מוחק מתיקיית הביניים קבצים שה-Shell לא יעתיק, ומחזיר את מספר הקבצים והבתים שנשארו. */
async function pruneStage(dir) {
  let files = 0, bytes = 0;
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const r = await pruneStage(p); files += r.files; bytes += r.bytes; }
    else if (SHELL_SKIPPED.has(e.name.toLowerCase())) await fsp.rm(p, { force: true });
    else { files++; bytes += (await fsp.stat(p)).size; }
  }
  return { files, bytes };
}

const MESSAGES = {
  nodevice: 'הטלפון לא נמצא – חבר אותו ופתח את הנעילה',
  nostorage: 'לא נמצא אחסון בטלפון – פתח את המסך ובחר "העברת קבצים" בהתראה שבטלפון',
  timeout: 'ההעתקה לטלפון לא הסתיימה בזמן. ודא שהטלפון פתוח, ושלא נשאר חלון העתקה פתוח ב-Windows',
  badaction: 'שגיאה פנימית'
};

/**
 * @param {{id:string, srcReal:string, customName?:string|null, onProgress?:Function, runPs?:Function, tmpRoot?:string}} o
 */
async function copyToMtp({ id, srcReal, customName = null, onProgress = () => {}, runPs = defaultRunPs, tmpRoot = os.tmpdir(), signal }) {
  const target = decodeId(id);
  if (!target || target.stor === '-') return { ok: false, msg: MESSAGES.nostorage };
  let stage = null;
  try {
    const st = await fsp.lstat(srcReal);
    if (st.isSymbolicLink() || !(st.isFile() || st.isDirectory())) return { ok: false, msg: 'סוג פריט לא נתמך' };

    const listed = parseJson(await runPs({ action: 'names', dev: target.dev, stor: target.stor }, 30000, signal));
    if (signal && signal.aborted) return { ok: false, cancelled: true, msg: 'ההעתקה בוטלה' };
    if (!listed) return { ok: false, msg: 'לא ניתן לקרוא את הטלפון. ודא שהוא מחובר ופתוח' };
    if (!listed.ok) return { ok: false, msg: MESSAGES[listed.code] || 'שגיאה בגישה לטלפון' };

    const existing = new Set((listed.names || []).map(n => String(n).toLowerCase()));
    const desired = sanitizeName(st.isDirectory() ? (customName || path.basename(srcReal)) : path.basename(srcReal), st.isDirectory() ? 'תיקייה' : 'file');
    const finalName = uniqueFrom(existing, desired);

    stage = await fsp.mkdtemp(path.join(tmpRoot, 'securecopy-mtp-'));
    const stagePath = path.join(stage, finalName);
    let files = 1, bytes = st.size;
    onProgress({ done: 0, total: 1, name: finalName });
    if (st.isFile()) {
      await fsp.copyFile(srcReal, stagePath, fs.constants.COPYFILE_EXCL);
    } else {
      const r = await copyItem(srcReal, stage, finalName);
      if (!r.ok) return r;
      if (path.basename(r.dest) !== finalName) return { ok: false, msg: 'שגיאה פנימית בהכנת ההעתקה' };
      ({ files, bytes } = await pruneStage(stagePath));
      if (!files) return { ok: false, msg: 'התיקייה ריקה – אין מה להעתיק' };
    }

    const timeoutSec = Math.min(3600, Math.ceil(60 + bytes / (4 * 1024 * 1024)));   // דקה + שנייה לכל 4MB (בערך 4MB/s בתרחיש גרוע)
    const res = parseJson(await runPs({
      action: 'copy', dev: target.dev, stor: target.stor, stagePath, name: finalName,
      isDir: st.isDirectory(), expect: files, size: bytes, timeoutSec
    }, (timeoutSec + 30) * 1000, signal));
    if (signal && signal.aborted) return { ok: false, cancelled: true, msg: 'ההעתקה בוטלה. ייתכן שנשאר בטלפון קובץ חלקי' };
    if (!res) return { ok: false, msg: 'ההעתקה לטלפון נכשלה (אין תשובה מ-Windows)' };
    if (!res.ok) return { ok: false, msg: MESSAGES[res.code] || 'ההעתקה לטלפון נכשלה' };
    onProgress({ done: 1, total: 1, name: finalName });
    return { ok: true, dest: path.join(res.sub || '', finalName), files, bytes };
  } catch (e) {
    return { ok: false, msg: 'ההעתקה לטלפון נכשלה' + (e && e.message ? ` (${e.message})` : '') };
  } finally {
    if (stage) fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { getMtpDrives, copyToMtp, encodeId, decodeId, defaultRunPs, parseJson, uniqueFrom, PS_SCRIPT };
