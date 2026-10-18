import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { COMPAT } from "./models.ts";

export const PROVIDER_ID = "cloudflare-workers-ai";
export const CATALOG_MAX_AGE_MS = 4 * 60 * 60 * 1_000;

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 131_072;
const MODELS_PER_PAGE = 100;
const MAX_PAGES = 10;

// Cloudflare's catalog currently reports the full context size as the output
// limit for these models. Keep the verified bundled limits so pi does not send
// an invalid million-token max_completion_tokens value and receive HTTP 400.
const PINNED_METADATA_MODEL_IDS = new Set([
	"@cf/zai-org/glm-5.3",
	"@cf/zai-org/glm-5.3-flash",
	"@cf/deepseek-ai/deepseek-v4-flash-0731",
	"@cf/deepseek-ai/deepseek-v4-pro-0813",
]);

// These catalog entries advertise function calling but are gated behind an
// access-request form and cannot run on an ordinary account (verified
// 2026-10-18: eurollm-9b-it returns 400 "model does not have config" on both
// /ai/v1 and /ai/run; apertus-v1.5-8b returns 403 "account is not allowed").
// Keep them out of the discovered and restored catalogs so /model does not
// list entries that fail on every request. Remove an id here once the model
// is generally available.
export const EXCLUDED_CATALOG_MODEL_IDS = new Set([
	"@cf/utter-project/eurollm-9b-it",
	"@cf/swiss-ai/apertus-v1.5-8b",
]);

interface CloudflareProperty {
	property_id?: unknown;
	value?: unknown;
}

interface CloudflareCatalogModel {
	name?: unknown;
	task?: { name?: unknown };
	properties?: unknown;
}

interface CloudflareCatalogResponse {
	success?: boolean;
	errors?: Array<{ code?: unknown; message?: unknown }>;
	result?: unknown;
}

interface StoredCatalogModel extends ProviderModelConfig {
	provider?: string;
}

export interface FetchCatalogOptions {
	accountId: string;
	apiKey: string;
	signal: AbortSignal;
	baseline: readonly ProviderModelConfig[];
	fetchImpl?: typeof fetch;
}

function propertiesById(model: CloudflareCatalogModel): Map<string, unknown> {
	if (!Array.isArray(model.properties)) return new Map();

	return new Map(
		model.properties.flatMap((property: CloudflareProperty) =>
			typeof property?.property_id === "string"
				? [[property.property_id, property.value] as const]
				: [],
		),
	);
}

function isTrue(value: unknown): boolean {
	return value === true || value === "true";
}

function positiveInteger(value: unknown, fallback: number): number {
	const parsed =
		typeof value === "number"
			? value
			: typeof value === "string"
				? Number(value)
				: Number.NaN;
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function priceFor(
	prices: unknown,
	predicate: (unit: string) => boolean,
): number | undefined {
	if (!Array.isArray(prices)) return undefined;

	for (const price of prices) {
		if (!price || typeof price !== "object") continue;
		const { unit, price: amount } = price as { unit?: unknown; price?: unknown };
		if (typeof unit !== "string" || !predicate(unit.toLowerCase())) continue;
		if (typeof amount === "number" && Number.isFinite(amount) && amount >= 0)
			return amount;
	}

	return undefined;
}

function modelCost(
	prices: unknown,
	baseline?: ProviderModelConfig,
): ProviderModelConfig["cost"] {
	if (!Array.isArray(prices) || prices.length === 0) {
		return baseline?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	}

	return {
		input:
			priceFor(
				prices,
				(unit) => unit.includes("input token") && !unit.includes("cached"),
			) ??
			baseline?.cost.input ??
			0,
		output:
			priceFor(
				prices,
				(unit) => unit.includes("output token") && !unit.includes("cached"),
			) ??
			baseline?.cost.output ??
			0,
		cacheRead:
			priceFor(prices, (unit) => unit.includes("cached input token")) ?? 0,
		cacheWrite:
			priceFor(prices, (unit) => unit.includes("cache write token")) ?? 0,
	};
}

function humanizeModelId(id: string): string {
	const slug = id.split("/").at(-1) ?? id;
	return slug
		.split("-")
		.filter(Boolean)
		.map((part) => {
			if (/^(?:glm|gpt|oss|fp\d+|a\d+b|it|ai)$/i.test(part))
				return part.toUpperCase();
			if (/^(?:\d+(?:\.\d+)?|\d+b)$/i.test(part)) return part.toUpperCase();
			return `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`;
		})
		.join(" ");
}

export function mapCloudflareCatalog(
	remoteModels: readonly CloudflareCatalogModel[],
	baseline: readonly ProviderModelConfig[],
): ProviderModelConfig[] {
	const baselineById = new Map(baseline.map((model) => [model.id, model]));
	const discovered = new Map<string, ProviderModelConfig>();

	for (const remote of remoteModels) {
		if (typeof remote.name !== "string" || !remote.name.startsWith("@cf/"))
			continue;
		if (EXCLUDED_CATALOG_MODEL_IDS.has(remote.name)) continue;
		if (remote.task?.name !== "Text Generation") continue;

		const properties = propertiesById(remote);
		if (!isTrue(properties.get("function_calling"))) continue;

		const existing = baselineById.get(remote.name);
		const contextWindow = positiveInteger(
			properties.get("context_window"),
			existing?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
		);
		const reportedMaxTokens =
			properties.get("max_output_tokens") ?? properties.get("max_tokens");
		const maxTokens = positiveInteger(
			reportedMaxTokens,
			existing?.maxTokens ?? Math.min(contextWindow, DEFAULT_MAX_TOKENS),
		);
		let input: ProviderModelConfig["input"] = existing?.input ?? ["text"];
		if (properties.has("vision"))
			input = isTrue(properties.get("vision")) ? ["text", "image"] : ["text"];

		const pinBundledMetadata =
			existing && PINNED_METADATA_MODEL_IDS.has(remote.name);
		discovered.set(remote.name, {
			...existing,
			id: remote.name,
			name: existing?.name ?? humanizeModelId(remote.name),
			reasoning: properties.has("reasoning")
				? isTrue(properties.get("reasoning"))
				: (existing?.reasoning ?? false),
			input,
			cost: modelCost(properties.get("price"), existing),
			contextWindow: pinBundledMetadata ? existing.contextWindow : contextWindow,
			maxTokens: pinBundledMetadata ? existing.maxTokens : maxTokens,
			compat: existing?.compat ?? COMPAT,
		});
	}

	// Cloudflare occasionally exposes preview aliases outside the public @cf
	// catalog (for example, moonshotai/kimi-k3), and the Text Generation
	// catalog never lists classifier models (@cf/cloudflare/clef,
	// clef-flash, typesafe/jev). Keep those curated entries so a refresh
	// does not purge non-chat model types.
	for (const model of baseline) {
		if (
			!model.id.startsWith("@cf/") ||
			(model.type && model.type !== "chat")
		)
			discovered.set(model.id, model);
	}

	return [...discovered.values()].sort((left, right) =>
		left.id.localeCompare(right.id),
	);
}

function catalogError(
	response: Response,
	payload: CloudflareCatalogResponse,
): Error {
	const details = payload.errors
		?.map((error) =>
			typeof error.message === "string"
				? error.message
				: String(error.code ?? "unknown error"),
		)
		.join("; ");
	return new Error(
		`Cloudflare model catalog request failed (${response.status}${details ? `: ${details}` : ""})`,
	);
}

export async function fetchCloudflareModelCatalog(
	options: FetchCatalogOptions,
): Promise<ProviderModelConfig[]> {
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const remoteModels: CloudflareCatalogModel[] = [];

	for (let page = 1; page <= MAX_PAGES; page += 1) {
		const query = new URLSearchParams({
			task: "Text Generation",
			hide_experimental: "true",
			include_deprecated: "false",
			per_page: String(MODELS_PER_PAGE),
			page: String(page),
		});
		const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(options.accountId)}/ai/models/search?${query}`;

		const response = await fetchImpl(url, {
			headers: { Authorization: `Bearer ${options.apiKey}` },
			signal: options.signal,
		});
		const payload = (await response.json()) as CloudflareCatalogResponse;
		if (
			!response.ok ||
			payload.success === false ||
			!Array.isArray(payload.result)
		) {
			throw catalogError(response, payload);
		}

		remoteModels.push(...(payload.result as CloudflareCatalogModel[]));
		if (payload.result.length < MODELS_PER_PAGE) break;
	}

	return mapCloudflareCatalog(remoteModels, options.baseline);
}

export function restoreStoredCatalog(
	models: readonly StoredCatalogModel[] | undefined,
	fallback: readonly ProviderModelConfig[],
): ProviderModelConfig[] {
	const fallbackById = new Map(fallback.map((model) => [model.id, model]));
	const restored = (models ?? [])
		.filter(
			(model) =>
				(!model.provider || model.provider === PROVIDER_ID) &&
				!EXCLUDED_CATALOG_MODEL_IDS.has(model.id),
		)
		.map((model): ProviderModelConfig => {
			const bundled = fallbackById.get(model.id);
			const pinBundledMetadata =
				bundled && PINNED_METADATA_MODEL_IDS.has(model.id);
			return {
				id: model.id,
				name: model.name,
				api: model.api,
				baseUrl: model.baseUrl,
				// Preserve non-chat model types (classifier/image) so stored
				// System One classifier models keep their type instead of
				// defaulting to chat and failing streaming with an unregistered
				// api error.
				type: model.type,
				reasoning: model.reasoning,
				thinkingLevelMap: pinBundledMetadata
					? bundled.thinkingLevelMap
					: model.thinkingLevelMap,
				input: [...model.input],
				cost: model.cost,
				contextWindow: pinBundledMetadata
					? bundled.contextWindow
					: model.contextWindow,
				maxTokens: pinBundledMetadata ? bundled.maxTokens : model.maxTokens,
				headers: model.headers,
				compat: model.compat,
			};
		});
	if (restored.length === 0) return [...fallback];

	const merged = new Map(restored.map((model) => [model.id, model]));
	// Merge every bundled model the store does not know about. The store is
	// owned by pi's built-in catalog layer, so a model added to the bundled
	// catalog (for example @cf/daily-co/phonellm-mini-alpha-2) would otherwise
	// stay invisible until pi's upstream catalog catches up. A model removed
	// upstream lingers only until the bundled catalog drops it too — the same
	// behaviour as any shipped static catalog. Gated exclusions never merge.
	for (const model of fallback) {
		if (!merged.has(model.id) && !EXCLUDED_CATALOG_MODEL_IDS.has(model.id))
			merged.set(model.id, model);
	}
	return [...merged.values()].sort((left, right) =>
		left.id.localeCompare(right.id),
	);
}

// Base URL for a refreshed catalog entry. Chat models live under /ai/v1,
// but non-chat models keep their own baseUrl: System One classifiers are
// served from /ai/run, and rewriting them to /ai/v1 breaks classification
// with Cloudflare 400/7000 ("No route for that URI").
export function refreshModelBaseUrl(
	model: ProviderModelConfig,
	modelBaseUrl: string,
): string {
	if (model.type && model.type !== "chat") return model.baseUrl ?? modelBaseUrl;
	return modelBaseUrl;
}

export function storedCatalogModels(
	models: readonly ProviderModelConfig[],
	baseUrl: string,
) {
	return models.map((model) => ({
		...model,
		api: model.api ?? ("openai-completions" as const),
		provider: PROVIDER_ID,
		baseUrl: model.baseUrl ?? baseUrl,
	}));
}

export function isCatalogFresh(
	checkedAt: number | undefined,
	now = Date.now(),
): boolean {
	return (
		typeof checkedAt === "number" &&
		now - checkedAt >= 0 &&
		now - checkedAt < CATALOG_MAX_AGE_MS
	);
}
