#!/usr/bin/env node
// The `guard` command: runs cli/guard.ts through tsx (installed with the package).
import { register } from 'tsx/esm/api';
register();
await import('../cli/guard.ts');
