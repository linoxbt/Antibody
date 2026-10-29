#!/usr/bin/env node
// Runs the TypeScript CLI directly (no build step), per spec §11: tsx + node:test.
import { register } from 'tsx/esm/api';
register();
await import('../src/cli/index.ts');
