# Reactive MCP

[Reactive MCP](https://dev.reactive.network/reactive-mcp) (`https://mcp.rnk.dev/mcp`, public, read-only,
no key) is configured for Claude Code in the repository's `.mcp.json`. From a shell, the same tools are
available through `npm run rmcp -- <tool> '<json args>'` in `reactive/` (`npm run rmcp -- tools` lists them).

```sh
cd reactive
npm run rmcp -- get_rc_health '{"rc":"0xb30ccddd31c4e14186801d74ea45a905b7305d4b"}'
npm run rmcp -- list_subscriptions '{"rc":"0xb30ccddd31c4e14186801d74ea45a905b7305d4b"}'
npm run rmcp -- trace_reactive_tx '{"txHash":"0x…"}'
```

## Diagnosis of the live contracts (19 November 2026)

| Check | Verdict | Notes |
| --- | --- | --- |
| `get_rc_health` GuardReactive | LOW_RESERVES, then **HEALTHY** | It pays fees from its own balance through the inherited `pay()`; 0.2 lREACT of reserves added with `depositTo` (`npm run deposit -- 0.2`) as a cushion. |
| `list_subscriptions` | **OK_SUBSCRIBED**, 6/6 active | the six vault events on Base Sepolia |
| `trace_reactive_tx` (loop A) | REACTED; CALLBACK_NOT_POSTED (cannot prove) | `react()` succeeded and requested the callback; about 146k of the 300k gas reaches the vault. Lasna posts no delivery records (no `CallbackPosted` in 30,000 blocks), which is why `npm run link-callbacks` links each callback through the vault event it produced. |
| `check_rc_source` GuardReactive | **OK_SOURCE** | |
| `check_rc_source` GuardVault | CALLBACK_UNGUARDED (likely), 8 items | A text-pattern false positive. `freeze` and `quarantine` use `onlyGuardian`, which makes both checks (`_onlyServiceProvider()` and the injected sender equals the guardian); the other six are owner- or agent-only functions, not callbacks. Covered by `test_callbackNotFromTheProxyIsRejected`, `test_callbackFromAnotherReactiveContractIsRejected` and `test_noGuardianMeansNoCallbacks`. |

## Supported chains (from the bundled docs)

Testnets: Base Sepolia, Ethereum Sepolia, Unichain Sepolia, Reactive Lasna. Arbitrum, Robinhood Chain,
Base, Ethereum, Avalanche, BSC, HyperEVM and Unichain are mainnet only. Mainnets and testnets cannot be
mixed, so the testnet build covers Base Sepolia plus Ethereum Sepolia or Unichain Sepolia; Arbitrum and
Robinhood need a mainnet deployment.

## SDKs

There is no official TypeScript SDK. The Solidity library is
[reactive-lib-omni](https://github.com/Reactive-Network/reactive-lib-omni), pinned by
`reactive/scripts/fetch-deps.sh`; the scripts use viem against the public RPCs.
