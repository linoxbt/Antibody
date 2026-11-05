/**
 * gRPC calls that a provider rate-limits (Tatum answers HTTP 429 when a plan's
 * requests per second are exceeded) wait and try again instead of failing a
 * whole setup or payment. Every unary Sui gRPC call is safe to repeat: reads
 * are reads, and re-sending the same signed transaction returns the same
 * digest. Streams pass through untouched.
 */
import { UnaryCall, type MethodInfo, type RpcOptions, type RpcTransport } from '@protobuf-ts/runtime-rpc';

export function isRateLimited(e: unknown): boolean {
  const s = `${(e as { code?: unknown })?.code ?? ''} ${(e as Error)?.message ?? e}`;
  return /\b429\b|RESOURCE_EXHAUSTED|rate.?limit|too many requests/i.test(s);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class RateLimitRetry implements RpcTransport {
  constructor(
    private readonly inner: RpcTransport,
    private readonly tries = 6,
    private readonly baseMs = 400,
    private readonly wait: (ms: number) => Promise<void> = sleep,
  ) {}

  mergeOptions(options?: Partial<RpcOptions>): RpcOptions {
    return this.inner.mergeOptions(options);
  }

  unary<I extends object, O extends object>(method: MethodInfo<I, O>, input: I, options: RpcOptions): UnaryCall<I, O> {
    const run = async () => {
      for (let attempt = 0; ; attempt++) {
        const call = this.inner.unary(method, input, options);
        try {
          const [headers, response, status, trailers] = await Promise.all([call.headers, call.response, call.status, call.trailers]);
          return { headers, response, status, trailers };
        } catch (e) {
          if (attempt + 1 >= this.tries || !isRateLimited(e) || options.abort?.aborted) throw e;
          // 0.4 s, 0.8 s, 1.6 s … with jitter, so parallel callers spread out.
          await this.wait(this.baseMs * 2 ** attempt * (0.75 + Math.random() / 2));
        }
      }
    };
    const p = run();
    // Each part is its own promise; a caller that reads only `response` must not leave the others unhandled.
    const part = <T>(f: (r: Awaited<typeof p>) => T) => {
      const q = p.then(f);
      q.catch(() => undefined);
      return q;
    };
    return new UnaryCall(method, options.meta ?? {}, input, part((r) => r.headers), part((r) => r.response), part((r) => r.status), part((r) => r.trailers));
  }

  serverStreaming: RpcTransport['serverStreaming'] = (method, input, options) => this.inner.serverStreaming(method, input, options);
  clientStreaming: RpcTransport['clientStreaming'] = (method, options) => this.inner.clientStreaming(method, options);
  duplex: RpcTransport['duplex'] = (method, options) => this.inner.duplex(method, options);
}
