// Cloudflare Workers AI model catalog, ported from
// pi/packages/ai/src/providers/cloudflare-workers-ai.models.ts (auto-generated).

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export const COMPAT = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsLongCacheRetention: false,
	sendSessionAffinityHeaders: true,
} as const;

// Keep newer runtime metadata in variables for compatibility with older pi type
// declarations, whose excess-property checks do not yet know `max` or
// `deferredToolsMode`. Pi still receives both keys at runtime.
const KIMI_K3_THINKING_LEVEL_MAP = {
	off: null,
	minimal: null,
	low: null,
	medium: null,
	high: null,
	xhigh: null,
	max: "max",
} as const;

// Workers AI only accepts `xhigh` (its default), `medium`, and `low` as the
// reasoning effort for qwen3.8-27b. pi sends its own level verbatim when a map
// entry is missing, so the default `high` comes back as a bare
// `400 status code (no body)`. Fold pi's seven levels onto the three accepted
// values; `off` is null because the endpoint cannot disable reasoning at all.
const QWEN_3_8_THINKING_LEVEL_MAP = {
	off: null,
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "xhigh",
	xhigh: "xhigh",
	max: "xhigh",
} as const;

// Newer sglang-backed Workers AI models take pi's full seven-level ladder
// verbatim; only `off` needs translating to the endpoint's `none`. Verified by
// probing each level (accepted) plus a bogus level (rejected with HTTP 400).
const FULL_EFFORT_THINKING_LEVEL_MAP = {
	off: "none",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
} as const;

// @cf/zai-org/glm-5.3 (unlike glm-5.3-flash) really does reject `minimal` and
// `xhigh` with HTTP 400, so fold pi's seven levels onto its five accepted
// values. Do not trust the 400 body's literal list on other models: DeepSeek V4
// Pro prints this same five-value list yet accepts `minimal` and `xhigh`, which
// produce distinct reasoning lengths — always probe each level directly.
const GLM_5_3_THINKING_LEVEL_MAP = {
	off: "none",
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "max",
	max: "max",
} as const;

const KIMI_K3_COMPAT = {
	...COMPAT,
	requiresReasoningContentOnAssistantMessages: true,
	deferredToolsMode: "kimi",
} as const;

export const MODELS: ProviderModelConfig[] = [
	{
		id: "@cf/deepseek-ai/deepseek-v4-flash-0731",
		name: "DeepSeek V4 Flash 0731",
		reasoning: true,
		thinkingLevelMap: FULL_EFFORT_THINKING_LEVEL_MAP,
		input: ["text"],
		cost: { input: 0.44, output: 1.32, cacheRead: 0.014, cacheWrite: 0 },
		// Verified: input + max_completion_tokens must stay under 1048576, so the
		// output cap has to leave real room for the prompt.
		contextWindow: 1_048_576,
		maxTokens: 131_072,
		compat: COMPAT,
	},
	{
		id: "@cf/deepseek-ai/deepseek-v4-pro-0813",
		name: "DeepSeek V4 Pro 0813",
		reasoning: true,
		thinkingLevelMap: FULL_EFFORT_THINKING_LEVEL_MAP,
		input: ["text", "image"],
		cost: { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 131_072,
		compat: COMPAT,
	},
	{
		id: "@cf/google/gemma-4-26b-a4b-it",
		name: "Gemma 4 26B A4B IT",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0.1, output: 0.3, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 256_000,
		maxTokens: 16_384,
		compat: COMPAT,
	},
	{
		id: "@cf/ibm-granite/granite-4.0-h-micro",
		name: "Granite 4.0 H Micro",
		reasoning: false,
		input: ["text"],
		cost: { input: 0.017, output: 0.112, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131_000,
		maxTokens: 131_000,
		compat: COMPAT,
	},
	{
		id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
		name: "Llama 3.3 70B Instruct fp8 Fast",
		reasoning: false,
		input: ["text"],
		cost: { input: 0.293, output: 2.253, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 24_000,
		maxTokens: 24_000,
		compat: COMPAT,
	},
	{
		id: "@cf/meta/llama-4-scout-17b-16e-instruct",
		name: "Llama 4 Scout 17B 16E Instruct",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0.27, output: 0.85, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131_000,
		maxTokens: 16_384,
		compat: COMPAT,
	},
	{
		id: "@cf/mistralai/mistral-small-3.1-24b-instruct",
		name: "Mistral Small 3.1 24B Instruct",
		reasoning: false,
		input: ["text"],
		cost: { input: 0.351, output: 0.555, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 128_000,
		compat: COMPAT,
	},
	{
		id: "@cf/moonshotai/kimi-k2.6",
		name: "Kimi K2.6",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 256_000,
		compat: COMPAT,
	},
	{
		id: "@cf/moonshotai/kimi-k2.7-code",
		name: "Kimi K2.7 Code",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 262_144,
		compat: COMPAT,
	},
	{
		id: "@cf/nvidia/nemotron-3-120b-a12b",
		name: "Nemotron 3 Super 120B",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.5, output: 1.5, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 256_000,
		maxTokens: 256_000,
		compat: COMPAT,
	},
	{
		id: "@cf/openai/gpt-oss-120b",
		name: "GPT OSS 120B",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.35, output: 0.75, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
		compat: COMPAT,
	},
	{
		id: "@cf/openai/gpt-oss-20b",
		name: "GPT OSS 20B",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.2, output: 0.3, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
		compat: COMPAT,
	},
	{
		id: "@cf/qwen/qwen3-30b-a3b-fp8",
		name: "Qwen3 30B A3b fp8",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.0509, output: 0.335, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_768,
		maxTokens: 32_768,
		compat: COMPAT,
	},
	{
		id: "@cf/qwen/qwen3.8-27b",
		name: "Qwen3.8 27B",
		reasoning: true,
		thinkingLevelMap: QWEN_3_8_THINKING_LEVEL_MAP,
		input: ["text", "image"],
		cost: { input: 0.45, output: 3.2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 262_144,
		compat: COMPAT,
	},
	{
		id: "@cf/zai-org/glm-4.7-flash",
		name: "GLM-4.7-Flash",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.0605, output: 0.4, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131_072,
		maxTokens: 131_072,
		compat: COMPAT,
	},
	{
		id: "@cf/zai-org/glm-5.2",
		name: "Glm 5.2",
		reasoning: true,
		input: ["text"],
		cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
		contextWindow: 262_144,
		maxTokens: 262_144,
		compat: COMPAT,
	},
	{
		id: "@cf/zai-org/glm-5.3-flash",
		name: "GLM-5.3-Flash",
		reasoning: true,
		// Flash accepts all seven levels; the non-flash glm-5.3 does not.
		thinkingLevelMap: FULL_EFFORT_THINKING_LEVEL_MAP,
		input: ["text", "image"],
		cost: { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 },
		// Verified: total (input + max_completion_tokens) must stay under 1048576.
		contextWindow: 1_048_576,
		maxTokens: 131_072,
		compat: COMPAT,
	},
	{
		id: "@cf/zai-org/glm-5.3",
		name: "GLM-5.3",
		reasoning: true,
		thinkingLevelMap: GLM_5_3_THINKING_LEVEL_MAP,
		input: ["text"],
		cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 131_072,
		compat: COMPAT,
	},
	{
		id: "moonshotai/kimi-k3",
		name: "Kimi K3",
		reasoning: true,
		thinkingLevelMap: KIMI_K3_THINKING_LEVEL_MAP,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 131_072,
		compat: KIMI_K3_COMPAT,
	},
];
