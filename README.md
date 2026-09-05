# Cloudflare Workers AI provider for pi

A [pi package](https://pi.dev) that registers Cloudflare Workers AI as the `cloudflare-workers-ai` model provider.

The extension uses Cloudflare's OpenAI-compatible Chat Completions endpoint and includes the Workers AI model catalog with reasoning, image-input, context-window, output-limit, pricing, and compatibility metadata. It also discovers new tool-capable text-generation models from Cloudflare's catalog API.

## Requirements

Set both variables before starting pi:

```bash
export CLOUDFLARE_ACCOUNT_ID="your-account-id"
export CLOUDFLARE_API_KEY="your-api-token"
```

The API token must have permission to run Workers AI models for the account.

## Install

```bash
pi install npm:pi-extension-cloudflare-workers-ai
```

The `npm:` scheme is required; a bare name is interpreted as a local directory path.

## Install locally

```bash
pi install ~/pi-extension-cloudflare-workers-ai
```

Local package installs reference the directory in place. Restart pi after changing `CLOUDFLARE_ACCOUNT_ID`, because the account-specific endpoint is assembled when the extension loads.

To try the package without installing it:

```bash
pi --no-extensions -e ./src/index.ts --list-models cloudflare-workers-ai
```

## Use

Start pi and open `/model`, then select a model under `cloudflare-workers-ai`.

For example:

```bash
pi --provider cloudflare-workers-ai \
  --model '@cf/zai-org/glm-5.3-flash' \
  'Say hello'
```

The bundled catalog includes `@cf/zai-org/glm-5.3-flash` (text and image input) and `@cf/zai-org/glm-5.3` (text input). Both require Workers Paid billing or prepaid AI Gateway credits.

Select these models under the `cloudflare-workers-ai` provider. A model ID beginning with `workers-ai/` belongs to pi's separate `cloudflare-ai-gateway` provider, not this extension.

## Model updates

The provider participates in pi's model-catalog refresh system. Discovered models and their capabilities, context windows, and token pricing are cached in `~/.pi/agent/models-store.json` for offline startup. The cache is refreshed from Cloudflare after four hours; the bundled catalog remains available if discovery cannot run.

Force an immediate catalog refresh with:

```bash
pi update --models
```

Only Cloudflare text-generation models that advertise function calling are added, so every automatically discovered entry is suitable for pi's agent tools.

## Known Cloudflare catalog quirks

Two things in Cloudflare's catalog API cause a bare `Error: 400 status code (no body)` on every request. Both are handled by the bundled metadata, which is pinned for the affected models (`PINNED_METADATA_MODEL_IDS` in `src/model-refresh.ts`) so a catalog refresh cannot overwrite it.

### 1. Reported output limit equals the context window

Cloudflare reports the full context size as the output limit for the GLM 5.3 and DeepSeek V4 models. Taking that at face value makes pi send a `max_completion_tokens` the endpoint cannot honour:

```text
max_completion_tokens is too large: 1310720. This model supports at most 1048576 completion tokens.
Requested token count exceeds the model's maximum context length of 1048576 tokens.
```

The second form is the nastier one: when `maxTokens == contextWindow`, *any* prompt pushes `input + max_completion_tokens` over the ceiling, so the model fails 100% of the time. Verified real limits for these four models are a 1048576-token total context with `maxTokens` pinned to 131072.

### 2. The 400 body's `reasoning_effort` literal list is not authoritative

Unsupported reasoning levels are also rejected with a 400. The error body names the accepted literals, but that list can be stale — `@cf/deepseek-ai/deepseek-v4-pro-0813` prints

```text
Input should be 'none', 'low', 'medium', 'high' or 'max'
```

yet accepts `minimal` and `xhigh`, and returns measurably different reasoning lengths for them. Probe each level directly instead of trusting the message:

| model | accepted `reasoning_effort` |
| --- | --- |
| `@cf/deepseek-ai/deepseek-v4-flash-0731` | all seven |
| `@cf/deepseek-ai/deepseek-v4-pro-0813` | all seven (despite the error text) |
| `@cf/zai-org/glm-5.3-flash` | all seven |
| `@cf/zai-org/glm-5.3` | `none`, `low`, `medium`, `high`, `max` only |

pi sends its own level verbatim when a `thinkingLevelMap` entry is missing, so every reasoning model needs a map: `FULL_EFFORT_THINKING_LEVEL_MAP` for the seven-level endpoints (only `off` becomes `none`), and a folded map for `@cf/zai-org/glm-5.3`, which genuinely rejects `minimal` and `xhigh`.

Other catalog entries still report `maxTokens == contextWindow` (for example `@cf/moonshotai/kimi-k2.7-code` and `@cf/nvidia/nemotron-3-120b-a12b`). They are not pinned yet; if one starts returning a bodyless 400, verify its real limits and add it to `PINNED_METADATA_MODEL_IDS`.

When the provider is supplied by pi itself rather than this extension, the same corrections can be applied as `modelOverrides` in `~/.pi/agent/models.json`, which is the topmost layer and survives catalog refreshes.

## Development check

```bash
npm run check
```

The extension is TypeScript loaded directly by pi; no build step is required.
