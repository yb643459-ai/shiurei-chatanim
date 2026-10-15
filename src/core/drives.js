'use strict';
/** זיהוי דיסקים נשלפים (Windows: DriveType=2 וגם דיסקים על פס USB). כונן המערכת לא מוצג. */
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const PS_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'
$sys = $env:SystemDrive
$map = @{}
Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DriveType -eq 2 } | ForEach-Object {
  $map[$_.DeviceID] = [pscustomobject]@{ letter = $_.DeviceID; label = $_.VolumeName; size = [int64]$_.Size; free = [int64]$_.FreeSpace }
}
Get-Disk | Where-Object { $_.BusType -eq 'USB' } | Get-Partition | Where-Object { $_.DriveLetter } | ForEach-Object {
  $l = ([string]$_.DriveLetter) + ':'
  $v = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$l'"
  if ($v) { $map[$l] = [pscustomobject]@{ letter = $l; label = $v.VolumeName; size = [int64]$v.Size; free = [int64]$v.FreeSpace } }
}
$out = @($map.Values | Where-Object { $_.letter -ne $sys })
ConvertTo-Json -InputObject $out -Compress
`;

function run(cmd, args, timeout = 8000) {
  return new Promise(resolve => {
    execFile(cmd, args, { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

function parseWindowsDrives(jsonText) {
  let arr;
  try { arr = JSON.parse(String(jsonText).trim() || '[]'); } catch { return []; }
  if (!Array.isArray(arr)) arr = [arr];
  return arr
    .filter(d => d && /^[A-Za-z]:$/.test(d.letter || '') && Number(d.size) > 0)
    .map(d => ({
      id: d.letter.toUpperCase() + '\\', path: d.letter.toUpperCase() + '\\',
      label: `${d.label || 'דיסק נשלף'} (${d.letter.toUpperCase()})`,
      size: Number(d.size), free: Number(d.free) || 0
    }));
}

function parseLsblk(jsonText) {
  let parsed;
  try { parsed = JSON.parse(jsonText); } catch { return []; }
  const out = [];
  const truthy = v => v === true || v === '1' || v === 1;
  const walk = (devs, parentRemovable) => {
    for (const d of devs || []) {
      const removable = parentRemovable || truthy(d.rm) || truthy(d.hotplug) || d.tran === 'usb';
      const mp = d.mountpoint || (Array.isArray(d.mountpoints) ? d.mountpoints.find(Boolean) : null);
      if (removable && mp && mp !== '/' && !mp.startsWith('/boot')) out.push({ id: mp, path: mp, label: d.label || path.basename(mp), size: 0, free: 0 });
      walk(d.children, removable);
    }
  };
  walk(parsed.blockdevices, false);
  return out;
}

async function getRemovableDrives() {
  try {
    if (process.platform === 'win32') {
      const encoded = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64');
      const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], 15000);
      return out !== null ? parseWindowsDrives(out) : [];
    }
    if (process.platform === 'darwin') {
      const names = fs.existsSync('/Volumes') ? fs.readdirSync('/Volumes') : [];
      const out = [];
      for (const n of names) {
        const p = path.join('/Volumes', n);
        try { if (fs.realpathSync(p) === '/') continue; } catch { continue; }
        out.push({ id: p, path: p, label: n, size: 0, free: 0 });
      }
      return out;
    }
    const out = await run('lsblk', ['-J', '-o', 'NAME,MOUNTPOINT,LABEL,RM,HOTPLUG,TRAN']);
    return out ? parseLsblk(out) : [];
  } catch { return []; }
}

module.exports = { getRemovableDrives, parseWindowsDrives, parseLsblk };
