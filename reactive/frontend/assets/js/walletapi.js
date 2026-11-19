// The console's access to the wallet bundle (Reown AppKit, /assets/js/wallet/wallet.js), loaded on first
// use, plus the contract ABIs (/assets/abi). Nothing here holds a key: the visitor's wallet signs.
let w = null;
let loading = null;
const listeners = new Set();

export async function loadWallet() {
  if (w) return w;
  loading ??= import('/assets/js/wallet/wallet.js').then((m) => {
    w = m.wallet;
    w.onChange(() => listeners.forEach((f) => f()));
    return w;
  });
  return loading;
}
export const walletIfLoaded = () => w;
export const onWalletChange = (f) => (listeners.add(f), () => listeners.delete(f));
/** True when a wallet was connected on an earlier visit (AppKit/wagmi keep it in localStorage). */
export const hadWallet = () => Object.keys(localStorage).some((k) => k.startsWith('wagmi') || k.startsWith('@appkit'));

const abis = new Map();
export async function abi(name) {
  if (!abis.has(name)) abis.set(name, fetch(`/assets/abi/${name}.json`).then((r) => r.json()));
  return abis.get(name);
}

export const CHAIN_ID = { baseSepolia: 84532, sepolia: 11155111, lasna: 5318007 };
export const PROXY = { baseSepolia: '0x476F44b11F5C942c58f4c8E3d0300E5710743585', sepolia: '0xAa14d9Cd0f788Ca23d11805986C1d8bd035D23b4' };
export const SYSTEM = '0x8888888888888888888888888888888888888888';
export const ETH = '0x0000000000000000000000000000000000000000';

const enc = new TextEncoder();
/** A label as bytes32 (UTF-8, right-padded), as the vault stores it. */
export function label32(s) {
  const b = enc.encode(String(s).slice(0, 31));
  return '0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('').padEnd(64, '0');
}
/** Decimal ETH to wei, without floating point. */
export function wei(eth) {
  const [i, f = ''] = String(eth).trim().split('.');
  if (!/^\d*$/.test(i) || !/^\d*$/.test(f) || (!i && !f)) throw new Error(`"${eth}" is not an amount`);
  return BigInt(i || '0') * 10n ** 18n + BigInt((f + '0'.repeat(18)).slice(0, 18));
}
export const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a).trim());

/** Vaults this browser deployed (kept locally until GuardReactive watches them). */
export const myDeployed = () => JSON.parse(localStorage.getItem('guard.myVaults') ?? '[]');
export function rememberVault(v) {
  const list = myDeployed().filter((x) => !(x.chain === v.chain && x.address.toLowerCase() === v.address.toLowerCase()));
  localStorage.setItem('guard.myVaults', JSON.stringify([v, ...list].slice(0, 10)));
}
