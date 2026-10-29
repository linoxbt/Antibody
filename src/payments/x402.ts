/**
 * x402 v2 over HTTP, `exact` scheme on Sui (coinbase/x402 specs:
 * x402-specification-v2, transports-v2/http, schemes/exact/scheme_exact_sui).
 *
 *   402 + PAYMENT-REQUIRED: base64(PaymentRequired)
 *   retry with PAYMENT-SIGNATURE: base64(PaymentPayload{payload:{signature, transaction}})
 *   200 + PAYMENT-RESPONSE: base64(SettlementResponse)
 *
 * In Antibody the 402's `payTo`, `amount` and `asset` become an ordinary
 * payment proposal: the policy engine decides exactly as for a bill payment,
 * so an x402 server cannot get paid unless its payTo is a registered payee
 * within cap. The signer signs but does not execute: the facilitator settles.
 */
import { z } from 'zod';
import { fromBase64, toBase64, utf8, fromUtf8 } from '../core/encoding.ts';

export const X402_VERSION = 2;
export const HDR_REQUIRED = 'PAYMENT-REQUIRED';
export const HDR_SIGNATURE = 'PAYMENT-SIGNATURE';
export const HDR_RESPONSE = 'PAYMENT-RESPONSE';

const resourceSchema = z.object({ url: z.string(), description: z.string().optional(), mimeType: z.string().optional() }).passthrough();

export const requirementsSchema = z
  .object({
    scheme: z.string(),
    network: z.string(),
    amount: z.string().regex(/^[0-9]+$/),
    asset: z.string(),
    payTo: z.string(),
    maxTimeoutSeconds: z.number(),
    extra: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type PaymentRequirements = z.infer<typeof requirementsSchema>;

export const paymentRequiredSchema = z
  .object({
    x402Version: z.literal(2),
    error: z.string().optional(),
    resource: resourceSchema,
    accepts: z.array(requirementsSchema).min(1),
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type PaymentRequired = z.infer<typeof paymentRequiredSchema>;

export const paymentPayloadSchema = z
  .object({
    x402Version: z.literal(2),
    resource: resourceSchema,
    accepted: requirementsSchema,
    payload: z.object({ signature: z.string(), transaction: z.string() }).strict(),
  })
  .passthrough();
export type PaymentPayload = z.infer<typeof paymentPayloadSchema>;

export interface SettlementResponse {
  success: boolean;
  transaction: string;
  network: string;
  payer: string;
  errorReason?: string;
}

export function encodeHeader(v: unknown): string {
  return toBase64(utf8(JSON.stringify(v)));
}

export function decodeHeader<T>(h: string, schema?: z.ZodType<T>): T {
  const raw = JSON.parse(fromUtf8(fromBase64(h.trim()))) as unknown;
  return schema ? schema.parse(raw) : (raw as T);
}

/** CAIP-2 network id for Sui. The offline fixture chain is labelled as such. */
export function suiNetworkId(network: string, simulated: boolean): string {
  return simulated ? 'sui:antibody-fixture' : `sui:${network}`;
}

/** Pick the requirement we can pay: exact scheme on our Sui network. */
export function selectRequirement(pr: PaymentRequired, networkId: string): PaymentRequirements | null {
  return pr.accepts.find((a) => a.scheme === 'exact' && a.network === networkId) ?? null;
}
