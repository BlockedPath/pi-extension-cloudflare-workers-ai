# Cloudflare Workers AI provider for pi

A [pi package](https://pi.dev) that registers Cloudflare Workers AI as the `cloudflare-workers-ai` model provider.

The extension uses Cloudflare's OpenAI-compatible Chat Completions endpoint and includes the Workers AI model catalog with reasoning, image-input, context-window, output-limit, pricing, and compatibility metadata.

## Requirements

Set both variables before starting pi:

```bash
export CLOUDFLARE_ACCOUNT_ID="your-account-id"
export CLOUDFLARE_API_KEY="your-api-token"
```

The API token must have permission to run Workers AI models for the account.

## Install

```bash
pi install pi-extension-cloudflare-workers-ai
```

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
  --model '@cf/ibm-granite/granite-4.0-h-micro' \
  'Say hello'
```

## Development check

```bash
npm run check
```

The extension is TypeScript loaded directly by pi; no build step is required.
