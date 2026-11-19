// guard: the Antibody Guard command line. Run your own guarded vault, act as its agent, and watch
// GuardReactive work, on Base Sepolia, Ethereum Sepolia and Reactive Lasna (testnets).
//
// Keys never come from the command line: GUARD_<ROLE>_KEY, or ~/.antibody-guard/<role>.key (0600).
// Roles: owner (configures your vault), agent (may only propose payments).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { decodeEventLog, formatEther, getAddress, isAddress, parseEther, stringToHex, hexToString, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { NETWORKS } from '../networks.ts';
import { abiOf, clients, KEY_DIR, loadRecord, testnetKey, txUrl, addrUrl, type NetworkName } from '../scripts/lib.ts';

const VERSION = '0.5.0';
const API = (process.env.GUARD_API ?? 'https://antibody-guard.netlify.app').replace(/\/$/, '');
const CONFIG = join(KEY_DIR, 'config.json');
const ETH = '0x0000000000000000000000000000000000000000';
const CODES = ['None', 'Frozen', 'Quarantined', 'UnknownPayee', 'LabelMismatch', 'OverCap', 'OverDailyLimit', 'Duplicate', 'TransferFailed'];
const CHAINS = { baseSepolia: 'Base Sepolia', sepolia: 'Ethereum Sepolia', lasna: 'Reactive Lasna' } as Record<string, string>;
const label32 = (s: string) => stringToHex(s.slice(0, 31), { size: 32 });
const vaultAbi = abiOf('GuardVault');
const rxAbi = abiOf('GuardReactive');

// ---- arguments ------------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flags: Record<string, string | boolean> = {};
const pos: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    if (v !== undefined) flags[k!] = v;
    else if (argv[i + 1] && !argv[i + 1]!.startsWith('--')) flags[k!] = argv[++i]!;
    else flags[k!] = true;
  } else pos.push(a);
}
const json = Boolean(flags.json);
/** An address in any letter case, normalized; null when it is not one. */
const A = (x?: string): Hex | null => (x && isAddress(x.toLowerCase()) ? (getAddress(x.toLowerCase()) as Hex) : null);
const chain = String(flags.chain ?? 'baseSepolia') as NetworkName;
if (!['baseSepolia', 'sepolia'].includes(chain)) fail('--chain must be baseSepolia or sepolia');

/** One readable line for a failed command, with the contract's own error when it refused. */
function errorLine(e: any): string {
  for (let x = e, i = 0; x && i < 8; x = x.cause, i++) {
    if (x.data?.errorName) return `refused by the contract: ${x.data.errorName}${x.data.args?.length ? ` (${x.data.args.map(String).join(', ')})` : ''}`;
  }
  return String(e?.shortMessage ?? e?.message ?? e).split('\n')[0];
}
for (const ev of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(ev, (e: any) => {
    if (process.env.GUARD_DEBUG) console.error(e);
    console.error(`guard: ${errorLine(e)}${process.env.GUARD_DEBUG ? '' : ' (GUARD_DEBUG=1 for details)'}`);
    process.exit(1);
  });
}

function fail(msg: string): never {
  console.error(`guard: ${msg}`);
  process.exit(1);
}
function out(text: string, data?: unknown) {
  if (json) console.log(JSON.stringify(data ?? { text }, null, 2));
  else console.log(text);
}
const config = (): any => (existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, 'utf8')) : {});
function saveConfig(c: any) {
  mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
}

// ---- which vault, which keys ---------------------------------------------------------------------
function demoVault(net: NetworkName): Hex | undefined {
  try { return loadRecord(net, `${net}-v2`).vault; } catch { return undefined; }
}
function vaultAddr(): Hex {
  const v = A((flags.vault as string) ?? config().vaults?.[chain] ?? demoVault(chain));
  if (!v) fail(`no vault on ${chain}: deploy one with "guard vault deploy", or pass --vault`);
  return v;
}
function guardAddr(): Hex {
  return (process.env.GUARD_REACTIVE ?? loadRecord('lasna', 'lasna-v5').guard) as Hex;
}
function keyFor(role: string): Hex {
  try { return testnetKey(role); } catch { fail(`no ${role} key: set GUARD_${role.toUpperCase()}_KEY, or run "guard keys new ${role}"`); }
}
const as = (role: string) => clients(chain, keyFor(role));
const reader = () => clients(chain, ('0x' + '11'.repeat(32)) as Hex);
const read = (fn: string, args: unknown[] = []) => reader().pub.readContract({ address: vaultAddr(), abi: vaultAbi, functionName: fn, args });

async function send(role: string, fn: string, args: unknown[], what: string, value = 0n) {
  const c = as(role);
  const hash = await c.wallet.writeContract({ address: vaultAddr(), abi: vaultAbi, functionName: fn, args, value, chain: c.chain, account: c.account });
  const r = await c.pub.waitForTransactionReceipt({ hash });
  const events = r.logs.flatMap((l) => { try { const e: any = decodeEventLog({ abi: vaultAbi, data: l.data, topics: l.topics }); return [e]; } catch { return []; } });
  const refused = events.find((e) => e.eventName === 'PaymentRefused');
  const paid = events.find((e) => e.eventName === 'PaymentExecuted');
  const result = r.status !== 'success' ? 'reverted' : refused ? `refused: ${CODES[refused.args.code]}` : paid ? 'paid' : 'done';
  out(`${what}: ${result}\n  ${txUrl(chain, hash)}`, { what, result, tx: hash, chain, events: events.map((e) => e.eventName) });
  return { r, events };
}

async function api(path: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) fail(j.error ?? `HTTP ${res.status}`);
  return j;
}

// ---- commands ------------------------------------------------------------------------------------
const HELP = `guard ${VERSION}: the Antibody Guard command line (testnets)

  guard status                         your vault, GuardReactive and the known attackers
  guard loops [--limit 15]             origin -> reaction -> callback, with times
  guard keys [new <owner|agent>]       show or create testnet keys (~/.antibody-guard)

  guard vault deploy [--agent <addr>] [--delay 120] [--fund 0.005]
                                       deploy your own GuardVault (you are its owner)
  guard vault use <address>            use an existing vault
  guard guardian                       make GuardReactive your vault's guardian
  guard watch                          ask the Guard service to have GuardReactive watch it

  guard payee add <label> <address> --cap <eth>   timelocked
  guard payee activate <label>         after the delay (anyone may)
  guard payee remove <label>           immediate
  guard payee show <label>
  guard limit <eth>                    daily limit for the chain's coin
  guard schedule add <label> <eth> <seconds>   recurring payment on Reactive's CRON
  guard schedule cancel <id>

  guard check <to> <eth> <label>       dry run against the rules
  guard propose <to> <eth> <label>     as the agent: the vault pays or refuses
  guard freeze [reason] | unfreeze | release <address> | withdraw <to> <eth>

  guard score "<message>" [--from ..] [--subject ..]   the AI risk scorer (Guard service)
  guard health                         GuardReactive's health (Reactive MCP)

Options: --chain baseSepolia|sepolia (default baseSepolia), --vault <address>, --json
Keys: GUARD_OWNER_KEY / GUARD_AGENT_KEY, or ~/.antibody-guard/{owner,agent}.key. Testnets only.`;

const [cmd, sub, ...rest] = pos;
switch (cmd) {
  case undefined: case 'help': case '--help':
    console.log(HELP);
    break;
  case 'version':
    console.log(VERSION);
    break;

  case 'keys': {
    if (sub === 'new') {
      const role = rest[0] ?? fail('which role: owner or agent?');
      if (!['owner', 'agent'].includes(role)) fail('roles: owner, agent');
      const k = testnetKey(role, true);
      out(`${role}: ${privateKeyToAccount(k).address} (key in ${join(KEY_DIR, role + '.key')})`);
    } else {
      const lines: string[] = [];
      for (const role of ['owner', 'agent']) {
        let a = 'none';
        try { a = privateKeyToAccount(testnetKey(role)).address; } catch { /* none */ }
        lines.push(`${role.padEnd(6)} ${a}`);
      }
      out(lines.join('\n'));
    }
    break;
  }

  case 'vault': {
    if (sub === 'use') {
      const a = A(rest[0]) ?? fail('guard vault use <address>');
      const c = config();
      c.vaults = { ...(c.vaults ?? {}), [chain]: getAddress(a) };
      saveConfig(c);
      out(`using vault ${getAddress(a)} on ${CHAINS[chain]}`);
    } else if (sub === 'deploy') {
      const owner = as('owner');
      let agent = flags.agent as string | undefined;
      if (!agent) { try { agent = privateKeyToAccount(testnetKey('agent')).address; } catch { agent = owner.account.address; } }
      agent = A(agent) ?? fail('--agent must be an address');
      const code = JSON.parse(readFileSync(new URL('../abi/GuardVault.code.json', import.meta.url), 'utf8'));
      const hash = await owner.wallet.deployContract({ abi: vaultAbi, bytecode: code.bytecode, args: [NETWORKS[chain].callbackProxy, agent, BigInt(String(flags.delay ?? 120))], value: parseEther(String(flags.fund ?? '0.005')), chain: owner.chain, account: owner.account });
      const r = await owner.pub.waitForTransactionReceipt({ hash });
      const c = config();
      c.vaults = { ...(c.vaults ?? {}), [chain]: r.contractAddress };
      saveConfig(c);
      out(`GuardVault on ${CHAINS[chain]}: ${r.contractAddress}\n  owner ${owner.account.address}, agent ${agent}\n  ${txUrl(chain, hash)}\nNext: guard payee add ..., guard limit ..., then guard guardian && guard watch`, { vault: r.contractAddress, tx: hash });
    } else fail('guard vault deploy | guard vault use <address>');
    break;
  }

  case 'guardian':
    await send('owner', 'setGuardian', [guardAddr()], `guardian = GuardReactive ${guardAddr()}`);
    break;
  case 'watch': {
    const j = await api('/api/watch', { chain, vault: vaultAddr() });
    out(`GuardReactive now watches ${j.vault} on ${CHAINS[chain]}\n  ${NETWORKS.lasna.explorer}/tx/${j.tx}\n  it was immunized with every known attacker`, j);
    break;
  }

  case 'payee': {
    if (sub === 'add') {
      const lbl = rest[0];
      const to = A(rest[1]);
      if (!lbl || !to || !flags.cap) fail('guard payee add <label> <address> --cap <eth>');
      await send('owner', 'requestPayee', [label32(lbl), to, parseEther(String(flags.cap))], `request payee ${lbl} -> ${to}`);
      const p = (await read('payees', [label32(lbl)])) as any[];
      out(`  active from ${new Date(Number(p[4]) * 1000).toISOString()}: then run "guard payee activate ${lbl}"`);
    } else if (sub === 'activate') {
      const lbl = rest[0] ?? fail('guard payee activate <label>');
      await send('owner', 'activatePayee', [label32(lbl)], `activate payee ${lbl}`);
    } else if (sub === 'remove') {
      const lbl = rest[0] ?? fail('guard payee remove <label>');
      await send('owner', 'removePayee', [label32(lbl)], `remove payee ${lbl}`);
    } else if (sub === 'show') {
      const lbl = rest[0] ?? fail('guard payee show <label>');
      const p = (await read('payees', [label32(lbl)])) as any[];
      out(p[0] === ETH && p[2] === ETH ? `${lbl}: not a payee` : `${lbl}: ${p[0] === ETH ? '(none active)' : p[0]} cap ${formatEther(p[1])}${p[4] ? `\n  pending: ${p[2]} cap ${formatEther(p[3])} from ${new Date(Number(p[4]) * 1000).toISOString()}` : ''}`, { label: lbl, to: p[0], cap: formatEther(p[1]), pendingTo: p[2], pendingCap: formatEther(p[3]), effectiveAt: Number(p[4]) });
    } else fail('guard payee add | activate | remove | show');
    break;
  }

  case 'limit': {
    const eth = sub ?? fail('guard limit <eth>');
    await send('owner', 'setDailyLimit', [ETH, parseEther(eth)], `daily limit ${eth}`);
    break;
  }
  case 'schedule': {
    if (sub === 'add') {
      const [lbl, eth, secs] = rest;
      if (!lbl || !eth || !secs) fail('guard schedule add <label> <eth> <seconds>');
      const { events } = await send('owner', 'setSchedule', [label32(lbl), ETH, parseEther(eth), BigInt(secs), 0n], `schedule ${eth} to ${lbl} every ${secs}s`);
      const set: any = events.find((e: any) => e.eventName === 'ScheduleSet');
      if (set && !json) console.log(`  schedule id ${set.args.id} (stop it with "guard schedule cancel ${set.args.id}")`);
    } else if (sub === 'cancel') {
      await send('owner', 'cancelSchedule', [BigInt(rest[0] ?? fail('guard schedule cancel <id>'))], `cancel schedule ${rest[0]}`);
    } else fail('guard schedule add | cancel');
    break;
  }

  case 'check': {
    const [to, eth, lbl] = [A(sub), ...rest];
    if (!to || !eth || !lbl) fail('guard check <to> <eth> <label>');
    const code = Number(await read('check', [to, ETH, parseEther(eth), label32(lbl)]));
    out(code === 0 ? 'would be paid' : `would be refused: ${CODES[code]}`, { result: CODES[code] });
    break;
  }
  case 'propose': {
    const [to, eth, lbl] = [A(sub), ...rest];
    if (!to || !eth || !lbl) fail('guard propose <to> <eth> <label>');
    await send('agent', 'proposePayment', [to, ETH, parseEther(eth), label32(lbl)], `propose ${eth} to ${to} as "${lbl}"`);
    break;
  }
  case 'freeze':
    await send('owner', 'freezeNow', [label32(sub ?? 'owner')], 'freeze');
    break;
  case 'unfreeze':
    await send('owner', 'unfreeze', [], 'unfreeze');
    break;
  case 'release': {
    const who = A(sub) ?? fail('guard release <address>');
    await send('owner', 'release', [who], `release ${who}`);
    break;
  }
  case 'withdraw': {
    const [to, eth] = [A(sub), ...rest];
    if (!to || !eth) fail('guard withdraw <to> <eth>');
    await send('owner', 'withdraw', [to, ETH, parseEther(eth)], `withdraw ${eth} to ${to}`);
    break;
  }

  case 'status': {
    const v = vaultAddr();
    const pub = reader().pub;
    const [frozen, guardian, owner, agent, bal, n, limit] = await Promise.all([read('frozen'), read('guardian'), read('owner'), read('agent'), pub.getBalance({ address: v }), read('proposalCount'), read('dailyLimit', [ETH])]);
    const lasna = clients('lasna', ('0x' + '11'.repeat(32)) as Hex).pub;
    const g = guardAddr();
    const [watched, lessons] = await Promise.all([lasna.readContract({ address: g, abi: rxAbi, functionName: 'watched', args: [BigInt(NETWORKS[chain].chainId), v] }) as Promise<any>, lasna.readContract({ address: g, abi: rxAbi, functionName: 'lessonCount' })]);
    const guarded = String(guardian).toLowerCase() === g.toLowerCase();
    out(
      [
        `Vault         ${v} (${CHAINS[chain]})`,
        `  state       ${frozen ? 'FROZEN' : 'active'} · ${formatEther(bal)} ETH · ${n} proposals · daily limit ${formatEther(limit as bigint)}`,
        `  owner       ${owner}`,
        `  agent       ${agent}`,
        `GuardReactive ${g} (Lasna)`,
        `  guardian    ${guarded ? 'yes' : `no (guardian is ${guardian}): run "guard guardian"`}`,
        `  watching    ${watched[0] ? 'yes' : 'no: run "guard watch"'}`,
        `  lessons     ${lessons} known attackers, quarantined on every watched vault`,
        `  explorer    ${addrUrl(chain, v)}`,
      ].join('\n'),
      { vault: v, chain, frozen, balance: formatEther(bal), owner, agent, guardian, guarded, watched: watched[0], lessons: Number(lessons) },
    );
    break;
  }

  case 'loops': {
    const s = await api('/api/state');
    const all = [...(s.live ?? []), ...(s.recorded ?? [])].slice(0, Number(flags.limit ?? 15));
    const fmt = (n: number | null) => (n === null || n === undefined ? '…' : n === 0 ? '<1s' : `${n}s`);
    out(all.map((l: any) => `${String(l.rule).padEnd(21)} ${String(CHAINS[l.destChain] ?? '').padEnd(17)} ${l.subject ? l.subject.slice(0, 10) + '…' : 'vault'.padEnd(11)}  ${fmt(l.seconds).padStart(4)}  ${l.callback?.tx ? 'done' : 'pending'}`).join('\n') || 'no loops yet', all);
    break;
  }

  case 'score': {
    const body = sub ?? fail('guard score "<message>"');
    const j = await api('/api/score', { body, from: flags.from ?? 'unknown sender', subject: flags.subject ?? '' });
    const v = j.verdict;
    out(`${v.score}/100 · ${v.suspicious ? 'suspicious' : 'looks fine'} · ${v.reason}${j.reported?.length ? `\nreported ${j.reported[0].address}: ${txUrl('baseSepolia', j.reported[0].tx)}\nGuardReactive will quarantine it on every watched vault (see "guard loops")` : ''}`, j);
    break;
  }

  case 'health': {
    const res = await fetch('https://mcp.rnk.dev/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_rc_health', arguments: { rc: guardAddr() } } }) });
    const t = await res.text();
    const j = JSON.parse(t.startsWith('{') ? t : t.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join(''));
    out(j.result?.content?.[0]?.text?.split('\n').slice(0, 3).join('\n') ?? 'no answer', j.result);
    break;
  }

  default:
    fail(`unknown command "${cmd}" (guard help)`);
}
