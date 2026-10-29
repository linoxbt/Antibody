// Sui wallets through the Wallet Standard: no SDK, no CDN. Wallet extensions
// register themselves on the window; we only ever ask them to connect and sign.

const wallets = [];
const listeners = new Set();
let started = false;

const isSui = (w) => w?.chains?.some((c) => String(c).startsWith('sui:')) && w.features?.['standard:connect'];

function register(...ws) {
  for (const w of ws) if (isSui(w) && !wallets.includes(w)) wallets.push(w);
  listeners.forEach((f) => f(wallets));
  return () => {};
}

/** Start discovery once; onChange(wallets) runs now and whenever a wallet registers. */
export function discoverWallets(onChange = () => {}) {
  if (!started) {
    started = true;
    addEventListener('wallet-standard:register-wallet', (e) => {
      try {
        e.detail({ register });
      } catch {
        /* a misbehaving wallet must not break the page */
      }
    });
    dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: { register } }));
  }
  listeners.add(onChange);
  onChange(wallets);
  return wallets;
}

export const canSign = (w, feature) => !!w.features?.[feature];

export async function connect(w) {
  const { accounts } = await w.features['standard:connect'].connect();
  const account = accounts.find((a) => a.chains?.some((c) => String(c).startsWith('sui:'))) ?? accounts[0];
  if (!account) throw new Error('the wallet shared no account');
  return account;
}

export async function signMessage(w, account, text) {
  const f = w.features['sui:signPersonalMessage'];
  if (!f) throw new Error(`${w.name} cannot sign messages`);
  const { signature } = await f.signPersonalMessage({ message: new TextEncoder().encode(text), account });
  return signature;
}

/** Sign (not execute) prepared transaction bytes; the node submits them. Returns { bytes, signature } in base64. */
export async function signTransaction(w, account, txBytesB64, chain) {
  const tx = { toJSON: async () => txBytesB64, serialize: () => txBytesB64 };
  if (w.features['sui:signTransaction']) return w.features['sui:signTransaction'].signTransaction({ transaction: tx, account, chain });
  if (w.features['sui:signTransactionBlock']) {
    const r = await w.features['sui:signTransactionBlock'].signTransactionBlock({ transactionBlock: tx, account, chain });
    return { bytes: r.transactionBlockBytes, signature: r.signature };
  }
  throw new Error(`${w.name} cannot sign transactions`);
}

export const cancelled = (e) => /reject|denied|cancel/i.test(e?.message ?? '');
