# PrismLLM

Native iOS shell and mobile-first chat client for a FreeLLMAPI-compatible gateway.

## Architecture

- `ios/PrismLLM/`: SwiftUI + WKWebView shell, native URLSession networking, Keychain storage, and JavaScript bridge.
- `www/`: bundled mobile UI (no CDN/runtime dependency).
- `src/router/`: TypeScript client router with strategy ranking, cooldowns, failover, OpenAI-compatible requests, and SSE parsing.
- `.github/workflows/build-ipa.yml`: unsigned device build and `.ipa` packaging on GitHub Actions.

**Important:** This is a mobile client, not a port of the upstream Node.js server. Direct mode can only call providers whose API supports device-side access and whose terms permit it. Provider CORS does not affect native `URLSession`, but providers may restrict mobile-origin traffic, expose keys to the device owner, or require server-side secrets. Use a trusted HTTPS FreeLLMAPI gateway for broad upstream compatibility. Never expose a gateway admin token or provider master key in a public build.

## Build locally

Requires macOS, Xcode, and command-line tools.

```bash
xcodebuild -project ios/PrismLLM.xcodeproj -scheme PrismLLM \
  -configuration Release -sdk iphoneos -derivedDataPath build \
  CODE_SIGNING_ALLOWED=NO build
```

The GitHub workflow uses XcodeGen to generate the project, builds unsigned, then packages `Payload/PrismLLM.app` as `PrismLLM.ipa`.

Unsigned IPA files are not installable as-is on ordinary iPhones. Sideload with a tool/workflow that signs the app using a certificate and provisioning profile.

## Configure

1. Push this repository to GitHub.
2. Run the `Build unsigned iOS IPA` workflow or push to `main`.
3. Download the `PrismLLM-unsigned-ipa` artifact.
4. Open PrismLLM and select **Settings**.
5. Choose **External gateway** and enter your gateway URL, e.g. `https://your-host.example/v1`, plus its unified bearer token; or choose **Direct** and add a provider key.
6. Select a model returned by `GET /models` or enter a provider model ID.

The client uses OpenAI-compatible `/models` and `/chat/completions`. Anthropic-compatible gateways can be added as an adapter; this starter intentionally keeps the interoperable OpenAI surface as its stable baseline.

## Security notes

- Gateway/provider keys are stored in iOS Keychain by the native bridge when running in the iOS shell.
- Browser preview falls back to localStorage and is **not** suitable for sensitive keys.
- Chat history is stored locally in IndexedDB with a localStorage fallback.
- Backups are JSON. Exported backups contain credentials only if the user explicitly selects “include keys”; exported key material is not encrypted by this app. Keep such files private.
- HTTPS is strongly recommended. Do not use a remote HTTP gateway over untrusted networks.
- Local device storage is not a substitute for a server-side secrets vault.

## Upstream

FreeLLMAPI's upstream architecture and API behavior evolve. The client is designed against its documented OpenAI-compatible `/v1/models` and `/v1/chat/completions` surface rather than copying or claiming to reproduce its server internals. See https://github.com/tashfeenahmed/freellmapi .
