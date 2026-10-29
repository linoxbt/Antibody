#!/usr/bin/env node
// Runs the TypeScript CLI directly (no build step), per spec §11: tsx + node:test.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { register } from 'tsx/esm/api';

// Settings file: ~/.antibody/antibody.env (or ANTIBODY_ENV_FILE). Variables already set in the shell win.
const envFile = process.env.ANTIBODY_ENV_FILE ?? join(process.env.ANTIBODY_HOME ?? join(homedir(), '.antibody'), 'antibody.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

register();
await import('../src/cli/index.ts');
