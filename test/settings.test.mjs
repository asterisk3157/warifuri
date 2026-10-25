// Tests for the person's settings that scheduling reads (src/ledger/settings.mjs): the
// defaults, the checked shapes of life, places and limits, the by_person rule of limits
// (原則14), the records, and the settings tool over MCP.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openLedger, LedgerError } from '../src/ledger/ledger.mjs';
import { readSettings, writeSettings, LIMIT_DEFAULTS } from '../src/ledger/settings.mjs';
import { createServer } from '../src/server/mcp.mjs';

const AGENT = { actor: 'device-key', device: 'laptop' };

function fresh(t) {
  const L = openLedger(':memory:');
  t.after(() => L.close());
  return L;
}

// The problems of a refused write.
function refused(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof LedgerError, err.message);
    return err.problems;
  }
  assert.fail('the write was not refused');
}

test('unset settings read as their defaults, and say which fields are unset', (t) => {
  const L = fresh(t);
  const s = readSettings(L);
  assert.deepEqual(s.life, { rules: [] });
  assert.deepEqual(s.places, { places: [], travel: [] });
  assert.deepEqual(s.limits, { day_max_hours: 8, block_min_minutes: 30, block_max_minutes: 120, earliest: '09:00', latest: '21:00' });
  assert.deepEqual(s.limits, LIMIT_DEFAULTS);
  assert.deepEqual(s.defaults, { life: ['rules'], places: ['places', 'travel'], limits: Object.keys(LIMIT_DEFAULTS) });
  // The profile written by the Web screen is a different section and is not touched.
  L.setSettings('profile', { name: 'Aoi' }, AGENT);
  assert.deepEqual(readSettings(L).life, { rules: [] });
});

test('life and places are written by an agent, checked, and recorded', (t) => {
  const L = fresh(t);
  const out = writeSettings(L, { life: { rules: [' 平日は 0:00 から 7:00 まで寝る ', '昼食は 12:00 から 1時間'] } }, {}, AGENT);
  assert.deepEqual(out.life.rules, ['平日は 0:00 から 7:00 まで寝る', '昼食は 12:00 から 1時間']);
  assert.deepEqual(out.defaults.life, []);
  assert.deepEqual(L.records('life').map((r) => [r.entity, r.action, r.actor, r.device]), [['settings', 'update', 'device-key', 'laptop']]);

  const places = {
    places: [{ name: '家' }, { name: '大学', note: '研究室は3階' }, { name: '駅' }],
    travel: [{ from: '家', to: '大学', minutes: 40 }, { from: '駅', to: '大学', minutes: 10 }],
  };
  assert.deepEqual(writeSettings(L, { places }, {}, AGENT).places, places);

  // New places without travel keep the times between places that remain.
  const fewer = writeSettings(L, { places: { places: [{ name: '家' }, { name: '大学' }] } }, {}, AGENT);
  assert.deepEqual(fewer.places.travel, [{ from: '家', to: '大学', minutes: 40 }]);
  // Travel alone is checked against the places already there.
  const problems = refused(() => writeSettings(L, { places: { travel: [{ from: '家', to: '駅', minutes: 5 }] } }, {}, AGENT));
  assert.deepEqual(problems, ['places.travel の 1 件目の 駅 は、places.places にない場所です']);

  // null puts a section back to its defaults.
  const reset = writeSettings(L, { places: null }, {}, AGENT);
  assert.deepEqual(reset.places, { places: [], travel: [] });
  assert.deepEqual(reset.defaults.places, ['places', 'travel']);
});

test('bad shapes of life and places are refused with every problem in Japanese', (t) => {
  const L = fresh(t);
  const life = refused(() => writeSettings(L, { life: { rules: ['ok', '', 'two\nlines', 3], sleep: '7h' } }, {}, AGENT));
  assert.deepEqual(life, [
    'life に sleep は書けません(書けるのは rules)',
    'life.rules の 2 件目が空です',
    'life.rules の 3 件目には改行や制御文字を入れられません',
    'life.rules の 4 件目は文字列です',
  ]);
  const places = refused(() =>
    writeSettings(
      L,
      {
        places: {
          places: [{ name: '家' }, { name: '家' }, { name: '大学' }],
          travel: [{ from: '家', to: '大学', minutes: 30 }, { from: '大学', to: '家', minutes: 30 }, { from: '家', to: '家', minutes: 1.5 }],
        },
      },
      {},
      AGENT,
    ),
  );
  assert.deepEqual(places, [
    '場所 家 が2回あります',
    '大学 と 家 のあいだの移動時間が2回あります(片道を1回書けば、帰りも同じとみなします)',
    'places.travel の 3 件目は、同じ場所どうしです',
    'places.travel の 3 件目の minutes は 0 から 1440 までの整数(分)です',
  ]);
  assert.deepEqual(L.records('life'), []);
  assert.deepEqual(L.records('places'), []);
});

test('limits are written only as the person\'s decision, and recorded as decide', (t) => {
  const L = fresh(t);
  const problems = refused(() => writeSettings(L, { limits: { day_max_hours: 10 } }, {}, AGENT));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /本人だけ/);
  assert.match(problems[0], /by_person: true/);
  assert.match(problems[0], /提案/);
  // Nothing else in the same call is written either.
  assert.equal(refused(() => writeSettings(L, { life: { rules: ['朝は走る'] }, limits: { day_max_hours: 10 } }, {}, AGENT)).length, 1);
  assert.deepEqual(readSettings(L).life.rules, []);

  const out = writeSettings(L, { limits: { day_max_hours: 6.5, latest: '24:00' } }, { byPerson: true }, AGENT);
  assert.deepEqual(out.limits, { ...LIMIT_DEFAULTS, day_max_hours: 6.5, latest: '24:00' });
  assert.deepEqual(out.defaults.limits, ['block_min_minutes', 'block_max_minutes', 'earliest']);
  const [rec] = L.records('limits');
  assert.equal(rec.action, 'decide');
  assert.deepEqual(rec.changes, { day_max_hours: { before: null, after: '6.5' }, latest: { before: null, after: '"24:00"' } });

  // null puts one field back to its default; the others stay.
  const back = writeSettings(L, { limits: { latest: null } }, { byPerson: true }, AGENT);
  assert.equal(back.limits.latest, '21:00');
  assert.equal(back.limits.day_max_hours, 6.5);
  assert.ok(back.defaults.limits.includes('latest'));
});

test('limits must be numbers in range and times as HH:MM that hold together', (t) => {
  const L = fresh(t);
  const person = { byPerson: true };
  assert.deepEqual(refused(() => writeSettings(L, { limits: { day_max_hours: 25, block_min_minutes: 3, earliest: '9:00', breaks: 1 } }, person, AGENT)), [
    'limits に breaks は書けません(書けるのは day_max_hours、block_min_minutes、block_max_minutes、earliest、latest)',
    'limits.day_max_hours は 0 より大きく 24 までの時間で、15分(0.25)きざみです',
    'limits.block_min_minutes は 5 から 1440 までの整数(分)です',
    'limits.earliest は HH:MM(00:00 から 24:00)で書きます',
  ]);
  assert.match(refused(() => writeSettings(L, { limits: { day_max_hours: 7.1 } }, person, AGENT))[0], /0.25/);
  assert.deepEqual(refused(() => writeSettings(L, { limits: { block_min_minutes: 150 } }, person, AGENT)), ['limits.block_min_minutes は block_max_minutes 以下にします']);
  assert.deepEqual(refused(() => writeSettings(L, { limits: { earliest: '22:00' } }, person, AGENT)), ['limits.earliest は latest より前にします']);
  assert.deepEqual(refused(() => writeSettings(L, { limits: { earliest: '20:45' } }, person, AGENT)), ['earliest から latest までが、block_min_minutes より短くなっています']);
  assert.deepEqual(refused(() => writeSettings(L, { limits: { latest: '24:30' } }, person, AGENT)), ['limits.latest は HH:MM(00:00 から 24:00)で書きます']);
  assert.deepEqual(L.records('limits'), []);
});

test('MCP: settings reads with no section, writes as the device, and refuses limits without by_person', async (t) => {
  const ledger = openLedger(':memory:');
  const key = ledger.issueKey('laptop', { actor: 'human' }).key;
  const server = createServer({ ledger });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new Client({ name: 'test', version: '0.0.0' });
  t.after(async () => {
    await client.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    ledger.close();
  });
  const url = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  const call = async (args = {}) => {
    const res = await client.callTool({ name: 'settings', arguments: args });
    return { res, data: res.isError ? null : JSON.parse(res.content[0].text), text: res.content[0].text };
  };

  const read = await call();
  assert.deepEqual(read.data.limits, LIMIT_DEFAULTS);
  assert.deepEqual(read.res.structuredContent, read.data);

  const life = await call({ life: { rules: ['夕食は 19:00 から'] } });
  assert.deepEqual(life.data.life.rules, ['夕食は 19:00 から']);
  assert.deepEqual(ledger.records('life').map((r) => [r.actor, r.device]), [['device-key', 'laptop']]);

  const no = await call({ limits: { day_max_hours: 4 } });
  assert.equal(no.res.isError, true);
  assert.match(no.text, /^書けませんでした。/);
  assert.match(no.text, /本人だけ/);
  const yes = await call({ limits: { day_max_hours: 4 }, by_person: true });
  assert.equal(yes.data.limits.day_max_hours, 4);
  assert.equal((await call()).data.limits.day_max_hours, 4);
});
