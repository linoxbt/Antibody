/**
 * A small x402 resource server with a built-in facilitator, used to bill
 * Steward over HTTP 402 (e.g. a utility company). It follows the Sui `exact`
 * scheme verification steps: network, signature over the transaction,
 * dry-run succeeds and has not been executed, and the payTo balance change
 * equals the required amount of the asset. Settlement executes the signed
 * transaction on Sui (or the fixture chain offline).
 */
import { createServer, type Server } from 'node:http';
import { verifyTransactionSignature } from '@mysten/sui/verify';
import { fromBase64, normalizeCoinType, normalizeSuiAddress } from '../core/encoding.ts';
import type { ChainReader } from '../adapters/chain.ts';
import { decodeHeader, encodeHeader, HDR_REQUIRED, HDR_RESPONSE, HDR_SIGNATURE, paymentPayloadSchema, type PaymentRequired, type SettlementResponse } from './x402.ts';

export interface BillServerOptions {
  chain: ChainReader;
  network: string;
  payTo: string;
  asset: string;
  /** Base units per bill. */
  amount: string;
  serviceName: string;
  port: number;
  host?: string;
}

export interface FacilitatorCheck {
  ok: boolean;
  reason?: string;
  payer?: string;
}

/** Facilitator verification for the Sui exact scheme. */
export async function verifySuiExact(chain: ChainReader, network: string, req: { payTo: string; asset: string; amount: string }, header: string): Promise<FacilitatorCheck & { txBytes?: Uint8Array; signature?: string }> {
  let p;
  try {
    p = decodeHeader(header, paymentPayloadSchema);
  } catch (e) {
    return { ok: false, reason: `invalid payment payload: ${(e as Error).message}` };
  }
  if (p.accepted.scheme !== 'exact' || p.accepted.network !== network) return { ok: false, reason: `unsupported scheme/network ${p.accepted.scheme}/${p.accepted.network}` };
  const txBytes = fromBase64(p.payload.transaction);
  let payer: string;
  try {
    const pk = await verifyTransactionSignature(txBytes, p.payload.signature);
    payer = normalizeSuiAddress(pk.toSuiAddress());
  } catch (e) {
    return { ok: false, reason: `signature does not verify: ${(e as Error).message}` };
  }
  const sim = await chain.simulate(txBytes);
  if (!sim.ok) return { ok: false, reason: `dry-run failed: ${sim.error}` };
  if (sim.sender !== payer) return { ok: false, reason: 'signer is not the transaction sender' };
  const payTo = normalizeSuiAddress(req.payTo);
  const asset = normalizeCoinType(req.asset);
  const got = sim.balanceChanges.filter((c) => normalizeSuiAddress(c.address) === payTo && normalizeCoinType(c.coinType) === asset).reduce((a, c) => a + BigInt(c.amount), 0n);
  if (got !== BigInt(req.amount)) return { ok: false, reason: `payTo receives ${got}, required ${req.amount}` };
  return { ok: true, payer, txBytes, signature: p.payload.signature };
}

export function startBillServer(o: BillServerOptions): Promise<Server> {
  const asset = normalizeCoinType(o.asset);
  const payTo = normalizeSuiAddress(o.payTo);
  const server = createServer(async (req, res) => {
    const url = `http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`;
    const required: PaymentRequired = {
      x402Version: 2,
      error: `${HDR_SIGNATURE} header is required`,
      resource: { url, description: `${o.serviceName} bill ${req.url}`, mimeType: 'application/json' },
      accepts: [{ scheme: 'exact', network: o.network, amount: o.amount, asset, payTo, maxTimeoutSeconds: 60, extra: {} }],
    };
    const sig = req.headers[HDR_SIGNATURE.toLowerCase()];
    if (typeof sig !== 'string') {
      res.writeHead(402, { 'content-type': 'application/json', [HDR_REQUIRED]: encodeHeader(required) });
      res.end('{}');
      return;
    }
    const check = await verifySuiExact(o.chain, o.network, { payTo, asset, amount: o.amount }, sig);
    if (!check.ok) {
      res.writeHead(402, { 'content-type': 'application/json', [HDR_REQUIRED]: encodeHeader({ ...required, error: check.reason }) });
      res.end(JSON.stringify({ error: check.reason }));
      return;
    }
    let settle: SettlementResponse;
    try {
      const tx = await o.chain.execute(check.txBytes!, check.signature!);
      settle = { success: tx.ok, transaction: tx.digest, network: o.network, payer: check.payer!, ...(tx.ok ? {} : { errorReason: tx.error ?? 'execution failed' }) };
    } catch (e) {
      settle = { success: false, transaction: '', network: o.network, payer: check.payer!, errorReason: (e as Error).message };
    }
    res.writeHead(settle.success ? 200 : 402, { 'content-type': 'application/json', [HDR_RESPONSE]: encodeHeader(settle) });
    res.end(JSON.stringify(settle.success ? { paid: true, service: o.serviceName, bill: req.url, receipt: settle.transaction } : { error: settle.errorReason }));
  });
  return new Promise((resolve) => server.listen(o.port, o.host ?? '127.0.0.1', () => resolve(server)));
}
