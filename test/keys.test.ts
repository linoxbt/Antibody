/** T-19: a process for one role cannot use another role's key file (I-12). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { generateSeedHex } from '../src/core/keys.ts';
import { checkIsolation, keyPath, KeyIsolationError, loadLaneKey, writeKeyFile } from '../src/keystore.ts';

function home() {
  const h = mkdtempSync(join(tmpdir(), 'ab-keys-'));
  for (const r of ['control', 'user', 'agent', 'ingest'] as const) writeKeyFile(h, r, generateSeedHex());
  return h;
}

test('T-19: with enforcement on, a role that can read another role\'s key refuses to start', () => {
  const h = home();
  try {
    const cfg = loadConfig({ ANTIBODY_HOME: h, ANTIBODY_BACKEND: 'live', ANTIBODY_KEY_ISOLATION: 'enforce' });
    // Everything is readable by this one OS user, so the agent must refuse.
    assert.throws(() => loadLaneKey(cfg, 'agent'), KeyIsolationError);
    assert.deepEqual(checkIsolation(cfg, 'agent').readableForeign.sort(), ['control', 'ingest', 'user']);
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test('T-19: once other roles\' key files are unreadable, the role starts (skipped as root, which reads everything)', { skip: process.getuid?.() === 0 }, () => {
  const h = home();
  try {
    for (const r of ['control', 'user', 'ingest'] as const) chmodSync(keyPath(h, r), 0o000);
    const cfg = loadConfig({ ANTIBODY_HOME: h, ANTIBODY_BACKEND: 'live', ANTIBODY_KEY_ISOLATION: 'enforce' });
    assert.ok(loadLaneKey(cfg, 'agent').publicKeyHex);
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test('ANTIBODY_ROLE pins a process to one role', () => {
  const h = home();
  try {
    const cfg = loadConfig({ ANTIBODY_HOME: h, ANTIBODY_BACKEND: 'offline', ANTIBODY_ROLE: 'agent' });
    assert.throws(() => loadLaneKey(cfg, 'control'), /runs as role "control" but ANTIBODY_ROLE=agent/);
    assert.ok(loadLaneKey(cfg, 'agent'));
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});

test('key files are 0600 and are never overwritten', () => {
  const h = home();
  try {
    assert.throws(() => writeKeyFile(h, 'agent', generateSeedHex()), /refusing to overwrite/);
    chmodSync(keyPath(h, 'agent'), 0o644);
    const cfg = loadConfig({ ANTIBODY_HOME: h, ANTIBODY_BACKEND: 'offline' });
    assert.throws(() => loadLaneKey(cfg, 'agent'), /must be mode 0600/);
  } finally {
    rmSync(h, { recursive: true, force: true });
  }
});
