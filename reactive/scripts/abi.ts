// Write each contract's ABI to abi/<Contract>.json (committed): the Guard service reads these, so it
// needs neither the compiler nor the Reactive library at runtime. Run after `npm run build`.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const root = new URL('..', import.meta.url).pathname;
mkdirSync(`${root}abi`, { recursive: true });
for (const c of ['GuardVault', 'GuardReactive', 'RiskOracle', 'IGuardVault']) {
  const a = JSON.parse(readFileSync(`${root}artifacts/contracts/${c}.sol/${c}.json`, 'utf8'));
  writeFileSync(`${root}abi/${c}.json`, JSON.stringify(a.abi, null, 1) + '\n');
}
// The vault's runtime code with its immutable positions, so the Guard service can recognize a genuine
// GuardVault before it asks GuardReactive to watch it, and so the console and the CLI can deploy one.
const v = JSON.parse(readFileSync(`${root}artifacts/contracts/GuardVault.sol/GuardVault.json`, 'utf8'));
writeFileSync(`${root}abi/GuardVault.code.json`, JSON.stringify({ bytecode: v.bytecode, deployedBytecode: v.deployedBytecode, immutableReferences: v.immutableReferences }) + '\n');
console.log('abi/ written');
