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
  /** B9: the upload job's current state (Tatum certifies uploads asynchronously). */
  status?(jobId: string): Promise<Record<string, unknown>>;
}

const AGGREGATOR = 'https://aggregator.walrus-mainnet.walrus.space/v1/blobs';

export class TatumStorage implements ReportStore {
  constructor(
    private readonly apiUrl: string,
    private readonly apiKey: string,
  ) {}

  /**
   * Upload, then follow the job until Walrus certifies it (B9). Tatum stores the
   * file as a patch of a Walrus quilt, so the readable link is the job's
   * downloadUrlByQuiltPatchId; the bare blob id serves the whole quilt (binary).
   */
  async upload(filename: string, json: unknown, o: { waitMs?: number; pollMs?: number } = {}): Promise<UploadResult> {
    const body = new FormData();
    body.append('file', new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' }), filename);
    const res = await fetch(`${this.apiUrl}/v4/data/storage/upload`, { method: 'POST', headers: { 'x-api-key': this.apiKey }, body, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`Tatum Storage upload failed: HTTP ${res.status} ${await res.text()}`);
    const r = (await res.json()) as Record<string, unknown>;
    const jobId = String(r.jobId ?? '');
    if (!jobId) throw new Error('Tatum Storage upload returned no job id');
    let job = r;
    const deadline = Date.now() + (o.waitMs ?? 120_000);
    while (!['CERTIFIED', 'FAILED'].includes(String(job.status)) && Date.now() < deadline) {
      await new Promise((ok) => setTimeout(ok, o.pollMs ?? 3000));
      job = await this.status(jobId).catch(() => job);
    }
    if (job.status === 'FAILED') throw new Error(`Tatum Storage job ${jobId} failed`);
    return toResult(job, filename);
  }

  async status(jobId: string): Promise<Record<string, unknown>> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(jobId)) throw new Error('bad job id');
    const res = await fetch(`${this.apiUrl}/v4/data/storage/upload/${jobId}`, { headers: { 'x-api-key': this.apiKey }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Tatum Storage status failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as Record<string, unknown>;
  }

}

/** The readable link for a job: the quilt patch URL Tatum gives once certified; else empty (check `antibody report status <job>`). */
export function toResult(job: Record<string, unknown>, filename: string): UploadResult {
  const blobId = typeof job.blobId === 'string' ? job.blobId : '';
  const patch = typeof job.downloadUrlByQuiltPatchId === 'string' && /^https:\/\//.test(job.downloadUrlByQuiltPatchId) ? job.downloadUrlByQuiltPatchId : '';
  const patchId = typeof job.quiltPatchId === 'string' ? job.quiltPatchId : '';
  const url = patch || (patchId ? `${AGGREGATOR}/by-quilt-patch-id/${patchId}` : '');
  return { jobId: String(job.jobId ?? ''), blobId, status: String(job.status ?? 'PENDING'), filename: String(job.filename ?? filename), sizeBytes: Number(job.sizeBytes ?? 0), url, simulated: false };
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
    // B15: never a file:// path (it would reach the browser through /api/state).
    return { jobId: `local-${blobId.slice(0, 8)}`, blobId, status: 'SIMULATED', filename, sizeBytes: text.length, url: `local:reports/${filename}`, simulated: true };
  }
}
