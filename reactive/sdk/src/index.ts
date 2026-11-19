/**
 * Antibody Guard SDK: an immune system for AI agents' money and memory.
 *
 * - `GuardApi`: what GuardReactive knows (is this address an attacker? is this memory usable?), the AI
 *   risk scorer, and registering your own vault or memory to be watched.
 * - `GuardVault`: the agent proposes payments, the vault pays or refuses by on-chain rules.
 * - `GuardMemory`: the agent's memory with provenance; entries from a quarantined source are unusable.
 * - `deployVault` / `deployMemory`: your own, guarded by the shared GuardReactive on Reactive Network.
 * - `guardedAgent`: the two checks an agent should make, in one place.
 */
export * from './constants.ts';
export * from './api.ts';
export * from './contracts.ts';
export { GuardVaultAbi, GuardMemoryAbi, GuardReactiveAbi, RiskOracleAbi } from './generated.ts';

import type { Address } from 'viem';
import { GuardApi } from './api.ts';
import type { GuardMemory } from './contracts.ts';

/** Thrown by `guardedAgent` when an action would trust a known attacker or a poisoned memory. */
export class GuardRefusal extends Error {
  constructor(message: string, public readonly address?: Address) {
    super(message);
    this.name = 'GuardRefusal';
  }
}

/**
 * The two checks an agent should make before acting:
 * - `beforePaying(to)`: refuse if the recipient is a known attacker (the vault would refuse too, but this
 *   stops the agent before it tries, and says why);
 * - `beforeActingOn(memory, id)`: refuse if a memory came from a quarantined source or was forgotten.
 */
export function guardedAgent(api: GuardApi = new GuardApi()) {
  return {
    async beforePaying(to: Address) {
      const c = await api.check(to);
      if (c.knownAttacker) throw new GuardRefusal(`refusing to pay ${to}: ${c.advice}`, to);
      return c;
    },
    async beforeActingOn(memory: GuardMemory, id: number | bigint) {
      const e = await memory.recall(id);
      if (!e.usable) throw new GuardRefusal(`refusing to act on memory #${id}: ${e.status} (source ${e.source})`, e.source);
      return e;
    },
  };
}
