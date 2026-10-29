/**
 * Owner actions signed by the owner's own browser wallet, from the command
 * line: `antibody setup --wallet`, `revoke --wallet`, `rotate --wallet`.
 *
 * The CLI opens a one-off page on 127.0.0.1 (random port, random path), the
 * page hands each prepared request to the wallet (Wallet Standard), and the
 * signature comes back to the CLI, which checks it and submits. The owner key
 * never touches this machine's disk or environment; the CLI only ever sees
 * signatures. Nothing posted to the page is trusted: a transaction must be the
 * exact call the CLI prepared (callOf) and the chain checks the signer; a
 * message signature is verified against the owner address.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join } from 'node:path';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { verifyPersonalMessageSignature } from '@mysten/sui/verify';
import type { AccountAdmin, ChainReader } from '../adapters/chain.ts';
import type { FixtureChain } from '../adapters/chain-fixture.ts';
import { SdkChainReader } from '../adapters/chain-sdk.ts';
import { zkLoginClient } from '../adapters/zklogin.ts';
import { isZkLogin } from './auth.ts';
import { callOf } from './revoke.ts';
import { CSP, readBody, staticFile, TYPES, WEB } from './server.ts';

const SUI_CLOCK = '0x6';

export type OwnerRequest =
  | { kind: 'transaction'; title: string; lines: string[]; owner: string | null; txBytes: string; chain: string }
  | { kind: 'message'; title: string; lines: string[]; owner: string | null; message: string };

export interface Signed {
  signature: string;
  bytes?: string;
  /** The address the wallet signed with. */
  address: string;
}

export interface OwnerSession {
  url: string;
  sign(req: OwnerRequest): Promise<Signed>;
  /** Tell the page the whole action is done (or failed), then stop serving. */
  finish(result: { ok: boolean; text: string }): Promise<void>;
}

/** Start the local signing page. `onUrl` prints/opens it. */
export async function ownerSession(o: { onUrl: (url: string) => void; timeoutMs?: number }): Promise<OwnerSession> {
  const token = randomBytes(18).toString('base64url');
  const base = `/owner/${token}`;
  let current: { id: string; req: OwnerRequest; resolve: (s: Signed) => void; reject: (e: Error) => void } | null = null;
  let finished: { ok: boolean; text: string } | null = null;
  let error: string | null = null;
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': CSP });
      res.end(JSON.stringify(body));
    };
    try {
      if (url.pathname === base) {
        res.writeHead(200, { 'content-type': TYPES['.html']!, 'cache-control': 'no-store', 'content-security-policy': CSP, 'referrer-policy': 'no-referrer' });
        return res.end(readFileSync(join(WEB, 'owner.html')));
      }
      if (url.pathname === `${base}/request` && req.method === 'GET') {
        if (finished) return send(200, { done: finished });
        if (!current) return send(200, { waiting: true, error });
        return send(200, { id: current.id, ...current.req, error });
      }
      if (url.pathname === `${base}/result` && req.method === 'POST') {
        if (req.headers['x-antibody-ui'] !== '1') return send(403, { error: 'missing header' });
        const b = (await readBody(req, 1 << 18)) as { id?: string; signature?: string; bytes?: string; address?: string; cancelled?: boolean };
        if (!current || b.id !== current.id) return send(409, { error: 'no such request' });
        const c = current;
        current = null;
        if (b.cancelled) c.reject(new Error('cancelled in the wallet'));
        else if (typeof b.signature !== 'string' || typeof b.address !== 'string') c.reject(new Error('the page sent no signature'));
        else c.resolve({ signature: b.signature, address: b.address, ...(typeof b.bytes === 'string' ? { bytes: b.bytes } : {}) });
        return send(200, { ok: true });
      }
      if (url.pathname.startsWith('/assets/') && req.method === 'GET') {
        const p = staticFile(url.pathname);
        if (p) {
          res.writeHead(200, { 'content-type': TYPES[extname(p)] ?? 'application/octet-stream', 'content-security-policy': CSP });
          return res.end(readFileSync(p));
        }
      }
      send(404, { error: 'not found' });
    } catch (e) {
      send(500, { error: (e as Error).message });
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}${base}`;
  o.onUrl(url);
  const timeoutMs = o.timeoutMs ?? 10 * 60_000;
  return {
    url,
    sign(req) {
      error = null;
      return new Promise<Signed>((resolve, reject) => {
        const t = setTimeout(() => {
          current = null;
          reject(new Error(`no wallet signature within ${timeoutMs / 60_000} minutes; nothing was signed`));
        }, timeoutMs);
        current = { id: randomBytes(8).toString('hex'), req, resolve: (s) => (clearTimeout(t), resolve(s)), reject: (e) => (clearTimeout(t), reject(e)) };
      });
    },
    async finish(result) {
      finished = result;
      // Let the page's next poll (1 s) see the outcome.
      await new Promise((r) => setTimeout(r, 1600));
      server.closeAllConnections();
      server.close();
    },
  };
}

const zk = zkLoginClient();

/** The wallet signed this message as `owner`, or throw. */
export async function verifyOwnerMessage(message: string, s: Signed, owner: string): Promise<void> {
  try {
    await verifyPersonalMessageSignature(new TextEncoder().encode(message), s.signature, { address: normalizeSuiAddress(owner), ...(isZkLogin(s.signature) ? { client: zk() } : {}) });
  } catch {
    throw new Error(`the signature is not from the account owner ${owner}`);
  }
}

/** Unsigned PTB adding several delegate keys in one owner transaction (one wallet prompt for setup). */
export async function buildAddDelegateKeys(reader: SdkChainReader, req: { sender: string; accountId: string; packageId: string; registryId: string; keys: { pub: string; label: string }[] }): Promise<Uint8Array> {
  const tx = new Transaction();
  tx.setSender(req.sender);
  for (const k of req.keys) {
    tx.moveCall({
      target: `${req.packageId}::account::add_delegate_key`,
      arguments: [tx.object(req.accountId), tx.object(req.registryId), tx.pure.vector('u8', Array.from(Buffer.from(k.pub, 'hex'))), tx.pure.string(k.label), tx.object(SUI_CLOCK)],
    });
  }
  return tx.build({ client: reader.client });
}

/** Submit a wallet-signed transaction after checking it is the call that was prepared. */
async function submitPrepared(chain: ChainReader, prepared: Uint8Array, s: Signed, what: string): Promise<string> {
  const bytes = s.bytes ? Buffer.from(s.bytes, 'base64') : Buffer.from(prepared);
  if (!bytes.equals(Buffer.from(prepared)) && callOf(bytes) !== callOf(prepared)) throw new Error('the wallet changed the transaction; refusing to submit it');
  const tx = await chain.execute(bytes, s.signature);
  if (!tx.ok) throw new Error(`${what} failed on-chain: ${tx.error ?? 'unknown error'}`);
  return tx.digest;
}

/**
 * AccountAdmin whose every owner act is signed in the browser wallet. Live:
 * real add/remove_delegate_key transactions. Offline (SIMULATED): the wallet
 * signs a one-time authorization message and the fixture applies it.
 */
export function walletAccountAdmin(o: { session: OwnerSession; owner: string; accountId: string; chain: ChainReader; packageId: string; registryId: string; network: string; fixture?: FixtureChain; reader?: SdkChainReader }): AccountAdmin & { addDelegateKeys(keys: { pub: string; label: string }[]): Promise<{ digest: string }> } {
  const owner = normalizeSuiAddress(o.owner);
  const authorize = async (title: string, lines: string[]) => {
    const message = [`Antibody · ${title} (offline backend, SIMULATED)`, `Account: ${o.accountId}`, ...lines, `Nonce: ${randomBytes(12).toString('hex')}`].join('\n');
    const s = await o.session.sign({ kind: 'message', title, lines, owner, message });
    await verifyOwnerMessage(message, s, owner);
  };
  const viaTx = async (title: string, lines: string[], bytes: Uint8Array) => {
    const s = await o.session.sign({ kind: 'transaction', title, lines, owner, txBytes: Buffer.from(bytes).toString('base64'), chain: `sui:${o.network}` });
    return submitPrepared(o.chain, bytes, s, title);
  };
  const reader = () => {
    if (!o.reader) throw new Error('this chain reader cannot build owner transactions');
    return o.reader;
  };
  const admin = {
    ownerAddress: () => owner,
    async addDelegateKeys(keys: { pub: string; label: string }[]) {
      const lines = keys.map((k) => `Add ${k.label}: ${k.pub}`);
      if (o.fixture) {
        await authorize('register lane keys', lines);
        let digest = '';
        for (const k of keys) digest = (await o.fixture.admin(owner).addDelegateKey(k.pub, k.label)).digest;
        return { digest };
      }
      return { digest: await viaTx('register lane keys', lines, await buildAddDelegateKeys(reader(), { sender: owner, accountId: o.accountId, packageId: o.packageId, registryId: o.registryId, keys })) };
    },
    async addDelegateKey(pub: string, label: string) {
      return admin.addDelegateKeys([{ pub, label }]);
    },
    async removeDelegateKey(pub: string) {
      if (o.fixture) {
        await authorize('remove a lane key', [`Key: ${pub}`]);
        return o.fixture.admin(owner).removeDelegateKey(pub);
      }
      const bytes = await reader().buildRemoveDelegateKey({ sender: owner, accountId: o.accountId, packageId: o.packageId, registryId: o.registryId, publicKeyHex: pub });
      return { digest: await viaTx('remove a lane key', [`Key: ${pub}`], bytes) };
    },
  };
  return admin;
}
