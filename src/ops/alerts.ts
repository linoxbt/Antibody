/**
 * Incident alerts to a webhook and/or Telegram, so a quarantine or a failed
 * ledger check reaches a human who is not watching the console. Alerts are
 * best effort: a failed delivery is logged and never blocks control.
 *
 *   ANTIBODY_ALERT_WEBHOOK      POST JSON {source, kind, severity, title, text, at, data}
 *   ANTIBODY_TELEGRAM_BOT_TOKEN + ANTIBODY_TELEGRAM_CHAT_ID   Telegram sendMessage
 */
import type { Logger } from '../log.ts';

export type AlertKind = 'incident' | 'auto-quarantine' | 'quarantine' | 'ledger-unverified' | 'payment-blocked' | 'test';

export interface Alert {
  kind: AlertKind;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  text: string;
  /** Alerts with the same key are sent at most once per window. */
  key: string;
  data?: Record<string, unknown>;
}

export interface AlertConfig {
  webhook: string | null;
  telegram: { token: string; chatId: string } | null;
}

export function alertConfigFrom(env: NodeJS.ProcessEnv = process.env): AlertConfig {
  const token = env.ANTIBODY_TELEGRAM_BOT_TOKEN;
  const chatId = env.ANTIBODY_TELEGRAM_CHAT_ID;
  return { webhook: env.ANTIBODY_ALERT_WEBHOOK || null, telegram: token && chatId ? { token, chatId } : null };
}

export class Alerter {
  private readonly sent = new Map<string, number>();

  constructor(
    private readonly cfg: AlertConfig,
    private readonly o: { log?: Logger; fetchImpl?: typeof fetch; now?: () => number; windowMs?: number; simulated?: boolean } = {},
  ) {}

  get enabled(): boolean {
    return !!(this.cfg.webhook || this.cfg.telegram);
  }

  /** Deliver to every configured channel. Resolves to the channels that accepted it. */
  async send(a: Alert): Promise<string[]> {
    if (!this.enabled) return [];
    const now = (this.o.now ?? Date.now)();
    const last = this.sent.get(a.key);
    if (last !== undefined && now - last < (this.o.windowMs ?? 10 * 60_000)) return [];
    this.sent.set(a.key, now);
    const f = this.o.fetchImpl ?? fetch;
    const tag = this.o.simulated ? '[SIMULATED] ' : '';
    const jobs: [string, Promise<Response>][] = [];
    if (this.cfg.webhook) {
      jobs.push(['webhook', f(this.cfg.webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'antibody', kind: a.kind, severity: a.severity, title: tag + a.title, text: a.text, at: new Date(now).toISOString(), simulated: !!this.o.simulated, data: a.data ?? {} }), signal: AbortSignal.timeout(8000) })]);
    }
    if (this.cfg.telegram) {
      const icon = a.severity === 'critical' ? '🛑' : a.severity === 'warning' ? '⚠️' : 'ℹ️';
      jobs.push(['telegram', f(`https://api.telegram.org/bot${this.cfg.telegram.token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: this.cfg.telegram.chatId, text: `${icon} ${tag}Antibody: ${a.title}\n${a.text}`, disable_web_page_preview: true }), signal: AbortSignal.timeout(8000) })]);
    }
    const ok: string[] = [];
    for (const [name, p] of jobs) {
      try {
        const r = await p;
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        ok.push(name);
      } catch (e) {
        // Never log the Telegram URL: it carries the bot token.
        this.o.log?.warn('alert.failed', { channel: name, kind: a.kind, error: (e as Error).message });
      }
    }
    if (ok.length) this.o.log?.info('alert.sent', { kind: a.kind, channels: ok });
    return ok;
  }
}
