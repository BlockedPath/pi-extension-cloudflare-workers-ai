// Cloudflare Workers AI — pi extension provider.
//
// Workers AI exposes an OpenAI Chat Completions endpoint at:
//   https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1
//
// Auth: `Authorization: Bearer $CLOUDFLARE_API_KEY` is added automatically by
// the openai-completions API when `apiKey` is set.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MODELS } from "./models.ts";

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const BASE_URL = ACCOUNT_ID
	? `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/v1`
	: "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1";

export default function (pi: ExtensionAPI) {
	pi.registerProvider("cloudflare-workers-ai", {
		name: "Cloudflare Workers AI",
		baseUrl: BASE_URL,
		apiKey: "$CLOUDFLARE_API_KEY",
		api: "openai-completions",
		models: MODELS,
	});

	if (!ACCOUNT_ID) {
		pi.on("session_start", (_event, ctx) => {
			if (ctx.hasUI) {
				ctx.ui.notify(
					"cloudflare-workers-ai: CLOUDFLARE_ACCOUNT_ID not set — set it (and CLOUDFLARE_API_KEY) and restart pi",
					"warning",
				);
			}
		});
	}
}
