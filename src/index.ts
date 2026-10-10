// Cloudflare Workers AI — pi extension provider.
//
// Workers AI exposes an OpenAI Chat Completions endpoint at:
//   https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1
//
// Auth: `Authorization: Bearer $CLOUDFLARE_API_KEY` is added automatically by
// the openai-completions API when `apiKey` is set.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	fetchCloudflareModelCatalog,
	isCatalogFresh,
	PROVIDER_ID,
	refreshModelBaseUrl,
	restoreStoredCatalog,
	storedCatalogModels,
} from "./model-refresh.ts";
import { MODELS } from "./models.ts";

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;

function baseUrl(accountId: string | undefined): string {
	return accountId
		? `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`
		: "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1";
}

const BASE_URL = baseUrl(ACCOUNT_ID);

export default function (pi: ExtensionAPI) {
	pi.registerProvider(PROVIDER_ID, {
		name: "Cloudflare Workers AI",
		baseUrl: BASE_URL,
		apiKey: "$CLOUDFLARE_API_KEY",
		api: "openai-completions",
		models: MODELS,
		async refreshModels(context) {
			const restored = restoreStoredCatalog(context.stored?.models, MODELS);
			if (
				!context.allowNetwork ||
				(isCatalogFresh(context.stored?.checkedAt) && !context.force)
			) {
				return restored;
			}

			const credentialEnv = context.credential?.env as
				| Record<string, string>
				| undefined;
			const accountId = credentialEnv?.CLOUDFLARE_ACCOUNT_ID ?? ACCOUNT_ID;
			const apiKey =
				context.credential?.type === "api_key" ? context.credential.key : undefined;
			if (!accountId || !apiKey) return restored;

			const modelBaseUrl = baseUrl(accountId);
			const catalog = await fetchCloudflareModelCatalog({
				accountId,
				apiKey,
				signal: context.signal,
				baseline: restored,
			});
			const refreshed = catalog.map((model) => ({
				...model,
				baseUrl: refreshModelBaseUrl(model, modelBaseUrl),
			}));

			const published = await context.publish({
				persist: {
					models: storedCatalogModels(refreshed, modelBaseUrl),
					checkedAt: Date.now(),
				},
			});
			return published ? refreshed : restored;
		},
	});

	// Warn only when auth is genuinely unavailable. ACCOUNT_ID reflects
	// process env at load time, but a stored credential (/login) covers auth
	// without any env vars — warning on env alone is a false positive.
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI || ACCOUNT_ID) return;
		const auth = await ctx.modelRegistry
			.getProviderAuth(PROVIDER_ID)
			.catch(() => undefined);
		if (!auth) {
			ctx.ui.notify(
				"cloudflare-workers-ai: no Cloudflare credentials — set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_KEY, or run /login for cloudflare-workers-ai, then restart pi",
				"warning",
			);
		}
	});
}
