/** T-15: no Antibody module calls forget, delete or any destructive relayer endpoint (I-7). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

const SOURCES = [...files('src'), ...files('scripts')];

test('T-15: no source file calls forget, delete or clear on a memory backend', () => {
  const banned = [
    /\.forget\s*\(/,
    /\b(mem|mw|memwal|memory|client|relayer)\.(delete\w*|clear|remove\w*|forget\w*)\s*\(/i,
    /\/api\/(forget|delete)/i,
    /security[-_]?delete/i,
  ];
  const hits = SOURCES.flatMap((f) =>
    readFileSync(f, 'utf8')
      .split('\n')
      .map((line, i) => ({ f, i: i + 1, line }))
      .filter(({ line }) => banned.some((re) => re.test(line))),
  );
  assert.deepEqual(hits, []);
});

test('envelopes are never written through analyze() and never with dedupe: true (spec §5)', () => {
  const hits = SOURCES.filter((f) => /\.analyze(AndWait)?\s*\(|dedupe\s*:\s*true/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(hits, []);
});

test('the policy engine and lineage engine are pure: no I/O, clock or model imports in src/core', () => {
  const impure = files('src/core').filter((f) => /from 'node:(fs|net|http|child_process)'|Date\.now\(|fetch\(|Math\.random\(|openai/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(impure, []);
});
