'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getMtpDrives, copyToMtp, encodeId, decodeId, parseJson, uniqueFrom, PS_SCRIPT } = require('../src/core/mtp');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sc-mtp-'));
const DEV = 'Galaxy S23', STOR = 'Internal shared storage';
const ID = encodeId(DEV, STOR);

test('mtp: id round-trip and rejection of garbage', () => {
  assert.deepEqual(decodeId(ID), { dev: DEV, stor: STOR });
  assert.equal(decodeId('E:\\'), null);
  assert.equal(decodeId('mtp:@@@'), null);
  assert.equal(decodeId('mtp:' + Buffer.from('["only-one"]').toString('base64url')), null);
  assert.equal(decodeId(undefined), null);
});

test('mtp: parseJson tolerates leading noise', () => {
  assert.deepEqual(parseJson('\ufeff[{"a":1}]'), [{ a: 1 }]);
  assert.equal(parseJson('garbage'), null);
  assert.equal(parseJson(null), null);
});

test('mtp: lists phones, marks locked ones, ignores ordinary shell items', async () => {
  const runPs = async () => JSON.stringify([
    { name: 'Local Disk (C:)', isDevice: false, storages: [] },
    { name: DEV, isDevice: true, storages: [{ name: STOR }, { name: 'SD card' }] },
    { name: 'Pixel', isDevice: true, storages: [] }
  ]);
  const d = await getMtpDrives(runPs);
  assert.equal(d.length, 3);
  assert.deepEqual(d.map(x => x.locked), [false, false, true]);
  assert.ok(d.every(x => x.kind === 'mtp'));
  assert.deepEqual(decodeId(d[1].id), { dev: DEV, stor: 'SD card' });
  assert.deepEqual(await getMtpDrives(async () => null), []);
});

test('mtp: unique naming is case-insensitive', () => {
  assert.equal(uniqueFrom(new Set(['a.pdf']), 'A.pdf'), 'A (1).pdf');
  assert.equal(uniqueFrom(new Set(), 'x.pdf'), 'x.pdf');
});

test('mtp: copy file – stages with unique name, passes args as data, cleans up', async () => {
  const src = tmp(); fs.writeFileSync(path.join(src, 'סיכום.pdf'), 'DATA');
  const calls = []; let stagedExisted = false, stageDir = null;
  const runPs = async (args) => {
    calls.push(args);
    if (args.action === 'names') return JSON.stringify({ ok: true, names: ['סיכום.pdf'], sub: 'Download' });
    stagedExisted = fs.existsSync(args.stagePath) && fs.readFileSync(args.stagePath, 'utf8') === 'DATA';
    stageDir = path.dirname(args.stagePath);
    return JSON.stringify({ ok: true, sub: 'Download' });
  };
  const r = await copyToMtp({ id: ID, srcReal: path.join(src, 'סיכום.pdf'), runPs });
  assert.ok(r.ok); assert.equal(path.basename(r.dest), 'סיכום (1).pdf');
  assert.ok(stagedExisted);
  assert.equal(path.basename(calls[1].stagePath), 'סיכום (1).pdf');
  assert.equal(calls[1].isDir, false); assert.equal(calls[1].size, 4);
  await new Promise(r => setTimeout(r, 100));
  assert.ok(!fs.existsSync(stageDir));                         // תיקיית הביניים נמחקה
});

test('mtp: copy folder – staged tree, custom name sanitized, expected file count', async () => {
  const src = tmp();
  fs.mkdirSync(path.join(src, 'dir', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(src, 'dir', 'a.txt'), '1'); fs.writeFileSync(path.join(src, 'dir', 'sub', 'b.txt'), '2');
  let seen = null;
  const runPs = async (args) => {
    if (args.action === 'names') return JSON.stringify({ ok: true, names: [], sub: '' });
    seen = { ...args, tree: fs.existsSync(path.join(args.stagePath, 'sub', 'b.txt')) };
    return JSON.stringify({ ok: true, sub: '' });
  };
  const r = await copyToMtp({ id: ID, srcReal: path.join(src, 'dir'), customName: '../../evil', runPs });
  assert.ok(r.ok); assert.equal(r.files, 2);
  assert.ok(seen.isDir && seen.tree && seen.expect === 2);
  assert.ok(!/[\\/]/.test(seen.name) && seen.name !== '..' && path.dirname(seen.stagePath) !== path.dirname(path.dirname(seen.stagePath)));
});

test('mtp: copy folder – Windows metadata (desktop.ini, Thumbs.db) is not staged or counted', async () => {
  const src = tmp();
  fs.mkdirSync(path.join(src, 'dir', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(src, 'dir', 'a.png'), '1'); fs.writeFileSync(path.join(src, 'dir', 'desktop.ini'), 'x');
  fs.writeFileSync(path.join(src, 'dir', 'sub', 'Thumbs.db'), 'y');
  let seen = null;
  const runPs = async (args) => {
    if (args.action === 'names') return JSON.stringify({ ok: true, names: [], sub: '' });
    seen = { ...args, ini: fs.existsSync(path.join(args.stagePath, 'desktop.ini')) };
    return JSON.stringify({ ok: true, sub: '' });
  };
  const r = await copyToMtp({ id: ID, srcReal: path.join(src, 'dir'), runPs });
  assert.ok(r.ok); assert.equal(r.files, 1); assert.equal(r.bytes, 1);
  assert.ok(seen.expect === 1 && !seen.ini);
});

test('mtp: error mapping – locked phone, missing device, timeout, no reply', async () => {
  const src = tmp(); fs.writeFileSync(path.join(src, 'a.txt'), 'x');
  const f = path.join(src, 'a.txt');
  const mk = (names, copy) => async (a) => a.action === 'names' ? names : copy;
  assert.match((await copyToMtp({ id: ID, srcReal: f, runPs: mk(JSON.stringify({ ok: false, code: 'nostorage' })) })).msg, /העברת קבצים/);
  assert.match((await copyToMtp({ id: ID, srcReal: f, runPs: mk(JSON.stringify({ ok: false, code: 'nodevice' })) })).msg, /לא נמצא/);
  assert.match((await copyToMtp({ id: ID, srcReal: f, runPs: mk(null) })).msg, /לא ניתן לקרוא/);
  const ok = JSON.stringify({ ok: true, names: [] });
  assert.match((await copyToMtp({ id: ID, srcReal: f, runPs: mk(ok, JSON.stringify({ ok: false, code: 'timeout' })) })).msg, /לא הסתיימה/);
  assert.match((await copyToMtp({ id: ID, srcReal: f, runPs: mk(ok, null) })).msg, /אין תשובה/);
  assert.equal((await copyToMtp({ id: 'bogus', srcReal: f, runPs: mk(ok, ok) })).ok, false);
});

test('mtp: the PowerShell script has no interpolated user data', () => {
  assert.ok(!PS_SCRIPT.includes('${'));
  assert.ok(PS_SCRIPT.includes('$env:SC_ARGS'));
});

test('mtp: cancelling aborts the copy and cleans staging', async () => {
  const src = tmp(); fs.writeFileSync(path.join(src, 'a.txt'), 'x');
  const ac = new AbortController(); let stageDir = null;
  const runPs = async (args, _ms, signal) => {
    if (args.action === 'names') return JSON.stringify({ ok: true, names: [] });
    stageDir = path.dirname(args.stagePath);
    assert.ok(signal === ac.signal);                       // האות מועבר לתהליך PowerShell
    ac.abort();
    return null;                                           // התהליך נהרג
  };
  const r = await copyToMtp({ id: ID, srcReal: path.join(src, 'a.txt'), runPs, signal: ac.signal });
  assert.equal(r.ok, false); assert.equal(r.cancelled, true);
  await new Promise(r => setTimeout(r, 100));
  assert.ok(!fs.existsSync(stageDir));
});
