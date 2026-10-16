import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  assertSafeGitUrl,
  assertSafeHttpUrl,
  sanitizeFileName,
  sanitizeRepoDirName,
  joinInside,
} from '../src/engine/util/urlsafe.js';

test('rejects git argument injection through URLs', () => {
  assert.throws(() => assertSafeGitUrl('--upload-pack=touch /tmp/pwned'), /不能以 "-" 开头/);
  assert.throws(() => assertSafeGitUrl('-oProxyCommand=calc.exe'), /不能以 "-" 开头/);
  assert.throws(() => assertSafeGitUrl('https://ok.example/repo\n--upload-pack=x'), /非法字符/);
  assert.throws(() => assertSafeGitUrl('--config=core.sshCommand=evil'), /不能以 "-" 开头/);
});

test('rejects empty, relative and unsupported URLs', () => {
  assert.throws(() => assertSafeGitUrl(''), /为空/);
  assert.throws(() => assertSafeGitUrl('foo/bar'), /不支持的地址形式/);
  assert.throws(() => assertSafeGitUrl('ftp://host/repo'), /不支持的地址形式/);
});

test('accepts supported URL forms', () => {
  assert.equal(assertSafeGitUrl('https://github.com/user/repo.git'), 'https://github.com/user/repo.git');
  assert.equal(assertSafeGitUrl('git@github.com:user/repo.git'), 'git@github.com:user/repo.git');
  assert.equal(assertSafeGitUrl('ssh://git@host:2222/user/repo.git'), 'ssh://git@host:2222/user/repo.git');
  assert.equal(assertSafeGitUrl('file:///C:/repos/x.git'), 'file:///C:/repos/x.git');
  assert.equal(assertSafeGitUrl('C:\\repos\\x.git'), 'C:\\repos\\x.git');
});

test('rejects non-http(s) download URLs', () => {
  assert.throws(() => assertSafeHttpUrl('file:///etc/passwd'), /仅支持 http\/https/);
  assert.throws(() => assertSafeHttpUrl('javascript:alert(1)'), /仅支持 http\/https/);
  assert.equal(assertSafeHttpUrl('https://example.com/a.bin'), 'https://example.com/a.bin');
});

test('sanitizes traversal and hostile file names', () => {
  assert.equal(sanitizeFileName('../../evil.txt'), 'evil.txt');
  assert.equal(sanitizeFileName('..\\..\\windows\\system32\\evil.exe'), 'evil.exe');
  assert.equal(sanitizeFileName('/etc/passwd'), 'passwd');
  assert.equal(sanitizeFileName('a/b/c.bin'), 'c.bin');
  assert.equal(sanitizeFileName('CON'), '_CON');
  assert.equal(sanitizeFileName('con.txt'), '_con.txt');
  assert.equal(sanitizeFileName('name. '), 'name');
  assert.equal(sanitizeFileName('..'), 'download');
  assert.equal(sanitizeFileName(''), 'download');
  assert.equal(sanitizeFileName('a\u0000b\u001fc.bin'), 'abc.bin');
  assert.equal(sanitizeFileName('with:colon*star?.bin'), 'with_colon_star_.bin');
  assert.ok(!sanitizeFileName('x'.repeat(500)).includes('/'));
  assert.equal(sanitizeFileName('x'.repeat(500)).length, 180);
});

test('derives a safe directory name from repository URLs', () => {
  assert.equal(sanitizeRepoDirName('https://github.com/user/repo.git'), 'repo');
  assert.equal(sanitizeRepoDirName('https://github.com/user/repo/'), 'repo');
  assert.equal(sanitizeRepoDirName('git@github.com:user/repo.git'), 'repo');
  assert.equal(sanitizeRepoDirName('https://github.com/user/weird%20name.git'), 'weird name');
  assert.equal(sanitizeRepoDirName('https://github.com/../../etc/passwd'), 'passwd');
  assert.equal(sanitizeRepoDirName(''), 'repo');
});

test('joinInside refuses to escape the base directory', () => {
  // Platform-portable: path.join produces the right separator on Windows/Linux.
  const base = path.resolve(path.sep === '\\' ? 'C:\\base' : '/base');
  assert.equal(joinInside(base, path.join('sub', 'dir')), path.join(base, 'sub', 'dir'));
  assert.throws(() => joinInside(base, path.join('..', 'evil')), /越出/);
  assert.throws(() => joinInside(base, path.resolve(base, '..', '..', 'other')), /越出/);
});
