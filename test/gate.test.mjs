// Tests for the start gate: `warifuri hook gate` against a stub server answering /api/held,
// and the reading of the hook JSON of Claude Code and Codex.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CLI, cliEnv } from './cli.mjs';
import { dirsToAsk, patchFiles } from '../src/client/gate.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warifuri-gate-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const KEY = 'wf_gate-test-key-0123456789';
const work = path.join(tmp, 'work');
fs.mkdirSync(path.join(work, 'held'), { recursive: true });
fs.mkdirSync(path.join(work, 'free'), { recursive: true });
fs.mkdirSync(path.join(work, 'outside'), { recursive: true });

// The stub server: the answer depends on the last part of dir.
const asked = [];
let server;
let url;
before(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const dir = u.searchParams.get('dir') ?? '';
    asked.push({ path: u.pathname, dir, auth: req.headers.authorization });
    if (req.headers.authorization !== `Bearer ${KEY}`) return res.writeHead(401).end();
    const last = path.basename(dir);
    const place = { id: 'p1', name: 'work', profile: 'hobby' };
    if (last === 'boom') return res.writeHead(500).end('{}');
    if (last === 'slow') return setTimeout(() => res.writeHead(200, { 'content-type': 'application/json' }).end('{"task":null,"place":{"name":"slow"}}'), 5000);
    const body = last === 'held' ? { task: { id: 't1' }, place } : last === 'outside' ? { task: null, place: null } : { task: null, place };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

// A data directory with the client settings.
function home({ serverUrl = url, key = KEY, gate } = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, 'home-'));
  const lines = [];
  if (serverUrl) lines.push(`WARIFURI_SERVER_URL=${serverUrl}`);
  if (gate) lines.push(`WARIFURI_GATE=${gate}`);
  fs.writeFileSync(path.join(dir, 'warifuri.env'), `${lines.join('\n')}\n`);
  if (key) fs.writeFileSync(path.join(dir, 'device.key'), `${key}\n`, { mode: 0o600 });
  return dir;
}

// Runs `warifuri hook gate` with the payload on stdin, without blocking the stub server.
function gate(payload, { dir = home(), env = {} } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', CLI, 'hook', 'gate'], { env: cliEnv({ home: dir, env }) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ status, stdout, stderr, ms: Date.now() - started }));
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}

const edit = (file, tool = 'Edit') => ({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { file_path: file }, cwd: work });

test('a held task lets the edit through, and the key goes in the header', async () => {
  asked.length = 0;
  const r = await gate(edit(path.join(work, 'held', 'a.txt')));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.deepEqual(asked.map((a) => [a.path, a.dir, a.auth]), [['/api/held', path.join(work, 'held'), `Bearer ${KEY}`]]);
  assert.ok(!r.stdout.includes(KEY) && !r.stderr.includes(KEY));
});

test('a directory in no place lets the edit through', async () => {
  const r = await gate(edit(path.join(work, 'outside', 'a.txt'), 'Write'));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('a place with no held task is refused with what to do, for Claude Code and for Codex', async () => {
  const r = await gate(edit(path.join(work, 'free', 'a.txt'), 'MultiEdit'));
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  const reason = out.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /作業フォルダ「work」/);
  assert.match(reason, /search/);
  assert.match(reason, /create_task/);
  assert.ok(reason.includes(`place="${path.join(work, 'free')}"`));
  assert.ok(!r.stdout.includes(KEY));

  // Codex: apply_patch, with paths relative to the session's directory.
  const patch = ['*** Begin Patch', '*** Update File: held/a.txt', '@@', '-a', '+b', '*** Add File: free/b.txt', '+x', '*** End Patch'].join('\n');
  const codex = await gate({ hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: patch }, cwd: work });
  assert.equal(JSON.parse(codex.stdout).hookSpecificOutput.permissionDecision, 'deny');

  const nb = await gate({ tool_name: 'NotebookEdit', tool_input: { notebook_path: path.join(work, 'free', 'n.ipynb') }, cwd: work });
  assert.equal(JSON.parse(nb.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('other tools and unreadable payloads are let through without asking', async () => {
  asked.length = 0;
  for (const p of [{ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: work }, 'not json', '', { tool_name: 'Edit', tool_input: {} }, { tool_name: 'Edit', tool_input: { file_path: 'rel.txt' } }]) {
    const r = await gate(p);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  }
  assert.equal(asked.length, 0);
});

test('fails open: no key, no URL, gate off, server errors, server down, server slow', async () => {
  const free = edit(path.join(work, 'free', 'a.txt'));
  for (const dir of [home({ key: null }), home({ serverUrl: null }), home({ gate: 'off' }), home({ serverUrl: 'not a url' }), home({ key: 'wf_wrong' })]) {
    const r = await gate(free, { dir });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '', r.stderr);
  }
  fs.mkdirSync(path.join(work, 'boom'), { recursive: true });
  assert.equal((await gate(edit(path.join(work, 'boom', 'a.txt')))).stdout, '');

  // Nothing listens there.
  const closed = http.createServer();
  await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  const dead = `http://127.0.0.1:${closed.address().port}`;
  await new Promise((r) => closed.close(r));
  assert.equal((await gate(free, { dir: home({ serverUrl: dead }) })).stdout, '');

  fs.mkdirSync(path.join(work, 'slow'), { recursive: true });
  const slow = await gate(edit(path.join(work, 'slow', 'a.txt')));
  assert.equal(slow.stdout, '');
  assert.ok(slow.ms < 4500, `took ${slow.ms} ms`);
});

test('the directory asked about: the nearest existing parent of a new file, relative paths from cwd', () => {
  const exists = (d) => [work, path.join(work, 'free')].includes(d) || d === path.parse(work).root;
  assert.deepEqual(dirsToAsk({ tool_name: 'Write', tool_input: { file_path: path.join(work, 'free', 'new', 'deep', 'a.txt') }, cwd: '/' }, { exists }), [path.join(work, 'free')]);
  assert.deepEqual(dirsToAsk({ tool_name: 'Edit', tool_input: { file_path: 'free/a.txt' }, cwd: work }, { exists }), [path.join(work, 'free')]);
  assert.deepEqual(dirsToAsk({ tool_name: 'Edit', tool_input: { file_path: 'free/a.txt' } }, { exists }), []);
  assert.deepEqual(dirsToAsk({ tool_name: 'Read', tool_input: { file_path: path.join(work, 'a') }, cwd: work }, { exists }), []);
  assert.deepEqual(
    patchFiles('*** Begin Patch\n*** Update File: a/b.txt\n*** Move to: c/d.txt\n*** Delete File: e.txt\n*** End Patch'),
    ['a/b.txt', 'c/d.txt', 'e.txt'],
  );
});
