'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { isInside, resolveInside, sanitizeName, uniqueName, isFilesystemRoot } = require('../src/core/pathguard');
const { Vault } = require('../src/core/vault');
const { Sessions } = require('../src/core/sessions');
const { copyItem } = require('../src/core/copier');
const { parseWindowsDrives, parseLsblk } = require('../src/core/drives');
const { renderCodesHtml } = require('../src/core/pdfhtml');
const { hashCode } = require('../src/core/crypto');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sc-test-'));
function mkTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}

test('pathguard: isInside basics', () => {
  const root = tmp();
  assert.ok(isInside(root, root));
  assert.ok(isInside(root, path.join(root, 'a', 'b')));
  assert.ok(!isInside(root, path.dirname(root)));
  assert.ok(!isInside(root, root + '-evil'));
  assert.ok(!isInside(root, path.join(root, '..', 'x')));
});

test('pathguard: traversal and symlink escape are blocked', () => {
  const base = tmp();
  const root = path.join(base, 'shared'); const secret = path.join(base, 'secret');
  mkTree(base, { 'shared/ok.txt': '1', 'secret/s.txt': 'x' });
  const real = fs.realpathSync(root);
  assert.ok(resolveInside([real], path.join(real, 'ok.txt')));
  assert.equal(resolveInside([real], path.join(real, '..', 'secret', 's.txt')), null);
  assert.equal(resolveInside([real], secret), null);
  assert.equal(resolveInside([real], 'ok\0.txt'), null);
  assert.equal(resolveInside([real], undefined), null);
  try {
    fs.symlinkSync(secret, path.join(root, 'link'), 'dir');
    assert.equal(resolveInside([real], path.join(real, 'link', 's.txt')), null);
    assert.equal(resolveInside([real], path.join(real, 'link')), null);
  } catch (e) { if (e.code !== 'EPERM') throw e; }
});

test('pathguard: sanitizeName / uniqueName / root detection', () => {
  assert.equal(sanitizeName('..'), 'תיקייה');
  assert.equal(sanitizeName('a/b\\c:d'), 'a_b_c_d');
  assert.equal(sanitizeName('con'), '_con');
  assert.equal(sanitizeName('שם. '), 'שם');
  const d = tmp(); fs.writeFileSync(path.join(d, 'a.pdf'), '');
  assert.equal(uniqueName(d, 'a.pdf'), 'a (1).pdf');
  assert.equal(uniqueName(d, 'b.pdf'), 'b.pdf');
  assert.ok(isFilesystemRoot(path.parse(process.cwd()).root));
  assert.ok(!isFilesystemRoot(d));
});

function newVault(clock) {
  const dir = tmp();
  const v = new Vault({ dataDir: dir, now: clock || (() => Date.now()) }).load();
  return { v, dir };
}
const folderId = (v, folder, name) => {
  const real = fs.realpathSync(folder);
  const r = v.addFolder({ path: real, name: name || path.basename(real) });
  return r.ok ? r.id : r.existingId;
};
const issue = (v, folder, extra = {}) => {
  const b = v.prepareBatch({ folderIds: [folderId(v, folder)], label: 'כיתה א', count: 3, codeLength: 12, maxUses: 1, ...extra });
  assert.ok(b.ok, b.msg); v.commitBatch(b.items); return b.items;
};

test('vault: first run requires setup, no default password', () => {
  const { v } = newVault();
  assert.ok(v.needsSetup());
  assert.equal(v.verifyAdmin('999999').ok, false);
  assert.equal(v.setupAdmin('999999').ok, false);
  assert.equal(v.setupAdmin('12').ok, false);
  assert.ok(v.setupAdmin('correct horse').ok);
  assert.ok(!v.needsSetup());
  assert.equal(v.setupAdmin('another one').ok, false);
  assert.ok(v.verifyAdmin('correct horse').ok);
});

test('vault: codes and password are never stored in plaintext', () => {
  const { v, dir } = newVault();
  v.setupAdmin('s3cret-pass');
  const items = issue(v, tmp());
  const raw = fs.readFileSync(path.join(dir, 'data.json'), 'utf8');
  assert.ok(!raw.includes('s3cret-pass'));
  for (const it of items) assert.ok(!raw.includes(it.code));
  assert.ok(items[0].code.length === 12 && /^\d+$/.test(items[0].code));
  assert.equal(v.listCodes()[0].hint.length, 4);
});

test('vault: one-time code is consumed on first successful use only', () => {
  const folder = tmp(); const { v } = newVault(); v.setupAdmin('passw0rd!');
  const [a] = issue(v, folder);
  const r1 = v.checkCode(a.code);
  assert.ok(r1.ok); assert.equal(r1.roots[0], fs.realpathSync(folder));
  assert.ok(v.checkCode(a.code).ok);
  v.markUsed(r1.id);
  const r2 = v.checkCode(a.code);
  assert.equal(r2.ok, false); assert.equal(r2.msg, 'הקוד כבר נוצל');
  v.resetUsage([r1.id]);
  assert.ok(v.checkCode(a.code).ok);
});

test('vault: unlimited (maxUses 0) and multi-use', () => {
  const { v } = newVault(); v.setupAdmin('passw0rd!');
  const [u] = issue(v, tmp(), { maxUses: 0, count: 1 });
  const id = v.checkCode(u.code).id;
  for (let i = 0; i < 5; i++) v.markUsed(id);
  assert.ok(v.checkCode(u.code).ok);
  const [m] = issue(v, tmp(), { maxUses: 2, count: 1 });
  const mid = v.checkCode(m.code).id;
  v.markUsed(mid); assert.ok(v.checkCode(m.code).ok);
  v.markUsed(mid); assert.equal(v.checkCode(m.code).ok, false);
});

test('vault: expiry is inclusive of the last day', () => {
  let t = new Date(2026, 5, 10, 12).getTime();
  const { v } = newVault(() => t); v.setupAdmin('passw0rd!');
  const [c] = issue(v, tmp(), { expiryDate: '2026-06-10', count: 1 });
  assert.ok(v.checkCode(c.code).ok);
  t = new Date(2026, 5, 10, 23, 59).getTime(); assert.ok(v.checkCode(c.code).ok);
  t = new Date(2026, 5, 11, 0, 1).getTime();   assert.match(v.checkCode(c.code).msg, /פג תוקף/);
  assert.equal(v.deleteExpired().count, 1);
  assert.equal(v.prepareBatch({ folderIds: [folderId(v, tmp())], count: 1, expiryDate: '2026-02-31' }).ok, false);
});

test('vault: escalating lockout, persisted across restart', () => {
  let t = 1_000_000;
  const { v, dir } = newVault(() => t); v.setupAdmin('passw0rd!');
  const [c] = issue(v, tmp(), { count: 1 });
  for (let i = 0; i < 4; i++) assert.ok(!v.checkCode('000000000000').locked);
  const fifth = v.checkCode('000000000000');
  assert.ok(fifth.locked && fifth.retryAfter === 30);
  assert.ok(v.checkCode(c.code).locked);
  const v2 = new Vault({ dataDir: dir, now: () => t }).load();
  assert.ok(v2.checkCode(c.code).locked);
  t += 31_000;
  assert.ok(v2.checkCode('111111111111').retryAfter === 60);
  t += 61_000;
  assert.ok(v2.checkCode(c.code).ok);
  assert.ok(!v2.checkCode('222222222222').locked);
});

test('vault: admin lockout is separate from code lockout', () => {
  const { v } = newVault(); v.setupAdmin('passw0rd!');
  for (let i = 0; i < 5; i++) v.verifyAdmin('nope');
  assert.ok(v.verifyAdmin('passw0rd!').locked);
  assert.ok(!v.checkCode('123456789012').locked);
});

test('vault: batch is not persisted until commit', () => {
  const { v } = newVault(); v.setupAdmin('passw0rd!');
  const fid = folderId(v, tmp());
  const b = v.prepareBatch({ folderIds: [fid], count: 5, codeLength: 10 });
  assert.equal(v.listCodes().length, 0);
  v.commitBatch(b.items); assert.equal(v.listCodes().length, 5);
  assert.equal(v.prepareBatch({ folderIds: [fid], count: 501 }).ok, false);
  assert.equal(v.prepareBatch({ folderIds: [fid], count: 1, codeLength: 4 }).ok, false);
  assert.equal(v.prepareBatch({ folderIds: ['nope'], count: 1 }).ok, false);
});

test('vault: update / delete / missing folder', () => {
  const { v } = newVault(); v.setupAdmin('passw0rd!');
  const gone = tmp(); const [c] = issue(v, gone, { count: 1 });
  const id = v.listCodes()[0].id;
  assert.ok(v.updateCode(id, { label: 'חדש', maxUses: 3 }).ok);
  assert.equal(v.listCodes()[0].label, 'חדש');
  assert.equal(v.updateCode(id, { folderIds: [] }).ok, false);
  assert.equal(v.updateCode(id, { folderIds: ['nope'] }).ok, false);
  fs.rmSync(gone, { recursive: true });
  assert.equal(v.checkCode(c.code).msg, 'התיקייה לא נמצאה במחשב');
  assert.equal(v.deleteCodes([id]).count, 1);
  assert.equal(v.checkCode(c.code).ok, false);
});

test('vault: migration from v1 plaintext data', () => {
  const dir = tmp(); const folder = tmp();
  fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify({
    adminCode: '4821', codeLength: 12,
    codes: { '123456789012': { folder, label: 'ישן', expiryDate: null, usedAt: null } }
  }));
  const v = new Vault({ dataDir: dir }).load();
  assert.equal(v.loadNotice, 'migrated-v1');
  assert.ok(v.checkCode('123456789012').ok);
  assert.ok(v.verifyAdmin('4821').ok);
  assert.equal(v.listFolders().length, 1);                         // התיקייה הישנה יובאה לספרייה
  assert.equal(v.listFolders()[0].uses, 1);
  v.save();
  assert.ok(!fs.readFileSync(path.join(dir, 'data.json'), 'utf8').includes('123456789012'));
  assert.ok(fs.existsSync(path.join(dir, 'data.v1.backup.json')));

  const dir2 = tmp();
  fs.writeFileSync(path.join(dir2, 'data.json'), JSON.stringify({ adminCode: '999999', codes: {} }));
  assert.ok(new Vault({ dataDir: dir2 }).load().needsSetup());
});

test('vault: corrupt data file falls back to backup', () => {
  const { v, dir } = newVault(); v.setupAdmin('passw0rd!'); issue(v, tmp(), { count: 2 });
  v.updateSettings({ studentIdleSeconds: 120 });
  fs.writeFileSync(path.join(dir, 'data.json'), '{broken');
  const v2 = new Vault({ dataDir: dir }).load();
  assert.equal(v2.loadNotice, 'restored-backup');
  assert.ok(v2.verifyAdmin('passw0rd!').ok);
});

test('vault: settings validation and log', () => {
  const { v } = newVault(); v.setupAdmin('passw0rd!');
  assert.equal(v.updateSettings({ codeLength: 4 }).ok, false);
  assert.ok(v.updateSettings({ codeLength: 14, studentIdleSeconds: 90 }).ok);
  assert.equal(v.getSettings().codeLength, 14);
  v.checkCode('000000000000');
  const log = v.readLog();
  assert.ok(log.some(e => e.type === 'login_fail'));
  assert.ok(!JSON.stringify(log).includes('000000000000'));
  assert.equal(v.changeAdminPassword('wrong', 'newpass12').ok, false);
  assert.ok(v.changeAdminPassword('passw0rd!', 'newpass12').ok);
  assert.ok(v.verifyAdmin('newpass12').ok);
});

test('sessions: idle timeout ends session in main process', () => {
  let t = 0; const s = new Sessions(() => ({ studentIdleSeconds: 60, adminIdleSeconds: 120 }), () => t);
  s.startStudent({ id: 'x', roots: [] }); s.startAdmin();
  t = 50_000; assert.ok(s.touchStudent());
  t = 100_000; assert.ok(s.touchStudent());
  t = 200_000; assert.equal(s.touchStudent(), null);
  assert.deepEqual(s.sweep(), ['admin']);
});

test('copier: file, folder, collisions, symlinks, cleanup', async () => {
  const src = tmp(); const usb = tmp();
  mkTree(src, { 'a.pdf': 'AAA', 'dir/b.txt': 'B', 'dir/sub/c.txt': 'C' });
  try { fs.symlinkSync(os.tmpdir(), path.join(src, 'dir', 'escape'), 'dir'); } catch {}

  const f1 = await copyItem(path.join(src, 'a.pdf'), usb, null);
  assert.ok(f1.ok); assert.equal(fs.readFileSync(path.join(usb, 'a.pdf'), 'utf8'), 'AAA');
  const f2 = await copyItem(path.join(src, 'a.pdf'), usb, null);
  assert.equal(path.basename(f2.dest), 'a (1).pdf');

  const progress = [];
  const d1 = await copyItem(path.join(src, 'dir'), usb, '../../evil', p => progress.push(p.done));
  assert.ok(d1.ok); assert.equal(d1.files, 2);
  assert.ok(isInside(usb, d1.dest) && d1.dest !== usb);
  assert.ok(fs.existsSync(path.join(d1.dest, 'sub', 'c.txt')));
  assert.ok(!fs.existsSync(path.join(d1.dest, 'escape')));
  assert.deepEqual(progress, [1, 2]);

  const empty = path.join(src, 'empty'); fs.mkdirSync(empty);
  assert.equal((await copyItem(empty, usb, null)).ok, false);
  assert.equal((await copyItem(path.join(src, 'nope'), usb, null)).ok, false);
});

test('copier: failed folder copy leaves no partial folder', async () => {
  const src = tmp(); const usb = tmp();
  mkTree(src, { 'p/a.txt': '1', 'p/b.txt': '2' });
  const orig = fs.promises.copyFile; let n = 0;
  fs.promises.copyFile = async (...a) => { if (++n === 2) { const e = new Error('full'); e.code = 'ENOSPC'; throw e; } return orig(...a); };
  try {
    const r = await copyItem(path.join(src, 'p'), usb, null);
    assert.equal(r.ok, false); assert.match(r.msg, /מקום/);
    assert.deepEqual(fs.readdirSync(usb), []);
  } finally { fs.promises.copyFile = orig; }
});

test('drives: parse Windows output (single object, array, empty media)', () => {
  assert.deepEqual(parseWindowsDrives('[]'), []);
  assert.deepEqual(parseWindowsDrives(''), []);
  const one = parseWindowsDrives('{"letter":"e:","label":"","size":1000,"free":5}');
  assert.equal(one[0].id, 'E:\\'); assert.match(one[0].label, /דיסק נשלף \(E:\)/);
  const many = parseWindowsDrives('[{"letter":"E:","label":"תלמידים","size":8e9,"free":1},{"letter":"F:","label":"","size":0,"free":0},{"letter":"bad","size":1}]');
  assert.equal(many.length, 1); assert.equal(many[0].label, 'תלמידים (E:)');
});

test('drives: parse lsblk (old and new boolean formats)', () => {
  const j = o => JSON.stringify({ blockdevices: o });
  const a = parseLsblk(j([{ name: 'sda', rm: '0', mountpoint: null, children: [{ name: 'sda1', rm: '0', mountpoint: '/' }] },
                         { name: 'sdb', rm: '1', mountpoint: null, children: [{ name: 'sdb1', rm: '1', mountpoint: '/media/u/USB', label: 'USB' }] }]));
  assert.deepEqual(a.map(d => d.path), ['/media/u/USB']);
  const b = parseLsblk(j([{ name: 'sdc', rm: true, mountpoints: ['/run/media/x'], label: 'K' }]));
  assert.equal(b[0].path, '/run/media/x');
  assert.deepEqual(parseLsblk('not json'), []);
});

test('pdf html: escapes untrusted values and groups digits', () => {
  const html = renderCodesHtml({ title: '<script>x</script>', label: '"><img onerror=1>', folderNames: ['<b>'], codes: ['123456789012'], expiryDate: '2026-12-31', maxUses: 1, fontsDir: '/f' });
  assert.ok(!html.includes('<script>x') && !html.includes('<img onerror') && !html.includes('<b>'));
  assert.ok(html.includes('1234 5678 9012'));
  assert.ok(html.includes('31/12/2026') && html.includes('שימוש חד-פעמי'));
});

test('crypto: hash depends on salt', () => {
  assert.notEqual(hashCode('a', '1234'), hashCode('b', '1234'));
});


// ─── ספריית תיקיות ──────────────────────────────────────────────────────
test('folders: add / dedupe / list with usage and existence', () => {
  const { v } = newVault(); v.setupAdmin('passw0rd!');
  const d = tmp(); const real = fs.realpathSync(d);
  const a = v.addFolder({ path: real, name: '  שיעורים  ', note: 'הערה' });
  assert.ok(a.ok);
  assert.equal(v.addFolder({ path: real, name: 'אחר' }).ok, false);          // כפילות
  assert.equal(v.addFolder({ path: real }).existingId, a.id);
  assert.equal(v.addFolder({ path: '' }).ok, false);
  const [f] = v.listFolders();
  assert.equal(f.name, 'שיעורים'); assert.equal(f.uses, 0); assert.ok(f.exists);
  assert.equal(v.addFolder({ path: tmp(), name: '' }).ok, true);              // שם ריק → שם התיקייה
  fs.rmSync(d, { recursive: true });
  assert.equal(v.listFolders().find(x => x.id === a.id).exists, false);
});

test('folders: editing the path propagates to every code that uses it', () => {
  const { v } = newVault(); v.setupAdmin('passw0rd!');
  const oldDir = tmp(); const newDir = tmp();
  const fid = folderId(v, oldDir, 'כיתה א');
  const b = v.prepareBatch({ folderIds: [fid], count: 2, codeLength: 12 }); v.commitBatch(b.items);
  assert.equal(v.checkCode(b.items[0].code).roots[0], fs.realpathSync(oldDir));
  const r = v.updateFolder(fid, { path: fs.realpathSync(newDir), name: 'כיתה א׳ (חדש)' });
  assert.ok(r.ok); assert.equal(r.uses, 2);
  const ok = v.checkCode(b.items[1].code);
  assert.equal(ok.roots[0], fs.realpathSync(newDir));
  assert.equal(ok.folders[0].name, 'כיתה א׳ (חדש)');                          // השם הידידותי מוצג לתלמיד
  assert.equal(v.listCodes()[0].folders[0].path, fs.realpathSync(newDir));
  const other = folderId(v, tmp(), 'אחרת');
  assert.equal(v.updateFolder(fid, { path: v.data.folders[other].path }).ok, false);   // נתיב קיים כבר
  assert.equal(v.updateFolder('nope', { name: 'x' }).ok, false);
});

test('folders: removal is blocked while in use, and detach removes it from the codes', () => {
  const { v } = newVault(); v.setupAdmin('passw0rd!');
  const d1 = tmp(), d2 = tmp();
  const f1 = folderId(v, d1, 'א'), f2 = folderId(v, d2, 'ב');
  const b = v.prepareBatch({ folderIds: [f1, f2], count: 1, codeLength: 12 }); v.commitBatch(b.items);
  const code = b.items[0].code;
  const blocked = v.removeFolder(f1);
  assert.equal(blocked.ok, false); assert.equal(blocked.inUse, 1);
  assert.equal(v.listFolders().length, 2);
  assert.ok(v.removeFolder(f1, { detach: true }).ok);
  assert.equal(v.checkCode(code).folders.length, 1);                          // נשארה תיקייה אחת
  assert.ok(v.removeFolder(f2, { detach: true }).ok);
  assert.equal(v.checkCode(code).msg, 'לא שויכה תיקייה לקוד זה');            // קוד בלי תיקיות לא נכנס
  const unused = folderId(v, tmp(), 'ג');
  assert.ok(v.removeFolder(unused).ok);                                       // תיקייה שלא בשימוש נמחקת בלי אישור מיוחד
});

test('folders: migrating a v2 data file (codes with direct paths) builds the library', () => {
  const dir = tmp(); const a = tmp(), b = tmp();
  const { hashCode } = require('../src/core/crypto');
  const salt = 'abc';
  const rec = (id, folders) => ({ id, hint: '1111', label: '', folders, expiryDate: null, maxUses: 1, uses: 0, createdAt: 1, lastUsedAt: null });
  fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify({
    version: 2, salt, admin: null, settings: {}, security: {},
    codes: { [hashCode(salt, '111111111111')]: rec('c1', [a, b]), [hashCode(salt, '222222222222')]: rec('c2', [a]) }
  }));
  const v = new Vault({ dataDir: dir }).load();
  const lib = v.listFolders();
  assert.equal(lib.length, 2);                                                 // a מופיעה פעם אחת למרות ששני קודים משתמשים בה
  assert.equal(lib.find(f => f.path === a).uses, 2);
  const r = v.checkCode('111111111111');
  assert.ok(r.ok); assert.equal(r.folders.length, 2);
  v.save();
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'data.json'), 'utf8'));
  assert.equal(saved.version, 3);
  assert.ok(Object.values(saved.codes).every(c => Array.isArray(c.folderIds) && c.folders === undefined));
});
