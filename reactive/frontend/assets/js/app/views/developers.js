// Developers: the public API, the TypeScript SDK and the MCP server, each with a command to copy.
import { el } from '../../ui.js';
import { head, card, command } from '../kit.js';

const SITE = location.origin;
const REPO = 'https://github.com/linoxbt/Antibody-gaurd';
const BLOB = `${REPO}/blob/main`;

export default {
  id: 'developers',
  path: '/app/developers',
  title: 'Developers',
  icon: 'keys',
  render() {
    const link = (href, text) => el('a', { href, target: '_blank', rel: 'noopener' }, text);
    return el(
      'div',
      { style: 'display:grid;gap:16px' },
      head('Build', 'with it.', 'Three ways to put Antibody Guard in front of your agent: ask the API, use the SDK, or give the agent the MCP tools. Reads need no key.'),
      card(
        'MCP: give your agent the tools',
        el('span', { class: 'pill plain rec' }, 'Claude · Cursor · any MCP client'),
        el('p', { class: 'muted', style: 'margin:0 0 12px' }, 'Hosted, nothing to install: check an address before paying it, recall a memory and see if it is usable, audit what a source planted, score a message with the AI.'),
        command(`claude mcp add --transport http antibody-guard ${SITE}/mcp`),
        el('p', { class: 'muted', style: 'margin:14px 0 8px' }, 'Or locally over stdio, with action tools when you give it testnet keys (propose a payment, remember, quarantine a source):'),
        command('git clone ' + REPO + ' && cd Antibody-gaurd/sdk && npm ci && npm run gen && cd ../mcp && npm ci && npm run build\nclaude mcp add antibody-guard -- node "$PWD/dist/index.js"'),
        el('p', { class: 'hint' }, 'Tools: guard_check_address, guard_recall_memory, guard_audit_source, guard_attacker_details, guard_list_attackers, guard_list_vaults, guard_list_memories, guard_recent_decisions, guard_status, guard_score_message.'),
      ),
      card(
        'API: one question before every payment',
        el('span', { class: 'pill plain rec' }, 'REST · OpenAPI 3.1'),
        command(`curl ${SITE}/api/v1/check/0x00000000000000000000000000000000bad3e301`),
        el('p', { class: 'muted', style: 'margin:14px 0 8px' }, 'And whether a memory may be acted on:'),
        command(`curl ${SITE}/api/v1/memories/baseSepolia/0xd4638e87d66e2543f305b5189318506c562e5ef6/entries/2`),
        el('p', { class: 'hint' }, 'Also /status, /attackers, /attackers/{address}, /vaults, /memories, /loops, /events, POST /score and POST /watch. ', link(`${SITE}/api/v1/openapi.json`, 'OpenAPI document'), '.'),
      ),
      card(
        'SDK: TypeScript, on viem',
        el('span', { class: 'pill plain rec' }, 'antibody-guard'),
        command(`import { GuardApi, GuardMemory, deployMemory, guardedAgent } from 'antibody-guard';

const guard = guardedAgent(new GuardApi());
await guard.beforePaying(invoice.payTo);          // throws GuardRefusal for a known attacker

const memory = await deployMemory({ chain: 'baseSepolia', publicClient, walletClient, writer: agent, fund: '0.003' });
await memory.setGuardian();                       // GuardReactive v5
await new GuardApi().watch('baseSepolia', memory.address);
const { id } = await memory.remember(emailText, senderAddress, 'email');
await guard.beforeActingOn(memory, id);           // throws if its source is quarantined`),
        el('p', { class: 'hint' }, 'GuardApi, GuardVault, GuardMemory, deployVault, deployMemory, guardedAgent and the contract ABIs. ', link(`${BLOB}/sdk/README.md`, 'SDK reference'), '.'),
      ),
    );
  },
};
