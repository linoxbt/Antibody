/**
 * Testnets used by Antibody Guard, with each chain's Reactive callback proxy
 * (from dev.reactive.network/origins-and-destinations). Testnet origins may only
 * call back to testnet destinations.
 */
export const REACTIVE_SYSTEM = '0x8888888888888888888888888888888888888888';

export const NETWORKS = {
  lasna: { chainId: 5318007, rpc: 'https://lasna-rpc.rnk.dev/', explorer: 'https://lasna.reactscan.net', callbackProxy: REACTIVE_SYSTEM, currency: 'lREACT' },
  baseSepolia: { chainId: 84532, rpc: 'https://sepolia.base.org', explorer: 'https://sepolia.basescan.org', callbackProxy: '0x476F44b11F5C942c58f4c8E3d0300E5710743585', currency: 'ETH' },
  sepolia: { chainId: 11155111, rpc: 'https://ethereum-sepolia-rpc.publicnode.com', explorer: 'https://sepolia.etherscan.io', callbackProxy: '0xAa14d9Cd0f788Ca23d11805986C1d8bd035D23b4', currency: 'ETH' },
  unichainSepolia: { chainId: 1301, rpc: 'https://sepolia.unichain.org', explorer: 'https://sepolia.uniscan.xyz', callbackProxy: '0x775c9B990ADe401060B78D0e98684eEf8d2466C1', currency: 'ETH' },
} as const;

/** Send Sepolia or Base Sepolia ETH here (request(address)) to receive lREACT on Lasna: 1 ETH = 100 lREACT, at most 5 ETH per transaction. */
export const LREACT_FAUCET = {
  sepolia: '0x9b9BB25f1A81078C544C829c5EB7822d747Cf434',
  baseSepolia: '0x2afaFD298b23b62760711756088F75B7409f5967',
} as const;
