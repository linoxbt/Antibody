/**
 * Memory envelope (spec §5). Wire layout:
 *
 *   AB1|<base64url(JCS(header))>|<base64url(64-byte Ed25519 sig)>
 *   <body: UTF-8, starts with "[lane:<lane> kind:<kind> id:<uuid>]">
 *
 * The tag line makes every record findable by lane and by envelope id through
 * semantic recall (the rebuild query plan, spec §10), since the base64 header
 * itself is opaque to search.
 *
 * Signed message = UTF-8 "antibody/env/v1\n" || SHA-256(JCS(header)).
 */
import { z } from 'zod';
import {
  canonicalJson,
  fromBase64Url,
  fromUtf8,
  isHex,
  sha256Bytes,
  sha256Hex,
  toBase64Url,
  utf8,
  UUID_RE,
} from './encoding.ts';
import type { LaneKey } from './keys.ts';
import { KINDS, LANES, type Envelope, type EnvelopeHeader, type Kind, type Lane, type SrcRef } from './types.ts';

export const ENVELOPE_PREFIX = 'AB1';
export const SIG_DOMAIN = 'antibody/env/v1\n';
export const MAX_HEADER_BYTES = 4096;
export const MAX_BODY_BYTES = 8192;
export const MAX_PARENTS = 64;

const srcRefSchema = z
  .object({
    t: z.string().min(1).max(32),
    id: z.string().max(256).optional(),
    ver: z.string().max(64).optional(),
    digest: z.string().max(128).optional(),
    addr: z.string().max(80).optional(),
    type: z.string().max(512).optional(),
  })
  .strict();

const headerSchema = z
  .object({
    v: z.literal(1),
    id: z.string().regex(UUID_RE),
    acct: z.string().min(3).max(80),
    ns: z.string().min(1).max(64),
    lane: z.enum(LANES),
    kind: z.enum(KINDS),
    pub: z.string().refine((s) => isHex(s, 32), 'pub must be 32-byte hex'),
    parents: z.array(z.string().regex(UUID_RE)).max(MAX_PARENTS),
    src: z.array(srcRefSchema).max(32),
    turn: z.string().max(64).nullable(),
    ckpt: z.number().int().nonnegative(),
    ts: z.string().max(40),
    bodyHash: z.string().refine((s) => isHex(s, 32), 'bodyHash must be SHA-256 hex'),
    bodyLen: z.number().int().nonnegative().max(MAX_BODY_BYTES),
  })
  .strict();

export function laneTag(lane: Lane, kind: Kind, id: string): string {
  return `[lane:${lane} kind:${kind} id:${id}]`;
}

/** Query that recalls every record of one lane and kind. */
export function laneQuery(lane: Lane, kind: Kind): string {
  return `[lane:${lane} kind:${kind}]`;
}

export function signingMessage(header: EnvelopeHeader): Uint8Array {
  const digest = sha256Bytes(canonicalJson(header));
  const domain = utf8(SIG_DOMAIN);
  const out = new Uint8Array(domain.length + digest.length);
  out.set(domain, 0);
  out.set(digest, domain.length);
  return out;
}

export interface BuildEnvelopeInput {
  id: string;
  acct: string;
  ns: string;
  lane: Lane;
  kind: Kind;
  parents?: string[];
  src?: SrcRef[];
  turn?: string | null;
  ckpt: number;
  ts: string;
  /** Body text without the lane tag; the tag line is prepended here. */
  text: string;
}

/** Build and sign an envelope. Parents are sorted and de-duplicated (spec §5). */
export function buildEnvelope(input: BuildEnvelopeInput, key: LaneKey): Envelope {
  const body = `${laneTag(input.lane, input.kind, input.id)}\n${input.text}`;
  const bodyBytes = utf8(body);
  if (bodyBytes.length > MAX_BODY_BYTES) throw new Error(`body exceeds ${MAX_BODY_BYTES} bytes`);
  const parents = [...new Set(input.parents ?? [])].sort();
  if (parents.length > MAX_PARENTS) throw new Error(`more than ${MAX_PARENTS} parents`);
  const header: EnvelopeHeader = {
    v: 1,
    id: input.id,
    acct: input.acct,
    ns: input.ns,
    lane: input.lane,
    kind: input.kind,
    pub: key.publicKeyHex,
    parents,
    src: input.src ?? [],
    turn: input.turn ?? null,
    ckpt: input.ckpt,
    ts: input.ts,
    bodyHash: sha256Hex(bodyBytes),
    bodyLen: bodyBytes.length,
  };
  headerSchema.parse(header);
  const headerJson = canonicalJson(header);
  if (utf8(headerJson).length > MAX_HEADER_BYTES) throw new Error('header exceeds 4 KiB');
  const sig = key.sign(signingMessage(header));
  const text = `${ENVELOPE_PREFIX}|${toBase64Url(utf8(headerJson))}|${toBase64Url(sig)}\n${body}`;
  return { header, body, text };
}

export interface ParsedEnvelope {
  header: EnvelopeHeader;
  body: string;
  sig: Uint8Array;
  text: string;
}

export class EnvelopeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Strict parse (verification step 1) plus body hash/length (step 2). It checks
 * structure only; signature and binding checks live in verify.ts.
 */
export function parseEnvelope(text: string): ParsedEnvelope {
  const nl = text.indexOf('\n');
  if (nl < 0) throw new EnvelopeError('MALFORMED', 'no header line');
  const first = text.slice(0, nl);
  const body = text.slice(nl + 1);
  const fields = first.split('|');
  if (fields.length !== 3) throw new EnvelopeError('MALFORMED', 'header line must have exactly three | fields');
  const [prefix, headerB64, sigB64] = fields as [string, string, string];
  if (prefix !== ENVELOPE_PREFIX) throw new EnvelopeError('MALFORMED', 'missing AB1 prefix');
  let headerBytes: Uint8Array;
  let sig: Uint8Array;
  try {
    headerBytes = fromBase64Url(headerB64);
    sig = fromBase64Url(sigB64);
  } catch (e) {
    throw new EnvelopeError('MALFORMED', `bad base64url: ${(e as Error).message}`);
  }
  if (headerBytes.length > MAX_HEADER_BYTES) throw new EnvelopeError('MALFORMED', 'header exceeds 4 KiB');
  if (sig.length !== 64) throw new EnvelopeError('MALFORMED', 'signature must be 64 bytes');
  let headerJson: string;
  let raw: unknown;
  try {
    headerJson = fromUtf8(headerBytes);
    raw = JSON.parse(headerJson);
  } catch {
    throw new EnvelopeError('MALFORMED', 'header is not UTF-8 JSON');
  }
  const parsed = headerSchema.safeParse(raw);
  if (!parsed.success) {
    throw new EnvelopeError('MALFORMED', `header schema: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  }
  const header = parsed.data as EnvelopeHeader;
  // One header value has exactly one encoding: reject non-canonical JSON.
  if (canonicalJson(header) !== headerJson) throw new EnvelopeError('MALFORMED', 'header is not JCS-canonical');
  const sortedParents = [...new Set(header.parents)].sort();
  if (sortedParents.join(',') !== header.parents.join(',')) {
    throw new EnvelopeError('MALFORMED', 'parents must be sorted and unique');
  }
  const bodyBytes = utf8(body);
  if (bodyBytes.length !== header.bodyLen) throw new EnvelopeError('BODY_MISMATCH', 'bodyLen does not match body');
  if (sha256Hex(bodyBytes) !== header.bodyHash) throw new EnvelopeError('BODY_MISMATCH', 'bodyHash does not match body');
  if (!body.startsWith(laneTag(header.lane, header.kind, header.id) + '\n')) {
    throw new EnvelopeError('MALFORMED', 'body does not start with its lane tag');
  }
  return { header, body, sig, text };
}

/** The body without its lane-tag line: the human-readable content. */
export function bodyContent(body: string): string {
  const nl = body.indexOf('\n');
  return nl < 0 ? '' : body.slice(nl + 1);
}

/** Does the text look like an Antibody envelope at all (for inventory triage)? */
export function looksLikeEnvelope(text: string): boolean {
  return text.startsWith(`${ENVELOPE_PREFIX}|`);
}
