/**
 * Incident reports published to Walrus through the Tatum Storage API (FR-14).
 *   POST {api}/v4/data/storage/upload   multipart field `file`, header x-api-key
 *   GET  {api}/v4/data/storage/upload/{jobId}
 * Mainnet API keys only; 50 MiB max; billed as Walrus storage fees.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex } from '../core/encoding.ts';

export interface UploadResult {
  jobId: string;
  blobId: string;
  status: 'PENDING' | 'UPLOADING' | 'CERTIFIED' | 'FAILED' | string;
  filename: string;
  sizeBytes: number;
  /** Public read URL for the blob (Walrus aggregator). */
  url: string;
  simulated: boolean;
}

export interface ReportStore {
  upload(filename: string, json: unknown): Promise<UploadResult>;
}

const AGGREGATOR = 'https://aggregator.walrus-mainnet.walrus.space/v1/blobs';

export class TatumStorage implements ReportStore {
  constructor(
    private readonly apiUrl: string,
    private readonly apiKey: string,
  ) {}

  async upload(filename: string, json: unknown): Promise<UploadResult> {
    const body = new FormData();
    body.append('file', new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' }), filename);
    const res = await fetch(`${this.apiUrl}/v4/data/storage/upload`, { method: 'POST', headers: { 'x-api-key': this.apiKey }, body });
    if (!res.ok) throw new Error(`Tatum Storage upload failed: HTTP ${res.status} ${await res.text()}`);
    const r = (await res.json()) as Omit<UploadResult, 'url' | 'simulated'>;
    return { ...r, url: `${AGGREGATOR}/${r.blobId}`, simulated: false };
  }

  async status(jobId: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.apiUrl}/v4/data/storage/upload/${encodeURIComponent(jobId)}`, { headers: { 'x-api-key': this.apiKey } });
    if (!res.ok) throw new Error(`Tatum Storage status failed: HTTP ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }
}

/** Offline stand-in: writes the report locally and labels it SIMULATED. */
export class LocalReportStore implements ReportStore {
  constructor(private readonly dir: string) {}

  async upload(filename: string, json: unknown): Promise<UploadResult> {
    mkdirSync(this.dir, { recursive: true });
    const text = JSON.stringify(json, null, 2);
    const p = join(this.dir, filename);
    writeFileSync(p, text);
    const blobId = Buffer.from(sha256Hex(text), 'hex').toString('base64url');
    return { jobId: `local-${blobId.slice(0, 8)}`, blobId, status: 'SIMULATED', filename, sizeBytes: text.length, url: `file://${p}`, simulated: true };
  }
}
