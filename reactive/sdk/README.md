# antibody-guard (SDK)

TypeScript SDK for [Antibody Guard](https://github.com/linoxbt/Antibody-gaurd): an immune system for AI
agents, for their money and their memory, enforced on-chain and by Reactive Network. Built on
[viem](https://viem.sh). Testnets: Base Sepolia, Ethereum Sepolia, Reactive Lasna.

```sh
# from this repository (until it is published to npm)
cd sdk && npm ci && npm run build && npm pack      # → antibody-guard-0.1.0.tgz
npm install ./antibody-guard-0.1.0.tgz viem       # in your project
```

## The two checks an agent should make

```ts
import { GuardApi, GuardMemory, guardedAgent } from 'antibody-guard';

const guard = guardedAgent(new GuardApi());

await guard.beforePaying(invoice.payTo);      // throws GuardRefusal for a known attacker
await guard.beforeActingOn(memory, entryId);  // throws if the memory came from a quarantined source
```

## API client (no key)

```ts
const api = new GuardApi();                      // https://antibody-guard-reactive.netlify.app
await api.check('0x…');                          // { knownAttacker, verdict: 'block' | 'unknown', advice }
await api.attacker('0x…');                       // where it is blocked (read from every vault and memory now)
await api.recall('baseSepolia', memory, 2);      // { source, status: 'usable' | 'quarantined-source' | 'forgotten', usable }
await api.source('baseSepolia', memory, '0x…');  // everything a source planted in a memory
await api.score({ body: emailText, from });      // the AI risk scorer; 80+ is reported and quarantined everywhere
await api.watch('baseSepolia', yourContract);    // GuardReactive starts watching your vault or memory
```

Also `status()`, `attackers()`, `vaults()`, `vault()`, `memories()`, `loops()`, `events()`. Errors are
`GuardApiError` with the HTTP `status`.

## Your own guarded memory

```ts
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { GuardApi, deployMemory } from 'antibody-guard';

const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });
const walletClient = createWalletClient({ account: privateKeyToAccount(OWNER_KEY), chain: baseSepolia, transport: http() });

const memory = await deployMemory({ chain: 'baseSepolia', publicClient, walletClient, writer: AGENT_ADDRESS, fund: '0.003' });
await memory.setGuardian();                              // GuardReactive v5 becomes its guardian
await new GuardApi().watch('baseSepolia', memory.address); // and watches it: immunized with every lesson at once
```

As the agent (a wallet client for the writer key):

```ts
const { id, refused } = await memory.remember(emailText, senderAddress, 'email'); // only the hash goes on-chain
if (refused !== 'None') console.log('not remembered:', refused);                  // 'QuarantinedSource' or 'Frozen'
const entry = await memory.recall(id);                                             // { source, status, usable, ... }
await memory.matches(id, emailText);                                               // your copy is the one recorded
```

As the owner: `quarantineSource(source)` (every memory from it becomes unusable, and GuardReactive blocks
it on every vault), `release`, `forget(id)`, `freeze`, `unfreeze`, `setWriter`, `withdraw`.

## Your own guarded vault

```ts
import { deployVault } from 'antibody-guard';

const vault = await deployVault({ chain: 'baseSepolia', publicClient, walletClient, agent: AGENT_ADDRESS, payeeDelaySeconds: 60, fund: '0.005' });
await vault.setGuardian();
await new GuardApi().watch('baseSepolia', vault.address);
await vault.requestPayee('alice', ALICE, '0.01');   // timelocked; then, after the delay:
await vault.activatePayee('alice');
await vault.setDailyLimit('0.05');
```

As the agent: `await vault.propose(to, '0.001', 'alice')` returns `{ paid, refusal }`: a refusal
(`UnknownPayee`, `OverCap`, `Quarantined`, `Frozen`, ...) is an answer, not an exception.
`vault.check(...)` is a free dry run.

## Notes

- Every write is simulated first, so a call the contract would refuse throws with its error name and
  costs no gas.
- `CHAINS`, `GUARD_REACTIVE`, `DEMO`, and the ABIs (`GuardVaultAbi`, `GuardMemoryAbi`, `GuardReactiveAbi`,
  `RiskOracleAbi`) are exported.
- Tests: `npm test` (unit, with a stand-in API) and `LIVE=1 npm test` (against the deployed contracts and
  API).

MIT
