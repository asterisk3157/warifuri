// The example settings in examples/: each file is one warifuri reads, written so that it reads
// as it says (known settings only, no secrets, the secretary listed, the profiles' colours).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETTINGS, decodeText } from '../src/config.mjs';
import { profileFolder, secretaryConfigured } from '../src/knowledge/profiles.mjs';

const EXAMPLES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples');

const settingLines = (file) =>
  decodeText(fs.readFileSync(file))
    .text.split(/\r?\n/)
    .filter((l) => l.trim() !== '' && !l.trimStart().startsWith('#'))
    .map((l) => l.slice(0, l.indexOf('=')).trim());

test('the example warifuri.env files name known settings only, and no secret', () => {
  const known = new Map(SETTINGS.map((s) => [s.name, s]));
  for (const dir of ['server', 'laptop']) {
    const names = settingLines(path.join(EXAMPLES, dir, 'warifuri.env'));
    assert.ok(names.length > 0, dir);
    for (const n of names) {
      assert.ok(known.has(n), `${dir}: ${n}`);
      assert.notEqual(known.get(n).secret, true, `${dir}: ${n} is a secret`);
    }
  }
  assert.equal(fs.existsSync(path.join(EXAMPLES, 'server', 'secrets.env')), false);
});

test('the example server lists the secretary, and each profile sits in its own folder with a colour', () => {
  const home = path.join(EXAMPLES, 'server');
  assert.equal(secretaryConfigured(home), true);
  const folders = fs.readdirSync(path.join(home, 'profiles'));
  assert.deepEqual(folders.sort(), ['個人開発', '研究'].sort());
  for (const name of folders) {
    assert.equal(profileFolder(name), name);
    const yaml = fs.readFileSync(path.join(home, 'profiles', name, 'profile.yaml'), 'utf8');
    assert.match(yaml, /^color:\s*"#[0-9a-f]{6}"\s*$/m, name);
    assert.ok(fs.existsSync(path.join(home, 'profiles', name, 'knowledge.md')), name);
  }
});
