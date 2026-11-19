# antibody-guard-mcp

An MCP server for [Antibody Guard](https://github.com/linoxbt/Antibody-gaurd). It gives Claude, Cursor
or any MCP client the questions an AI agent should ask before it pays someone or acts on what it
remembers.

## Hosted (nothing to install)

```sh
claude mcp add --transport http antibody-guard https://antibody-guard-reactive.netlify.app/mcp
```

Streamable HTTP, stateless, read-only plus the AI scorer. Rate-limited per client.

## Local (stdio), with action tools

[![npm](https://img.shields.io/npm/v/antibody-guard-mcp?color=2ee6c8)](https://www.npmjs.com/package/antibody-guard-mcp)

```sh
claude mcp add antibody-guard -- npx -y antibody-guard-mcp
```

The action tools appear only when you configure their keys (testnet keys only):

| Variable | Enables |
|---|---|
| `GUARD_AGENT_KEY` + `GUARD_VAULT` | `guard_propose_payment` (the agent proposes from that vault) |
| `GUARD_AGENT_KEY` + `GUARD_MEMORY` | `guard_remember` (the agent writes to that memory) |
| `GUARD_OWNER_KEY` + `GUARD_MEMORY` | `guard_quarantine_source` (the memory's owner) |
| `GUARD_CHAIN` | `baseSepolia` (default) or `sepolia` |
| `GUARD_API` | the API to read from (default: the public deployment) |

```sh
claude mcp add antibody-guard -e GUARD_AGENT_KEY=0x… -e GUARD_VAULT=0x… -e GUARD_MEMORY=0x… -- npx -y antibody-guard-mcp
```

## Tools

| Tool | |
|---|---|
| `guard_check_address` | Is this address a known attacker? Ask before paying it or acting on what it sent |
| `guard_recall_memory` | A memory entry, its source, and whether the agent may act on it |
| `guard_audit_source` | Everything a source wrote into a memory, and whether it is quarantined there |
| `guard_attacker_details` | Where an attacker is blocked (every vault and memory, read now) and every decision |
| `guard_list_attackers` | Every lesson in GuardReactive, and how it was caught |
| `guard_list_vaults`, `guard_list_memories` | What GuardReactive guards |
| `guard_recent_decisions` | Origin → reaction → callback, with timings |
| `guard_status` | GuardReactive's reserves and counts |
| `guard_score_message` | The AI risk scorer (80+ is reported on-chain and quarantined everywhere) |
| `guard_propose_payment`, `guard_remember`, `guard_quarantine_source` | Actions, with keys (above) |

Tests: `npm test` drives the server with a real MCP client.

MIT
