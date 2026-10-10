import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import {
	CATALOG_MAX_AGE_MS,
	fetchCloudflareModelCatalog,
	isCatalogFresh,
	mapCloudflareCatalog,
	refreshModelBaseUrl,
	restoreStoredCatalog,
} from "../src/model-refresh.ts";
import { MODELS } from "../src/models.ts";

function remoteModel(
	name: string,
	properties: Record<string, unknown>,
	task = "Text Generation",
) {
	return {
		name,
		task: { name: task },
		properties: Object.entries(properties).map(([property_id, value]) => ({
			property_id,
			value,
		})),
	};
}

test("bundles the Cloudflare GLM 5.3 models", () => {
	const flash = MODELS.find(
		(model) => model.id === "@cf/zai-org/glm-5.3-flash",
	);
	assert.ok(flash);
	assert.equal(flash.reasoning, true);
	assert.deepEqual(flash.input, ["text", "image"]);
	assert.deepEqual(flash.cost, {
		input: 0.15,
		output: 0.5,
		cacheRead: 0.03,
		cacheWrite: 0,
	});
	assert.equal(flash.contextWindow, 1_048_576);
	assert.equal(flash.maxTokens, 131_072);

	const flagship = MODELS.find(
		(model) => model.id === "@cf/zai-org/glm-5.3",
	);
	assert.ok(flagship);
	assert.equal(flagship.reasoning, true);
	assert.deepEqual(flagship.input, ["text"]);
	assert.deepEqual(flagship.cost, {
		input: 1.4,
		output: 4.4,
		cacheRead: 0.26,
		cacheWrite: 0,
	});
	assert.equal(flagship.contextWindow, 1_048_576);
	assert.equal(flagship.maxTokens, 131_072);
});

test("maps tool-capable text-generation models and preserves curated metadata", () => {
	const models = mapCloudflareCatalog(
		[
			remoteModel("@cf/qwen/qwen3.8-27b", {
				function_calling: "true",
				reasoning: "true",
				vision: "true",
				context_window: "300000",
				price: [
					{ unit: "per M input tokens", price: 0.5 },
					{ unit: "per M output tokens", price: 3.5 },
					{ unit: "per M cached input tokens", price: 0.05 },
				],
			}),
			remoteModel("@cf/example/no-tools", { function_calling: "false" }),
			remoteModel(
				"@cf/example/not-text",
				{ function_calling: "true" },
				"Translation",
			),
		],
		MODELS,
	);

	const qwen = models.find((model) => model.id === "@cf/qwen/qwen3.8-27b");
	assert.ok(qwen);
	assert.equal(qwen.contextWindow, 300_000);
	assert.equal(qwen.maxTokens, 262_144);
	assert.equal(qwen.reasoning, true);
	assert.deepEqual(qwen.input, ["text", "image"]);
	assert.deepEqual(qwen.cost, {
		input: 0.5,
		output: 3.5,
		cacheRead: 0.05,
		cacheWrite: 0,
	});
	assert.equal(qwen.thinkingLevelMap?.high, "xhigh");
	assert.equal(
		models.some((model) => model.id === "@cf/example/no-tools"),
		false,
	);
	assert.equal(
		models.some((model) => model.id === "@cf/example/not-text"),
		false,
	);
	assert.equal(
		models.some((model) => model.id === "moonshotai/kimi-k3"),
		true,
	);
});

test("creates safe defaults for newly discovered models", () => {
	const [model] = mapCloudflareCatalog(
		[
			remoteModel("@cf/zai-org/glm-5.3-flash", {
				function_calling: true,
				reasoning: true,
				vision: true,
				context_window: "1310720",
				price: [
					{ unit: "per M input tokens", price: 0.15 },
					{ unit: "per M output tokens", price: 0.5 },
				],
			}),
		],
		[],
	);

	assert.equal(model.id, "@cf/zai-org/glm-5.3-flash");
	assert.equal(model.name, "GLM 5.3 Flash");
	assert.equal(model.contextWindow, 1_310_720);
	assert.equal(model.maxTokens, 131_072);
	assert.deepEqual(model.input, ["text", "image"]);
});

test("pins verified GLM limits over incorrect remote and stored metadata", () => {
	const remote = mapCloudflareCatalog(
		[
			remoteModel("@cf/zai-org/glm-5.3-flash", {
				function_calling: true,
				reasoning: true,
				vision: true,
				context_window: "1310720",
				max_output_tokens: "1048576",
			}),
		],
		MODELS,
	).find((model) => model.id === "@cf/zai-org/glm-5.3-flash");
	assert.ok(remote);
	assert.equal(remote.contextWindow, 1_048_576);
	assert.equal(remote.maxTokens, 131_072);

	const bundled = MODELS.find(
		(model) => model.id === "@cf/zai-org/glm-5.3-flash",
	);
	assert.ok(bundled);
	const stale = {
		...bundled,
		provider: "cloudflare-workers-ai",
		contextWindow: 1_310_720,
		maxTokens: 1_048_576,
		thinkingLevelMap: undefined,
	};
	const restored = restoreStoredCatalog([stale], MODELS).find(
		(model) => model.id === stale.id,
	);
	assert.ok(restored);
	assert.equal(restored.contextWindow, 1_048_576);
	assert.equal(restored.maxTokens, 131_072);
	assert.equal(restored.thinkingLevelMap?.high, "high");
});

test("fetches the authenticated Cloudflare catalog", async () => {
	let requestedUrl = "";
	let authorization = "";
	const fetchImpl = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		requestedUrl = String(input);
		authorization = new Headers(init?.headers).get("authorization") ?? "";
		return Response.json({
			success: true,
			result: [
				remoteModel("@cf/example/tool-model", { function_calling: "true" }),
			],
		});
	}) as typeof fetch;

	const models = await fetchCloudflareModelCatalog({
		accountId: "account/id",
		apiKey: "secret",
		signal: new AbortController().signal,
		baseline: [],
		fetchImpl,
	});

	assert.equal(models[0]?.id, "@cf/example/tool-model");
	assert.match(requestedUrl, /accounts\/account%2Fid\/ai\/models\/search/);
	assert.match(requestedUrl, /task=Text\+Generation/);
	assert.equal(authorization, "Bearer secret");
});

test("restores only this provider's cached models and applies freshness TTL", () => {
	const cached = {
		...MODELS[0],
		provider: "cloudflare-workers-ai",
	};
	const foreign = { ...MODELS[1], provider: "other" };
	assert.deepEqual(
		restoreStoredCatalog([cached, foreign], MODELS).map((model) => model.id),
		[cached.id, "moonshotai/kimi-k3"],
	);
	assert.equal(isCatalogFresh(1_000, 1_000 + CATALOG_MAX_AGE_MS - 1), true);
	assert.equal(isCatalogFresh(1_000, 1_000 + CATALOG_MAX_AGE_MS), false);
});

const clefClassifier: ProviderModelConfig = {
	id: "@cf/cloudflare/clef",
	name: "Clef",
	type: "classifier",
	api: "cloudflare-workers-ai-system-one",
	baseUrl:
		"https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai",
	input: ["text"],
	cost: { input: 0.24, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 65536,
};

test("restoreStoredCatalog preserves classifier model types", () => {
	const stored = { ...clefClassifier, provider: "cloudflare-workers-ai" };
	const restored = restoreStoredCatalog([stored], MODELS).find(
		(model) => model.id === clefClassifier.id,
	);
	assert.ok(restored);
	assert.equal(restored.type, "classifier");
	assert.equal(restored.api, "cloudflare-workers-ai-system-one");
	assert.equal(restored.baseUrl, clefClassifier.baseUrl);
});

test("mapCloudflareCatalog keeps baseline classifiers missing from the remote catalog", () => {
	const models = mapCloudflareCatalog([], [...MODELS, clefClassifier]);
	const clef = models.find((model) => model.id === clefClassifier.id);
	assert.ok(clef);
	assert.equal(clef.type, "classifier");
	assert.equal(clef.baseUrl, clefClassifier.baseUrl);
});

test("refreshModelBaseUrl keeps the System One endpoint for classifiers", () => {
	const chatBaseUrl =
		"https://api.cloudflare.com/client/v4/accounts/example/ai/v1";
	assert.equal(
		refreshModelBaseUrl({ ...MODELS[0] }, chatBaseUrl),
		chatBaseUrl,
	);
	assert.equal(
		refreshModelBaseUrl(clefClassifier, chatBaseUrl),
		clefClassifier.baseUrl,
	);
});
