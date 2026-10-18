# Cloudflare Workers AI provider for pi

A [pi package](https://pi.dev) that registers Cloudflare Workers AI as the `cloudflare-workers-ai` model provider. It also ships [clef-gate](#clef-permission-gate), a permission gate that uses Cloudflare's Clef classifier to judge risky tool calls before they run.

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

## Clef permission gate

The package includes a second extension, `src/clef-gate.ts`, which pi loads alongside the provider. It intercepts `bash`, `powershell`, `edit`, and `write` tool calls and asks the Clef classifier (`@cf/cloudflare/clef`) whether each call is safe to run without asking you first. Read-only tools pass through untouched.

How a gated call is decided:

1. **Deterministic denylist** — patterns that are almost never safe to auto-run (recursive force delete, `git reset --hard`, `curl | bash`, raw device writes, …) and sensitive paths (`~/.ssh`, `/etc`, `~/.pi/agent/auth.json`, private keys, …) skip Clef and go straight to asking you.
2. **Clef verdict** — anything else is classified. At `P(safe) ≥ 0.8` (configurable) the call runs silently.
3. **Ask** — if Clef is unsure or unreachable, you decide. With no UI available the call is blocked (fail-safe). Approvals and Clef verdicts are cached for 10 minutes, so retries of the exact same call don't re-ask.

### The ask dialog

The dialog isn't just Yes/No — it also lets you stop being asked about the same thing:

```text
Clef gate: allow bash?
Matches dangerous pattern: recursive force delete
$ cat > /tmp/test.sh <<'EOF' …

→ Yes — allow once
  Yes — auto-approve "recursive force delete" for this session
  Yes — auto-approve everything for this session
  No — block
```

Auto-approve choices are session-only — every new session starts back at asking. On Clef-unsure asks, the scoped option reads "auto-approve *tool* calls Clef doesn't auto-allow" instead.

### Commands

`/clef-gate` (alias `/clef`) controls the gate. Type `/clef ` and pick from the argument dropdown — `/clef auto ` descends into a pattern picker and `/clef auto-tool ` into a tool picker.

| Command | Effect |
| --- | --- |
| `/clef` or `/clef status` | Mode, Clef availability, threshold, active auto-approve scopes, recent gated calls |
| `/clef on` (or `ask`) | Ask when unsure; cancels auto-approve-everything (pattern scopes kept) |
| `/clef off` | Gate off for this session — calls run unjudged and unlogged |
| `/clef auto` | Auto-approve anything that would ask (still judged and recorded) |
| `/clef auto <pattern>` | Auto-approve one denylist/path label, e.g. `/clef auto recursive force delete` |
| `/clef auto-tool bash\|powershell\|edit\|write` | Auto-approve asks for one tool |
| `/clef clear-auto` | Remove all auto-approve; back to asking |

### Configuration

Environment variables, read when the extension loads:

| Variable | Effect |
| --- | --- |
| `CLEF_GATE_MODEL` | Classifier model id (default `@cf/cloudflare/clef`) |
| `CLEF_GATE_THRESHOLD` | `P(safe)` at/above which calls auto-run (default `0.8`) |
| `CLEF_GATE_MODE` | `ask` (default), `auto`, or `off` — wins over the two below |
| `CLEF_GATE_ENABLED=0` | Start with the gate off |
| `CLEF_GATE_AUTO_APPROVE=1` | Start in auto-approve-everything mode (also allows headless runs) |
| `CLEF_GATE_AUTO_PATTERNS` | Comma-separated pattern labels to auto-approve, e.g. `"recursive force delete,git reset --hard (discards changes)"` |
| `CLEF_GATE_AUTO_TOOLS` | Comma-separated tools whose asks auto-approve, e.g. `"bash,edit"` |
| `CLEF_GATE_DRY_RUN=1` | Log verdicts, never block or ask |

Don't want the gate at all? Set `CLEF_GATE_ENABLED=0` before starting pi, or run `/clef off` per session.

> If you previously installed `clef-gate.ts` manually in `~/.pi/agent/extensions/`, remove that copy after updating this package — otherwise the gate loads twice and every ask prompts twice.

## Model updates

The provider participates in pi's model-catalog refresh system. Discovered models and their capabilities, context windows, and token pricing are cached in `~/.pi/agent/models-store.json` for offline startup. The cache is refreshed from Cloudflare after four hours; the bundled catalog remains available if discovery cannot run. Because that store is also written by pi's built-in catalog layer, bundled models the store does not know about yet are merged back in on restore, so a newly bundled model is visible in `/model` immediately instead of waiting for pi's upstream catalog to catch up.

Force an immediate catalog refresh with:

```bash
pi update --models
```

Only Cloudflare text-generation models that advertise function calling are added, so every automatically discovered entry is suitable for pi's agent tools.

Two catalog entries are excluded despite advertising function calling (`EXCLUDED_CATALOG_MODEL_IDS` in `src/model-refresh.ts`): `@cf/utter-project/eurollm-9b-it` and `@cf/swiss-ai/apertus-v1.5-8b` are gated behind an access-request form — verified 2026-10-18, the first returns `400 model does not have config` and the second `403 account is not allowed` on an ordinary account. They are filtered from both discovery and the restored cache so `/model` never lists models that fail on every request; remove an id from the exclusion set once it is generally available. The bundled catalog also includes `@cf/daily-co/phonellm-mini-alpha-2` (no published per-token pricing, so its cost is recorded as 0).

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
