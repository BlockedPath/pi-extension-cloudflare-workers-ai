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
	// catalog (for example, moonshotai/kimi-k3). Keep those curated entries.
	for (const model of baseline) {
		if (!model.id.startsWith("@cf/")) discovered.set(model.id, model);
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
		.filter((model) => !model.provider || model.provider === PROVIDER_ID)
		.map((model): ProviderModelConfig => {
			const bundled = fallbackById.get(model.id);
			const pinBundledMetadata =
				bundled && PINNED_METADATA_MODEL_IDS.has(model.id);
			return {
				id: model.id,
				name: model.name,
				api: model.api,
				baseUrl: model.baseUrl,
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
	for (const model of fallback) {
		if (!model.id.startsWith("@cf/") && !merged.has(model.id))
			merged.set(model.id, model);
	}
	return [...merged.values()].sort((left, right) =>
		left.id.localeCompare(right.id),
	);
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
