/**
 * Control's local files. The text cache and incidents are disposable (never a
 * source of truth: rebuild --fresh ignores them). The high-water mark is the
 * rollback guard and survives a cache wipe (spec §7).
 */
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { JsonFileStore } from '../adapters/filestore.ts';
import type { StoredMemory } from '../core/types.ts';

export class TextCache {
  private readonly store: JsonFileStore<Record<string, StoredMemory>>;

  constructor(dir: string) {
    this.store = new JsonFileStore(join(dir, 'index.json'), () => ({}));
  }

  all(): Map<string, StoredMemory> {
    return new Map(Object.entries(this.store.read()));
  }

  put(memories: StoredMemory[]): void {
    if (memories.length === 0) return;
    this.store.update((s) => {
      for (const m of memories) s[m.blobId] = { blobId: m.blobId, namespace: m.namespace, text: m.text };
    });
  }
}

export interface Hwm {
  seq: number;
  hash: string;
}

export class HighWaterMark {
  constructor(private readonly path: string) {}

  read(): Hwm | null {
    return existsSync(this.path) ? (JSON.parse(readFileSync(this.path, 'utf8')) as Hwm) : null;
  }

  /** Only ever moves forward. */
  advance(head: Hwm): void {
    const cur = this.read();
    if (cur && cur.seq >= head.seq) return;
    mkdirSync(join(this.path, '..'), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(head), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  clear(): void {
    rmSync(this.path, { force: true });
  }
}

export interface Incident {
  id: string;
  at: string;
  objectId: string;
  observationId: string | null;
  coinType?: string;
  sender?: string;
  score: number;
  rules: string[];
  lessonMatches: { lessonSeq: number; indicator: string; value: string }[];
  blocklisted: boolean;
  proposedSeed: { type: 'source'; value: string };
  status: 'open' | 'quarantined' | 'auto-quarantined' | 'dismissed';
  quarantineSeq?: number;
  report?: { url: string; blobId: string; simulated: boolean };
}

export class IncidentStore {
  private readonly store: JsonFileStore<Incident[]>;

  constructor(dir: string) {
    this.store = new JsonFileStore(join(dir, 'incidents.json'), () => []);
  }

  list(): Incident[] {
    return this.store.read();
  }

  upsert(i: Incident): void {
    this.store.update((s) => {
      const k = s.findIndex((x) => x.id === i.id);
      if (k >= 0) s[k] = i;
      else s.push(i);
    });
  }

  get(id: string): Incident | undefined {
    return this.list().find((i) => i.id === id);
  }
}

/** Published incident reports, one entry per upload (FR-14). */
export interface ReportEntry {
  seq: number;
  url: string;
  blobId: string;
  jobId: string;
  status: string;
  filename: string;
  sizeBytes: number;
  simulated: boolean;
  at: number;
}

export class ReportLog {
  private readonly store: JsonFileStore<ReportEntry[]>;

  constructor(dir: string) {
    this.store = new JsonFileStore(join(dir, 'reports.json'), () => []);
  }

  list(): ReportEntry[] {
    return this.store.read();
  }

  add(e: ReportEntry): void {
    this.store.update((s) => {
      s.push(e);
    });
  }
}
