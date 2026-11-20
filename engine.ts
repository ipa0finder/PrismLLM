import type { ChatRequest, ChatResult, ModelCandidate, RouterConfig, Strategy } from "./types.js";

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Small client-side failover router. It does not emulate FreeLLMAPI's server ledger/bandit. */
export class PrismRouter {
  private candidates: ModelCandidate[] = [];
  private readonly cooldowns = new Map<string, number>();
  private readonly stats = new Map<string, { ok: number; fail: number; latency: number }>();

  constructor(private readonly config: RouterConfig) {
    this.candidates = [...(config.directProviders ?? [])];
  }

  setProviders(providers: ModelCandidate[]) { this.candidates = [...providers]; }

  private rank(strategy: Strategy): ModelCandidate[] {
    const now = Date.now();
    return this.candidates
      .filter(p => (p.cooldownUntil ?? this.cooldowns.get(p.id) ?? 0) <= now)
      .sort((a, b) => {
        const sa = this.score(a, strategy), sb = this.score(b, strategy);
        return sb - sa;
      });
  }

  private score(p: ModelCandidate, strategy: Strategy): number {
    const s = this.stats.get(p.id);
    const reliability = p.reliability ?? (s ? (s.ok + 1) / (s.ok + s.fail + 2) : 0.8);
    const latency = s?.latency ?? p.latencyMs ?? 1800;
    if (strategy === "fastest") return 1 / Math.max(1, latency);
    if (strategy === "reliable") return reliability;
    return reliability * 0.7 + (1 / Math.max(1, latency)) * 500 * 0.3;
  }

  async models(signal?: AbortSignal): Promise<unknown[]> {
    const base = this.config.gatewayURL;
    if (!base) return this.candidates.map(p => ({ id: p.id, object: "model", owned_by: p.provider ?? "direct" }));
    const response = await fetch(`${base.replace(/\/+$/, "")}/models`, {
      headers: this.gatewayHeaders(), signal
    });
    if (!response.ok) throw new Error(`Model catalog failed (${response.status})`);
    const data = await response.json() as { data?: unknown[] };
    return data.data ?? [];
  }

  async complete(request: ChatRequest, signal?: AbortSignal): Promise<ChatResult> {
    const started = Date.now();
    const strategy = request.strategy ?? this.config.strategy ?? "auto-failover";
    if (this.config.gatewayURL) {
      const response = await this.fetchWithTimeout(
        `${this.config.gatewayURL.replace(/\/+$/, "")}/chat/completions`,
        this.gatewayHeaders(), { ...request, stream: false }, signal
      );
      if (!response.ok) throw new Error(await this.errorText(response));
      const json = await response.json();
      return { content: json.choices?.[0]?.message?.content ?? "", model: json.model ?? request.model ?? "auto", attempts: 1 };
    }

    const providers = this.rank(strategy);
    if (!providers.length) throw new Error("No healthy direct providers are configured.");
    const max = clamp(this.config.maxAttempts ?? providers.length, 1, providers.length);
    let lastError: unknown;
    for (const [index, provider] of providers.slice(0, max).entries()) {
      const t0 = Date.now();
      try {
        const response = await this.fetchWithTimeout(
          `${provider.baseURL.replace(/\/+$/, "")}/chat/completions`,
          { "Content-Type": "application/json", ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}) },
          { ...request, model: request.model ?? provider.id, stream: false }, signal
        );
        if (!response.ok) {
          const error = new Error(await this.errorText(response));
          if (RETRYABLE.has(response.status)) {
            this.cooldowns.set(provider.id, Date.now() + (response.status === 429 ? 60_000 : 8_000));
            throw error;
          }
          throw Object.assign(error, { terminal: true });
        }
        const json = await response.json();
        const elapsed = Date.now() - t0;
        this.stats.set(provider.id, { ok: (this.stats.get(provider.id)?.ok ?? 0) + 1, fail: this.stats.get(provider.id)?.fail ?? 0, latency: elapsed });
        return { content: json.choices?.[0]?.message?.content ?? "", model: json.model ?? provider.id, provider: provider.provider, attempts: index + 1 };
      } catch (error) {
        lastError = error;
        const stat = this.stats.get(provider.id) ?? { ok: 0, fail: 0, latency: 1800 };
        this.stats.set(provider.id, { ...stat, fail: stat.fail + 1 });
        if ((error as { terminal?: boolean })?.terminal || signal?.aborted) throw error;
      }
    }
    throw new Error(`All ${max} provider attempts failed after ${Date.now() - started}ms: ${String(lastError)}`);
  }

  /** Streams OpenAI SSE deltas. Caller owns the AbortController. */
  async stream(request: ChatRequest, onToken: (token: string) => void, signal?: AbortSignal): Promise<void> {
    const url = this.config.gatewayURL
      ? `${this.config.gatewayURL.replace(/\/+$/, "")}/chat/completions`
      : this.rank(request.strategy ?? this.config.strategy ?? "auto-failover")[0]
        ? `${this.rank(request.strategy ?? this.config.strategy ?? "auto-failover")[0].baseURL.replace(/\/+$/, "")}/chat/completions`
        : "";
    const provider = this.config.gatewayURL ? undefined : this.rank(request.strategy ?? this.config.strategy ?? "auto-failover")[0];
    if (!url) throw new Error("No provider is available.");
    const headers = this.config.gatewayURL ? this.gatewayHeaders() : {
      "Content-Type": "application/json", ...(provider?.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {})
    };
    const response = await this.fetchWithTimeout(url, headers, { ...request, model: request.model ?? provider?.id ?? "auto", stream: true }, signal);
    if (!response.ok || !response.body) throw new Error(await this.errorText(response));
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        try {
          const event = JSON.parse(data);
          const token = event.choices?.[0]?.delta?.content;
          if (typeof token === "string") onToken(token);
        } catch { /* Ignore malformed/heartbeat SSE frames. */ }
      }
    }
  }

  private gatewayHeaders(): HeadersInit {
    return { "Content-Type": "application/json", ...(this.config.gatewayKey ? { Authorization: `Bearer ${this.config.gatewayKey}` } : {}) };
  }
  private async fetchWithTimeout(url: string, headers: HeadersInit, body: unknown, signal?: AbortSignal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 90_000);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try { return await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal }); }
    finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }
  private async errorText(response: Response) {
    const body = await response.text().catch(() => "");
    return `HTTP ${response.status}: ${body.slice(0, 500)}`;
  }
}
