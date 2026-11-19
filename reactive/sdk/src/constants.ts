import type { Address } from 'viem';

/** The chains Antibody Guard runs on (testnets), with each origin chain's Reactive callback proxy. */
export const CHAINS = {
  baseSepolia: { chainId: 84532, name: 'Base Sepolia', rpc: 'https://sepolia.base.org', explorer: 'https://sepolia.basescan.org', callbackProxy: '0x476F44b11F5C942c58f4c8E3d0300E5710743585' as Address },
  sepolia: { chainId: 11155111, name: 'Ethereum Sepolia', rpc: 'https://ethereum-sepolia-rpc.publicnode.com', explorer: 'https://sepolia.etherscan.io', callbackProxy: '0xAa14d9Cd0f788Ca23d11805986C1d8bd035D23b4' as Address },
  lasna: { chainId: 5318007, name: 'Reactive Lasna', rpc: 'https://lasna-rpc.rnk.dev/', explorer: 'https://lasna.reactscan.net' },
} as const;

export type OriginChain = 'baseSepolia' | 'sepolia';
export const ORIGIN_CHAINS: readonly OriginChain[] = ['baseSepolia', 'sepolia'];

/** GuardReactive v5 on Reactive Lasna: make it your vault's or memory's guardian. */
export const GUARD_REACTIVE: Address = '0x4d15b3af1a723d158f63f61002577e9a8b998440';

/** The public API (the Guard service, behind the site). */
export const DEFAULT_API = 'https://antibody-guard-reactive.netlify.app';

/** The demo deployment, for trying things out. */
export const DEMO = {
  vaults: { baseSepolia: '0x114e6c7e2cd7feeec8d75912cf762f1fc45dc7d2' as Address, sepolia: '0xb30ccddd31c4e14186801d74ea45a905b7305d4b' as Address },
  memory: { baseSepolia: '0xd4638e87d66e2543f305b5189318506c562e5ef6' as Address },
  riskOracle: { baseSepolia: '0xe067e2b0a06d6019442ec8371ee2ad407b2d322e' as Address },
} as const;

/** Why a vault refused a payment (the vault's RefusalCode). */
export const REFUSALS = ['None', 'Frozen', 'Quarantined', 'UnknownPayee', 'LabelMismatch', 'OverCap', 'OverDailyLimit', 'Duplicate', 'TransferFailed'] as const;
export type Refusal = (typeof REFUSALS)[number];

/** What GuardMemory says about an entry. */
export const MEMORY_STATUS = ['usable', 'quarantined-source', 'forgotten'] as const;
export type MemoryStatus = (typeof MEMORY_STATUS)[number];

/** Why GuardMemory refused a write. */
export const MEMORY_REFUSALS = ['None', 'Frozen', 'QuarantinedSource'] as const;
export type MemoryRefusal = (typeof MEMORY_REFUSALS)[number];

/** The chain's own coin, as a token address. */
export const NATIVE: Address = '0x0000000000000000000000000000000000000000';
