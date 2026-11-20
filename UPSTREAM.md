# Upstream compatibility notes

PrismLLM targets the documented OpenAI-compatible API surface of FreeLLMAPI:
- `GET /v1/models`
- `POST /v1/chat/completions` with SSE streaming

The upstream router owns its provider adapters, quota ledger, health probes, encrypted provider-key database, catalog synchronization and advanced routing/bandit scoring. The iOS app deliberately delegates those functions to an external gateway when configured. The TypeScript direct router is a lightweight client-side failover layer; it does not reproduce the upstream provider registry or server-side quota enforcement.

Reference: https://github.com/tashfeenahmed/freellmapi
