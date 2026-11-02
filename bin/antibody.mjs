#!/usr/bin/env node
// Runs the TypeScript CLI directly (no build step), per spec §11: tsx + node:test.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { register } from 'tsx/esm/api';

// Settings file: ~/.antibody/antibody.env (or ANTIBODY_ENV_FILE). Variables already set in the shell win.
const tilde = (p) => (p === '~' ? homedir() : /^~[\\/]/.test(p) ? join(homedir(), p.slice(2)) : p);
const home = process.env.ANTIBODY_HOME?.trim() ? tilde(process.env.ANTIBODY_HOME.trim()) : join(homedir(), '.antibody');
const envFile = process.env.ANTIBODY_ENV_FILE?.trim() ? tilde(process.env.ANTIBODY_ENV_FILE.trim()) : join(home, 'antibody.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

register();
await import('../src/cli/index.ts');
