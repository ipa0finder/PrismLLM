export type Strategy = "fastest" | "reliable" | "auto-failover";
export type ChatRole = "system" | "user" | "assistant";
export interface ChatMessage { role: ChatRole; content: string }
export interface ModelCandidate {
  id: string; baseURL: string; apiKey?: string; provider?: string;
  latencyMs?: number; reliability?: number; cooldownUntil?: number;
}
export interface ChatRequest {
  messages: ChatMessage[]; model?: string; strategy?: Strategy;
  temperature?: number; max_tokens?: number; stream?: boolean;
}
export interface RouterConfig {
  gatewayURL?: string; gatewayKey?: string; directProviders?: ModelCandidate[];
  strategy?: Strategy; timeoutMs?: number; maxAttempts?: number;
}
export interface ChatResult { content: string; model: string; provider?: string; attempts: number }
