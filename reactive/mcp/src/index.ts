// antibody-guard-mcp: the Antibody Guard MCP server over stdio.
//
//   claude mcp add antibody-guard -- npx -y antibody-guard-mcp
//
// Read tools need nothing. Action tools appear when their keys are set (testnets only):
//   GUARD_AGENT_KEY + GUARD_VAULT      guard_propose_payment (the agent proposes from that vault)
//   GUARD_AGENT_KEY + GUARD_MEMORY     guard_remember (the agent writes to that memory)
//   GUARD_OWNER_KEY + GUARD_MEMORY     guard_quarantine_source (the memory's owner)
//   GUARD_CHAIN (baseSepolia | sepolia, default baseSepolia), GUARD_API (default: the public deployment)
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createPublicClient, createWalletClient, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia, sepolia } from 'viem/chains';
import { CHAINS, GuardApi, GuardMemory, GuardVault, type OriginChain } from '../../sdk/src/index.ts';
import { registerGuardTools, type Actions } from './tools.ts';

const env = process.env;
const chainName = (env.GUARD_CHAIN ?? 'baseSepolia') as OriginChain;
if (chainName !== 'baseSepolia' && chainName !== 'sepolia') throw new Error('GUARD_CHAIN must be baseSepolia or sepolia');
const viemChain = chainName === 'baseSepolia' ? baseSepolia : sepolia;
const publicClient = createPublicClient({ chain: viemChain, transport: http(CHAINS[chainName].rpc) });
const wallet = (key?: string) => (key ? createWalletClient({ account: privateKeyToAccount(key as Hex), chain: viemChain, transport: http(CHAINS[chainName].rpc) }) : undefined);
const agent = wallet(env.GUARD_AGENT_KEY);
const owner = wallet(env.GUARD_OWNER_KEY);

const actions: Actions = {};
if (agent && env.GUARD_VAULT) {
  const v = new GuardVault(env.GUARD_VAULT as Address, { publicClient: publicClient as any, walletClient: agent as any });
  actions.propose = async (to, amountEth, payeeLabel) => {
    const r = await v.propose(to as Address, amountEth, payeeLabel);
    return { ...r, explorer: `${CHAINS[chainName].explorer}/tx/${r.hash}` };
  };
}
if (agent && env.GUARD_MEMORY) {
  const m = new GuardMemory(env.GUARD_MEMORY as Address, { publicClient: publicClient as any, walletClient: agent as any });
  actions.remember = async (content, source, kind) => {
    const r = await m.remember(content, source as Address, kind);
    return { ...r, explorer: `${CHAINS[chainName].explorer}/tx/${r.hash}` };
  };
}
if (owner && env.GUARD_MEMORY) {
  const m = new GuardMemory(env.GUARD_MEMORY as Address, { publicClient: publicClient as any, walletClient: owner as any });
  actions.quarantineSource = async (source, reason) => ({ tx: await m.quarantineSource(source as Address, reason) });
}

const server = new McpServer({ name: 'antibody-guard', version: '0.1.2' }, { instructions: 'Antibody Guard is an immune system for AI agents: their money (GuardVault) and their memory (GuardMemory), guarded by GuardReactive on Reactive Network. Before paying an address or acting on what it sent, call guard_check_address. Before acting on a memory, call guard_recall_memory: an entry from a quarantined source is not usable.' });
registerGuardTools(server, new GuardApi({ baseUrl: env.GUARD_API, client: env.GUARD_CLIENT_NAME ?? 'MCP (npm)', via: 'mcp-local' }), actions);
await server.connect(new StdioServerTransport());
