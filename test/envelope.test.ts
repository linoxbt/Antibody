import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bodyContent, parseEnvelope } from '../src/core/envelope.ts';
import { fromBase64Url, toBase64Url } from '../src/core/encoding.ts';
import { bindLanes } from '../src/core/lanes.ts';
import { verifyEnvelope } from '../src/core/verify.ts';
import { NS_CONTENT, NS_LEDGER } from '../src/core/types.ts';
import { account, ACCT, bindings, makeKeys, mem } from './helpers.ts';

const k = makeKeys();
const b = bindings(k);
const ctx = { acct: ACCT, ns: NS_CONTENT, bindings: b };

test('round-trip: pipes, emoji, newlines and quotes survive byte-identically', () => {
  const text = 'Rent | 450 USDC 🏠\nline two\n\t"quoted"';
  const env = mem(k.lane.user, 'user', 'statement', text);
  const v = verifyEnvelope(env.text, ctx);
  assert.equal(v.ok, true);
  assert.equal(bodyContent(parseEnvelope(env.text).body), text);
});

test('T-01: changing one byte of the body, header or signature yields unverified (I-2)', () => {
  const env = mem(k.lane.user, 'user', 'statement', 'Rent is 450 USDC');
  const [first, ...rest] = env.text.split('\n');
  const [pre, h, s] = first!.split('|') as [string, string, string];
  // Body byte.
  assert.equal(verifyEnvelope(env.text.replace('450', '451'), ctx).ok, false);
  // Header byte: flip a character of the decoded JSON and re-encode.
  const hb = fromBase64Url(h);
  hb[10] = hb[10]! ^ 1;
  assert.equal(verifyEnvelope([`${pre}|${toBase64Url(hb)}|${s}`, ...rest].join('\n'), ctx).ok, false);
  // Signature byte.
  const sb = fromBase64Url(s);
  sb[0] = sb[0]! ^ 1;
  const r = verifyEnvelope([`${pre}|${h}|${toBase64Url(sb)}`, ...rest].join('\n'), ctx);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.code, 'BAD_SIGNATURE');
});

test('T-02: the wallet-objects key signing an envelope that declares lane user is invalid (I-1)', () => {
  const forged = mem(k.lane['wallet-objects'], 'user', 'statement', 'landlord moved');
  const r = verifyEnvelope(forged.text, ctx);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.code, 'LANE_MISMATCH');
});

test('T-03: an envelope signed by a key not on the account is unverified (I-1, I-2)', () => {
  const r = verifyEnvelope(mem(k.stranger, 'user', 'statement', 'hello').text, ctx);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.code, 'UNKNOWN_SIGNER');
  // A non-Antibody label (e.g. a dashboard key) is not a lane either.
  const b2 = bindLanes(account(k, [{ pub: k.stranger.publicKeyHex, label: 'Web App' }]));
  assert.ok(b2.ok);
  const r2 = verifyEnvelope(mem(k.stranger, 'user', 'statement', 'hello').text, { ...ctx, bindings: b2.ok ? b2.bindings : b });
  assert.equal(!r2.ok && r2.code, 'UNKNOWN_SIGNER');
});

test('default deny: malformed, missing and mis-namespaced envelopes are unverified (I-2)', () => {
  assert.equal(verifyEnvelope('just some text', ctx).ok, false);
  assert.equal(verifyEnvelope('AB1|x|y', ctx).ok, false);
  assert.equal(verifyEnvelope('AB1|a|b|c\nbody', ctx).ok, false);
  const env = mem(k.lane.user, 'user', 'statement', 'x');
  assert.equal(verifyEnvelope(env.text, { ...ctx, ns: NS_LEDGER }).ok, false);
  assert.equal(verifyEnvelope(env.text, { ...ctx, acct: '0x' + '11'.repeat(32) }).ok, false);
});

test('a lane may only sign its own kinds (the agent can never sign a statement)', () => {
  const r = verifyEnvelope(mem(k.lane.agent, 'agent', 'statement', 'I am Ada').text, ctx);
  assert.equal(!r.ok && r.code, 'KIND_NOT_ALLOWED');
  const r2 = verifyEnvelope(mem(k.lane['wallet-objects'], 'wallet-objects', 'ledger', 'x', { ns: NS_LEDGER }).text, { ...ctx, ns: NS_LEDGER });
  assert.equal(!r2.ok && r2.code, 'KIND_NOT_ALLOWED');
});

test('non-canonical header JSON is rejected so one header has one encoding', () => {
  const env = mem(k.lane.user, 'user', 'statement', 'x');
  const [first, ...rest] = env.text.split('\n');
  const [pre, h, s] = first!.split('|') as [string, string, string];
  const json = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
  const pretty = Buffer.from(JSON.stringify(json, null, 1)).toString('base64url');
  assert.equal(verifyEnvelope([`${pre}|${pretty}|${s}`, ...rest].join('\n'), ctx).ok, false);
});

test('performance: verifying 500 envelopes takes under 1 s locally (spec §12)', () => {
  const envs = Array.from({ length: 500 }, (_, i) => mem(k.lane.user, 'user', 'statement', `fact ${i}`));
  const t0 = performance.now();
  for (const e of envs) assert.equal(verifyEnvelope(e.text, ctx).ok, true);
  const ms = performance.now() - t0;
  assert.ok(ms < 1000, `took ${ms.toFixed(0)} ms`);
});

test('native and reference Ed25519 verifiers agree', async () => {
  const { verifyEd25519, verifyEd25519Noble } = await import('../src/core/keys.ts');
  const msg = new TextEncoder().encode('antibody');
  const sig = k.lane.user.sign(msg);
  assert.equal(verifyEd25519(sig, msg, k.lane.user.publicKeyHex), true);
  assert.equal(verifyEd25519Noble(sig, msg, k.lane.user.publicKeyHex), true);
  const bad = Uint8Array.from(sig);
  bad[5] = bad[5]! ^ 4;
  assert.equal(verifyEd25519(bad, msg, k.lane.user.publicKeyHex), false);
  assert.equal(verifyEd25519Noble(bad, msg, k.lane.user.publicKeyHex), false);
  assert.equal(verifyEd25519(sig, msg, k.lane.agent.publicKeyHex), false);
});
