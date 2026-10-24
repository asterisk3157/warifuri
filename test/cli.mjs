// Runs the warifuri command for the tests, away from the settings of whoever runs them:
// no WARIFURI_ variable is passed on, and the data directory is a fresh one unless given.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'warifuri.mjs');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'warifuri-cli-'));
process.on('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));

// The environment for one run: PATH and HOME of the test, no WARIFURI_ variable, then env.
export function cliEnv({ home = path.join(scratch, 'home'), env = {} } = {}) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('WARIFURI_')));
  return { ...base, WARIFURI_HOME: home, ...env };
}

export function cli(args, options = {}) {
  return spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', CLI, ...args], {
    encoding: 'utf8',
    env: cliEnv(options),
    timeout: 10_000,
  });
}
