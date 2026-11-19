// The console's wallet connection: Reown AppKit with the wagmi adapter, on Base Sepolia, Ethereum
// Sepolia and Reactive Lasna. Bundled into /assets/js/wallet.js and loaded by the console on demand.
import { createAppKit } from '@reown/appkit';
import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import { defineChain } from '@reown/appkit/networks';
import { baseSepolia, sepolia } from 'viem/chains';
import { getAccount, getWalletClient, switchChain, watchAccount, disconnect } from '@wagmi/core';
import { createPublicClient, http, type Abi, type Hex } from 'viem';

/** Reown Cloud project (public: it identifies this site to WalletConnect, it is not a secret). */
export const PROJECT_ID = 'd1bf7b7232b7d0fb7f0469d0adb29f5b';

const lasna = defineChain({
  id: 5318007,
  caipNetworkId: 'eip155:5318007',
  chainNamespace: 'eip155',
  name: 'Reactive Lasna',
  nativeCurrency: { name: 'lREACT', symbol: 'lREACT', decimals: 18 },
  rpcUrls: { default: { http: ['https://lasna-rpc.rnk.dev/'] } },
  blockExplorers: { default: { name: 'Reactscan', url: 'https://lasna.reactscan.net' } },
  testnet: true,
});
const RPC: Record<number, string> = { [baseSepolia.id]: 'https://sepolia.base.org', [sepolia.id]: 'https://ethereum-sepolia-rpc.publicnode.com', [lasna.id]: 'https://lasna-rpc.rnk.dev/' };
const CHAINS: Record<number, any> = { [baseSepolia.id]: baseSepolia, [sepolia.id]: sepolia, [lasna.id]: lasna };
const networks = [baseSepolia, sepolia, lasna] as [any, ...any[]];

const adapter = new WagmiAdapter({ projectId: PROJECT_ID, networks });
const config = adapter.wagmiConfig;
const modal = createAppKit({
  adapters: [adapter],
  networks,
  defaultNetwork: baseSepolia,
  projectId: PROJECT_ID,
  metadata: { name: 'Antibody Guard', description: 'An immune system for agent wallets, on Reactive Network.', url: location.origin, icons: [`${location.origin}/assets/img/icon-192.png`] },
  features: { analytics: false, email: false, socials: false, swaps: false, onramp: false, history: false },
  themeMode: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
  themeVariables: { '--w3m-accent': '#2b7fff', '--w3m-font-family': 'DM Sans, system-ui, sans-serif', '--w3m-border-radius-master': '2px' },
});

// Close the modal once an account connects (AppKit otherwise leaves its "linked" page open).
let wasConnected = getAccount(config).isConnected;
watchAccount(config, {
  onChange: (a) => {
    if (a.isConnected && !wasConnected) for (const ms of [300, 1200, 2500]) setTimeout(() => void modal.close(), ms);
    wasConnected = a.isConnected;
  },
});

const publics = new Map<number, ReturnType<typeof createPublicClient>>();
export function publicClient(chainId: number) {
  if (!publics.has(chainId)) publics.set(chainId, createPublicClient({ chain: CHAINS[chainId], transport: http(RPC[chainId]) }));
  return publics.get(chainId)!;
}

/** Lasna refuses a zero priority tip, which wallets tend to estimate there; pass the fees explicitly. */
async function fees(chainId: number) {
  if (chainId !== lasna.id) return {};
  const b = await publicClient(chainId).getBlock();
  const base = b.baseFeePerGas ?? 100_000_000_000n;
  const tip = 1_000_000_000n;
  return { maxFeePerGas: base + base / 4n + tip, maxPriorityFeePerGas: tip };
}

async function walletOn(chainId: number) {
  const a = getAccount(config);
  if (!a.isConnected) {
    await modal.open();
    throw new Error('Connect a wallet first.');
  }
  if (a.chainId !== chainId) await switchChain(config, { chainId });
  return getWalletClient(config, { chainId });
}

export const wallet = {
  open: () => modal.open(),
  close: () => modal.close(),
  openNetworks: () => modal.open({ view: 'Networks' }),
  disconnect: () => disconnect(config),
  account: () => {
    const a = getAccount(config);
    return { address: a.address ?? null, chainId: a.chainId ?? null, connected: a.isConnected };
  },
  onChange: (cb: () => void) => watchAccount(config, { onChange: () => cb() }),
  publicClient,
  chainName: (id: number) => CHAINS[id]?.name ?? String(id),
  /** Send a contract call on `chainId` (switching the wallet's network if needed) and wait for it. */
  async write(chainId: number, address: Hex, abi: Abi, functionName: string, args: unknown[] = [], value?: bigint) {
    const w = await walletOn(chainId);
    const hash = await w.writeContract({ address, abi, functionName, args, ...(value ? { value } : {}), chain: CHAINS[chainId], account: w.account, ...(await fees(chainId)) } as any);
    const receipt = await publicClient(chainId).waitForTransactionReceipt({ hash });
    return { hash, receipt };
  },
  async deploy(chainId: number, abi: Abi, bytecode: Hex, args: unknown[], value?: bigint) {
    const w = await walletOn(chainId);
    const hash = await w.deployContract({ abi, bytecode, args, ...(value ? { value } : {}), chain: CHAINS[chainId], account: w.account, ...(await fees(chainId)) } as any);
    const receipt = await publicClient(chainId).waitForTransactionReceipt({ hash });
    return { hash, receipt, address: receipt.contractAddress as Hex };
  },
};
