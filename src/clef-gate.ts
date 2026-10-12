// clef-gate — Clef-powered permission gate for risky tool calls.
//
// Intercepts bash / edit / write calls and asks Cloudflare's Clef classifier
// whether each call is safe to run without asking the user. Safe calls pass
// silently; anything else falls back to a confirmation dialog. When Clef is
// unreachable, every gated call asks (fail-safe).
//
// Env knobs:
//   CLEF_GATE_MODEL      classifier id (default "@cf/cloudflare/clef")
//   CLEF_GATE_THRESHOLD  P(safe) at/above which calls auto-run (default 0.8)
//   CLEF_GATE_DRY_RUN=1  log verdicts, never block or ask
//   CLEF_GATE_ENABLED=0  start with the gate off (default on)
//   CLEF_GATE_AUTO_APPROVE=1     auto-approve anything that would ask
//   CLEF_GATE_MODE=ask|auto|off  initial mode (wins over the two above)
//   CLEF_GATE_AUTO_PATTERNS="recursive force delete,…"
//                                denylist/sensitive-path labels to auto-approve
//   CLEF_GATE_AUTO_TOOLS="bash,edit"
//                                tools whose asks auto-approve
//
// Status and session toggle: /clef-gate [on|off|auto|status|clear-auto]
// The ask dialog also offers "auto-approve this pattern / everything for
// this session", so a recurring false positive only ever asks once.
// Auto-approve is session-only (via dialog or command); use the env vars
// above if you want it in every session.

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

const CLEF_PROVIDER = "cloudflare-workers-ai";
const CLEF_MODEL_ID =
	process.env.CLEF_GATE_MODEL ?? "@cf/cloudflare/clef";

function parseThreshold(): number {
	const raw = Number(process.env.CLEF_GATE_THRESHOLD);
	return Number.isFinite(raw) && raw > 0 && raw < 1 ? raw : 0.8;
}
const SAFE_THRESHOLD = parseThreshold();
const DRY_RUN = process.env.CLEF_GATE_DRY_RUN === "1";

// Session toggle. Starts on unless CLEF_GATE_ENABLED=0; /clef-gate on|off
// flips it at runtime. Deliberately not persisted: a safety gate should
// fail back to on for every new session.
let gateEnabled = process.env.CLEF_GATE_ENABLED !== "0";

// Session auto-approve. `autoApproveAll` approves anything the gate would
// otherwise ask about (denylist hits, Clef-unsure, Clef unavailable, gate
// errors) while still judging + recording each call. `autoApproveScopes`
// is the narrower version picked from the ask dialog, keyed by:
//   pattern:<denylist/path label> · ask:<tool> · error:<tool>
// Both reset every session; the CLEF_GATE_AUTO_* env vars opt in up front.
function parseCsvEnv(name: string): string[] {
	return (process.env[name] ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}
let autoApproveAll = process.env.CLEF_GATE_AUTO_APPROVE === "1";
const autoApproveScopes = new Set<string>([
	...parseCsvEnv("CLEF_GATE_AUTO_PATTERNS").map((label) => `pattern:${label}`),
	...parseCsvEnv("CLEF_GATE_AUTO_TOOLS").map((tool) => `ask:${tool.toLowerCase()}`),
]);
const initialMode = process.env.CLEF_GATE_MODE?.trim().toLowerCase();
if (initialMode === "off") {
	gateEnabled = false;
} else if (initialMode === "auto") {
	gateEnabled = true;
	autoApproveAll = true;
} else if (initialMode === "ask" || initialMode === "on") {
	gateEnabled = true;
	autoApproveAll = false;
}

interface AskScope {
	key: string;
	label: string;
}

/** Why this call auto-approves without asking, or null if it must ask. */
function autoApproveReason(toolName: string, scope: AskScope | null): string | null {
	if (autoApproveAll) return "auto-approve everything (session)";
	if (scope && autoApproveScopes.has(scope.key)) {
		return `auto-approve ${scope.label} (session)`;
	}
	if (autoApproveScopes.has(`ask:${toolName}`)) {
		return `auto-approve ${toolName} asks (session)`;
	}
	return null;
}

// Tools whose side effects Clef judges. Read-only tools (read, grep, find,
// ls, …) and session tools pass through untouched. The handler below checks
// these names explicitly (instead of a Set lookup) so TypeScript narrows the
// event union and `event.input` is typed per tool.

// Budgets for what we send Clef (Clef's context is 64k tokens; keep calls small).
const MAX_COMMAND_CHARS = 4000;
const MAX_EDIT_SIDE_CHARS = 1500;
const MAX_WRITE_PREVIEW_CHARS = 2000;

// Shell patterns that skip Clef and go straight to a confirmation dialog.
// These are almost never safe to auto-run, but the user may still allow them.
const DANGEROUS_COMMAND: ReadonlyArray<{ re: RegExp; label: string }> = [
	{ re: /\brm\s+-[a-z]*r[a-z]*f\b/i, label: "recursive force delete" },
	{ re: /\bmkfs\b/i, label: "filesystem format" },
	{ re: /\bdd\b[^\n|]*\bof=\/dev\//i, label: "raw device write" },
	{ re: /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;\s*:/, label: "fork bomb" },
	{ re: /\bcurl\b[^\n]*\|\s*(bash|sh)\b/i, label: "piped remote script" },
	{ re: /\bwget\b[^\n]*\|\s*(bash|sh)\b/i, label: "piped remote script" },
	{ re: /\bchmod\s+-R\s+777\s+\//, label: "recursive world-writable chmod on /" },
	{ re: /\bgit\s+clean\s+-[a-z]*f/i, label: "git clean -f (deletes untracked files)" },
	{ re: /\bgit\s+reset\s+--hard\b/i, label: "git reset --hard (discards changes)" },
	{ re: /\bdrop\s+(table|database)\b/i, label: "destructive SQL" },
	{ re: /\b(shutdown|reboot|halt|poweroff)\b/i, label: "system power control" },
	{ re: />\s*\/dev\/sd[a-z]\b/, label: "raw disk write" },
];

// File paths that skip Clef and go straight to a confirmation dialog.
const SENSITIVE_PATH: ReadonlyArray<{ re: RegExp; label: string }> = [
	{ re: /(^|\/)\.ssh(\/|$)/, label: "SSH credentials directory" },
	{ re: /(^|\/)\.gnupg(\/|$)/, label: "GPG directory" },
	{ re: /^\/etc(\/|$)/, label: "system config directory" },
	{ re: /\.pi\/agent\/auth\.json$/, label: "pi credential store" },
	{ re: /\.pem$/, label: "PEM key file" },
	{ re: /id_rsa/, label: "SSH private key" },
	{ re: /id_ed25519/, label: "SSH private key" },
];

function truncate(value: string, max: number): string {
	return value.length > max
		? `${value.slice(0, max)}\n…(truncated ${value.length - max} chars)`
		: value;
}

function oneLine(value: string, max: number): string {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function matchLabel(
	value: string,
	patterns: ReadonlyArray<{ re: RegExp; label: string }>,
): string | null {
	for (const { re, label } of patterns) {
		if (re.test(value)) return label;
	}
	return null;
}

interface CallDescription {
	state: Record<string, unknown>;
	summary: string;
	dangerHit: string | null;
}

function describeCall(
	event: Extract<
		ToolCallEvent,
		{ toolName: "bash" | "powershell" | "edit" | "write" }
	>,
): CallDescription {
	if (event.toolName === "bash" || event.toolName === "powershell") {
		const command = event.input.command;
		return {
			state: {
				tool: event.toolName,
				command: truncate(command, MAX_COMMAND_CHARS),
			},
			summary: `$ ${oneLine(command, 220)}`,
			dangerHit: matchLabel(command, DANGEROUS_COMMAND),
		};
	}
	if (event.toolName === "edit") {
		const { path, edits } = event.input;
		const joined = edits
			.map(
				(edit, i) =>
					`--- edit ${i + 1} ---\n- ${truncate(edit.oldText, MAX_EDIT_SIDE_CHARS)}\n+ ${truncate(edit.newText, MAX_EDIT_SIDE_CHARS)}`,
			)
			.join("\n");
		const changed = edits.reduce(
			(n, edit) => n + edit.oldText.length + edit.newText.length,
			0,
		);
		return {
			state: {
				tool: "edit",
				path,
				edit_count: edits.length,
				changed_chars: changed,
				edits: truncate(joined, MAX_COMMAND_CHARS),
			},
			summary: `${path} (${edits.length} edit${edits.length === 1 ? "" : "s"}, ~${changed} chars)`,
			dangerHit: matchLabel(path, SENSITIVE_PATH),
		};
	}
	const { path, content } = event.input;
	return {
		state: {
			tool: "write",
			path,
			bytes: content.length,
			preview: truncate(content, MAX_WRITE_PREVIEW_CHARS),
		},
		summary: `${path} (${content.length} bytes)`,
		dangerHit: matchLabel(path, SENSITIVE_PATH),
	};
}

interface Verdict {
	allow: boolean;
	pSafe: number | null;
	risk: string | null;
	at: number;
	reason: string;
}

const VERDICT_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;
const verdictCache = new Map<string, Verdict>();
// In-flight Clef calls, so concurrent identical tool calls share one request.
const inFlight = new Map<string, Promise<Verdict>>();

interface RecentEntry {
	time: string;
	tool: string;
	summary: string;
	pSafe: number | null;
	risk: string | null;
	decision: string;
}
const recent: RecentEntry[] = [];
function recordRecent(entry: RecentEntry): void {
	recent.push(entry);
	if (recent.length > 12) recent.shift();
}

function cacheKey(toolName: string, input: unknown): string {
	return `${toolName}::${JSON.stringify(input)}`;
}

function getCached(key: string): Verdict | undefined {
	const hit = verdictCache.get(key);
	if (!hit) return undefined;
	if (Date.now() - hit.at > VERDICT_TTL_MS) {
		verdictCache.delete(key);
		return undefined;
	}
	return hit;
}

function putCached(key: string, verdict: Verdict): void {
	if (verdictCache.size >= MAX_CACHE_ENTRIES) {
		const oldest = verdictCache.keys().next();
		if (!oldest.done) verdictCache.delete(oldest.value);
	}
	verdictCache.set(key, verdict);
}

let outageWarned = false;
function warnOutage(ctx: ExtensionContext, detail: string): void {
	if (outageWarned || !ctx.hasUI) return;
	outageWarned = true;
	ctx.ui.notify(`clef-gate: Clef unavailable (${detail}) — asking for every gated call`, "warning");
}

interface AskResult {
	approved: boolean;
	/** How it was decided, for the recent-calls log / block reason. */
	via: string;
}

/**
 * Fail-safe fallback: ask the user; without UI there is no one to ask, so
 * decline — unless an auto-approve scope already covers this call, which
 * is also what lets headless sessions run with CLEF_GATE_AUTO_APPROVE=1.
 * The dialog offers allow-once, auto-approve-this-scope, and
 * auto-approve-everything (both session-only), not just Yes/No.
 */
async function askUser(
	ctx: ExtensionContext,
	title: string,
	message: string,
	toolName: string,
	scope: AskScope | null,
): Promise<AskResult> {
	const autoReason = autoApproveReason(toolName, scope);
	if (autoReason) return { approved: true, via: autoReason };
	if (!ctx.hasUI) return { approved: false, via: "no UI to confirm" };
	const ALLOW_ONCE = "Yes — allow once";
	const ALLOW_SCOPE = scope
		? `Yes — auto-approve ${scope.label} for this session`
		: null;
	const ALLOW_ALL = "Yes — auto-approve everything for this session";
	const DENY = "No — block";
	try {
		if (typeof ctx.ui.select === "function") {
			const choice = await ctx.ui.select(`${title}\n${message}`, [
				ALLOW_ONCE,
				...(ALLOW_SCOPE ? [ALLOW_SCOPE] : []),
				ALLOW_ALL,
				DENY,
			]);
			if (choice === ALLOW_ONCE) return { approved: true, via: "user allowed" };
			if (scope && choice === ALLOW_SCOPE) {
				autoApproveScopes.add(scope.key);
				ctx.ui.notify(
					`clef-gate: auto-approving ${scope.label} for this session — /clef-gate clear-auto to undo`,
					"info",
				);
				return { approved: true, via: `user allowed + auto-approve ${scope.label}` };
			}
			if (choice === ALLOW_ALL) {
				autoApproveAll = true;
				ctx.ui.notify(
					"clef-gate: AUTO-APPROVE — anything the gate would ask about now runs without asking this session — /clef-gate on to undo",
					"warning",
				);
				return { approved: true, via: "user allowed + auto-approve everything" };
			}
			return {
				approved: false,
				via: choice === DENY ? "declined by user" : "dismissed by user",
			};
		}
	} catch {
		// select unsupported/errored in this UI mode: fall back to Yes/No.
	}
	try {
		const ok = await ctx.ui.confirm(title, message);
		return { approved: ok, via: ok ? "user allowed" : "declined by user" };
	} catch {
		return { approved: false, via: "declined by user" };
	}
}

async function judgeWithClef(
	event: Extract<
		ToolCallEvent,
		{ toolName: "bash" | "powershell" | "edit" | "write" }
	>,
	description: CallDescription,
	ctx: ExtensionContext,
): Promise<Verdict> {
	const key = cacheKey(event.toolName, event.input);
	const cached = getCached(key);
	if (cached) return cached;

	const pending = inFlight.get(key);
	if (pending) return pending;

	const task = (async (): Promise<Verdict> => {
		const model = ctx.modelRegistry.findOfType(
			"classifier",
			CLEF_PROVIDER,
			CLEF_MODEL_ID,
		);
		if (!model) {
			warnOutage(ctx, "classifier not registered");
			return {
				allow: false,
				pSafe: null,
				risk: null,
				at: Date.now(),
				reason: "Clef classifier is not registered",
			};
		}
		const result = await ctx.modelRegistry.classify(
			model,
			{
				state: description.state,
				questions: {
					safe: {
						type: "bool",
						instructions:
							"Should this tool call run automatically without asking the user first?",
						criteria: {
							true: "Read-only, reversible, or low-risk: listing files, running tests or builds, searching code, small project-scoped edits",
							false:
								"Deletes or overwrites important data, exfiltrates secrets or code, changes system/network/security config, runs remote or obfuscated code, touches credentials, or is irreversible or broadly scoped",
						},
					},
					risk: {
						type: "choice",
						instructions:
							"If this tool call is harmful or wrong, how bad is the outcome?",
						criteria: {
							low: "Easily undone or harmless (a read, a test run, a tiny local edit)",
							medium:
								"Annoying to undo (rewrites files, installs packages, pushes branches)",
							high: "Data loss, leaked secrets, broken system, or hard-to-reverse damage",
						},
					},
				},
			},
			ctx.signal ? { signal: ctx.signal } : undefined,
		);
		if (result.stopReason !== "stop") {
			warnOutage(ctx, result.errorMessage ?? result.stopReason);
			return {
				allow: false,
				pSafe: null,
				risk: null,
				at: Date.now(),
				reason: `Clef error: ${result.errorMessage ?? result.stopReason}`,
			};
		}
		const safeAnswer = result.answers.safe;
		const riskAnswer = result.answers.risk;
		const pSafe = safeAnswer?.type === "bool" ? safeAnswer.probability : 0;
		const risk = riskAnswer?.type === "choice" ? riskAnswer.choice : "unknown";
		const allow = pSafe >= SAFE_THRESHOLD;
		const verdict: Verdict = {
			allow,
			pSafe,
			risk,
			at: Date.now(),
			reason: allow
				? `Clef P(safe)=${pSafe.toFixed(2)} ≥ ${SAFE_THRESHOLD}`
				: `Clef P(safe)=${pSafe.toFixed(2)} < ${SAFE_THRESHOLD} (risk=${risk})`,
		};
		// Cache Clef's own verdict; the user's answer to the fallback dialog
		// is cached separately below so one approval covers retries.
		if (allow) putCached(key, verdict);
		return verdict;
	})();

	inFlight.set(key, task);
	try {
		return await task;
	} finally {
		inFlight.delete(key);
	}
}

export default function (pi: ExtensionAPI) {
	// No session_start "not registered" check here on purpose: the registry
	// may still be refreshing when the session starts, and a sync lookup at
	// that instant false-alarms. judgeWithClef re-resolves Clef on every
	// gated call and warnOutage() notifies once if it is genuinely absent.

	pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | void> => {
		if (!gateEnabled) return;
		if (
			event.toolName !== "bash" &&
			event.toolName !== "powershell" &&
			event.toolName !== "edit" &&
			event.toolName !== "write"
		) {
			return;
		}
		const description = describeCall(event);
		const key = cacheKey(event.toolName, event.input);

		try {
			// Deterministic denylist: skip Clef, go straight to the user
			// (unless this pattern / everything is auto-approved).
			if (description.dangerHit) {
				const scope: AskScope = {
					key: `pattern:${description.dangerHit}`,
					label: `"${description.dangerHit}"`,
				};
				const title = `Clef gate: allow ${event.toolName}?`;
				const message = `Matches dangerous pattern: ${description.dangerHit}\n${description.summary}`;
				if (DRY_RUN) {
					const autoReason = autoApproveReason(event.toolName, scope);
					console.log(`[clef-gate:dry-run] DENYLIST ${event.toolName} — ${description.dangerHit} — ${description.summary}`);
					ctx.ui.notify(`clef-gate (dry run): ${autoReason ? `would auto-approve (${autoReason})` : "would ask"} — ${description.dangerHit}`, "info");
					return;
				}
				const { approved, via } = await askUser(ctx, title, message, event.toolName, scope);
				recordRecent({
					time: new Date().toISOString(),
					tool: event.toolName,
					summary: description.summary,
					pSafe: null,
					risk: null,
					decision: approved ? `denylist→allowed (${via})` : `denylist→declined (${via})`,
				});
				if (approved) {
					putCached(key, {
						allow: true,
						pSafe: null,
						risk: null,
						at: Date.now(),
						reason: `approved denylisted call (${via})`,
					});
					return;
				}
				const reason = `clef-gate: blocked ${event.toolName} call (${description.dangerHit}) — ${via}. ${description.summary}`;
				if (ctx.hasUI) ctx.ui.notify(reason, "warning");
				return { block: true, reason, terminate: true };
			}

			const verdict = await judgeWithClef(event, description, ctx);

			if (DRY_RUN) {
				console.log(
					`[clef-gate:dry-run] ${event.toolName} P(safe)=${verdict.pSafe?.toFixed(2) ?? "?"} risk=${verdict.risk ?? "?"} → ${verdict.allow ? "allow" : "ask"} — ${description.summary}`,
				);
				return;
			}

			if (verdict.allow) {
				recordRecent({
					time: new Date().toISOString(),
					tool: event.toolName,
					summary: description.summary,
					pSafe: verdict.pSafe,
					risk: verdict.risk,
					decision: "allowed",
				});
				return;
			}

			// Clef is unsure (or errored): fail-safe fallback is to ask the user.
			const score =
				verdict.pSafe === null
					? "Clef unavailable"
					: `P(safe)=${verdict.pSafe.toFixed(2)}, risk=${verdict.risk}`;
			const { approved, via } = await askUser(
				ctx,
				`Clef gate: allow ${event.toolName}?`,
				`${score}\n${description.summary}`,
				event.toolName,
				{
					key: `ask:${event.toolName}`,
					label: `${event.toolName} calls Clef doesn't auto-allow`,
				},
			);
			recordRecent({
				time: new Date().toISOString(),
				tool: event.toolName,
				summary: description.summary,
				pSafe: verdict.pSafe,
				risk: verdict.risk,
				decision: approved ? `allowed (${via})` : `declined (${via})`,
			});
			if (approved) {
				putCached(key, {
					allow: true,
					pSafe: verdict.pSafe,
					risk: verdict.risk,
					at: Date.now(),
					reason: `approved after Clef verdict (${via})`,
				});
				return;
			}
			const verdictLabel =
				verdict.pSafe === null ? verdict.reason : `${verdict.reason}`;
			const confirmLabel = via;
			const reason = `clef-gate: blocked ${event.toolName} call (${verdictLabel}) — ${confirmLabel}. ${description.summary}`;
			if (ctx.hasUI) ctx.ui.notify(reason, "warning");
			return { block: true, reason, terminate: true };
		} catch (error) {
			// Never let the gate itself crash the turn: ask, or block without UI.
			const { approved } = await askUser(
				ctx,
				`Clef gate: allow ${event.toolName}?`,
				`Gate errored (${error instanceof Error ? error.message : String(error)}); asking instead.\n${description.summary}`,
				event.toolName,
				{
					key: `error:${event.toolName}`,
					label: `${event.toolName} calls when the gate errors`,
				},
			);
			if (approved) return;
			return {
				block: true,
				reason: `clef-gate: blocked ${event.toolName} call (gate error, fail-safe)`,
				terminate: true,
			};
		}
	});

	async function handleGateCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const parts = args.trim().split(/\s+/).filter(Boolean);
		const sub = (parts[0] ?? "").toLowerCase();
		const rest = parts.slice(1).join(" ");
		if (sub === "on" || sub === "ask") {
			gateEnabled = true;
			autoApproveAll = false;
			ctx.ui.notify(
				`clef-gate: on — risky tool calls will be judged by Clef and asked about when unsure${autoApproveScopes.size ? ` (${autoApproveScopes.size} auto-approve scope(s) still active — /clef-gate clear-auto to remove)` : ""}`,
				"info",
			);
			return;
		}
		if (sub === "off") {
			gateEnabled = false;
			ctx.ui.notify("clef-gate: OFF — tool calls will run unjudged this session", "warning");
			return;
		}
		if (sub === "auto" && rest) {
			gateEnabled = true;
			autoApproveScopes.add(`pattern:${rest}`);
			ctx.ui.notify(`clef-gate: auto-approving "${rest}" for this session — /clef-gate clear-auto to undo`, "info");
			return;
		}
		if (sub === "auto") {
			gateEnabled = true;
			autoApproveAll = true;
			ctx.ui.notify("clef-gate: AUTO-APPROVE — anything the gate would ask about now runs without asking this session (still judged + logged) — /clef-gate on to undo", "warning");
			return;
		}
		if (sub === "auto-tool") {
			const tool = rest.toLowerCase();
			if (!["bash", "powershell", "edit", "write"].includes(tool)) {
				ctx.ui.notify("clef-gate: usage — /clef-gate auto-tool bash|powershell|edit|write", "warning");
				return;
			}
			gateEnabled = true;
			autoApproveScopes.add(`ask:${tool}`);
			ctx.ui.notify(`clef-gate: auto-approving ${tool} asks for this session — /clef-gate clear-auto to undo`, "info");
			return;
		}
		if (sub === "clear-auto") {
			autoApproveAll = false;
			autoApproveScopes.clear();
			ctx.ui.notify("clef-gate: auto-approve cleared — gate will ask again", "info");
			return;
		}
		if (sub !== "" && sub !== "status") {
			ctx.ui.notify("clef-gate: usage — /clef-gate [on|off|auto|auto <pattern>|auto-tool <tool>|clear-auto|status]", "warning");
			return;
		}
		const model = ctx.modelRegistry.findOfType(
			"classifier",
			CLEF_PROVIDER,
			CLEF_MODEL_ID,
		);
		const mode = !gateEnabled ? "OFF" : autoApproveAll ? "ON + AUTO-APPROVE ALL" : "ON";
		const lines = [
			`clef-gate: ${mode} · ${model ? "Clef available" : "Clef UNAVAILABLE (gated calls will ask)"} · P(safe)≥${SAFE_THRESHOLD} · cache ${verdictCache.size}${DRY_RUN ? " · DRY RUN" : ""}`,
		];
		if (autoApproveScopes.size > 0) {
			lines.push(`  auto-approve scopes: ${[...autoApproveScopes].join(", ")}`);
		}
		for (const entry of recent.slice(-8)) {
			const score = entry.pSafe === null ? "n/a" : entry.pSafe.toFixed(2);
			lines.push(`  ${entry.tool} P=${score} ${entry.decision} — ${oneLine(entry.summary, 90)}`);
		}
		if (recent.length === 0) lines.push("  (no gated calls yet this session)");
		lines.push("  /clef-gate on|off|auto|auto <pattern>|auto-tool <tool>|clear-auto");
		ctx.ui.notify(lines.join("\n"), "info");
	}

	// Argument picker: shown after `/clef ` (and as you keep typing).
	// `value` replaces the whole argument text, so multi-word values carry
	// the subcommand with them; a trailing space descends a level.
	function gateArgumentCompletions(argumentPrefix: string) {
		const mode = !gateEnabled ? "OFF" : autoApproveAll ? "ON + AUTO-APPROVE ALL" : "ON";
		const secondLevel = argumentPrefix.trimStart().match(/^(\S+)\s+([\s\S]*)$/);
		if (!secondLevel) {
			const typed = argumentPrefix.trimStart().toLowerCase();
			const items = [
				{ value: "status", label: "status", description: `show status (currently ${mode}) + recent gated calls` },
				{ value: "on", label: "on", description: "ask when unsure (cancels auto-approve everything)" },
				{ value: "off", label: "off", description: "disable gate — calls run unjudged + unlogged" },
				{ value: "auto ", label: "auto", description: "auto-approve… everything, or pick a pattern next" },
				{ value: "auto-tool ", label: "auto-tool", description: "auto-approve asks for one tool…" },
				{ value: "clear-auto", label: "clear-auto", description: "remove all auto-approve — back to asking" },
			].filter((item) => item.label.startsWith(typed));
			return items.length > 0 ? items : null;
		}
		const sub = secondLevel[1].toLowerCase();
		const typed = secondLevel[2].toLowerCase();
		if (sub === "auto-tool") {
			const items = ["bash", "powershell", "edit", "write"]
				.filter((tool) => tool.startsWith(typed.trim()))
				.map((tool) => ({
					value: `auto-tool ${tool}`,
					label: tool,
					description: autoApproveScopes.has(`ask:${tool}`)
						? "already auto-approved this session"
						: `auto-approve ${tool} asks this session`,
				}));
			return items.length > 0 ? items : null;
		}
		if (sub === "auto") {
			const patternLabels = [
				...new Set([...DANGEROUS_COMMAND, ...SENSITIVE_PATH].map((p) => p.label)),
			];
			const items = [
				{
					value: "auto",
					label: "everything",
					description: autoApproveAll
						? "already auto-approving everything"
						: "auto-approve everything this session",
				},
				...patternLabels.map((label) => ({
					value: `auto ${label}`,
					label,
					description: autoApproveScopes.has(`pattern:${label}`)
						? "already auto-approved this session"
						: "auto-approve this pattern this session",
				})),
			].filter(
				(item) =>
					item.label.toLowerCase().startsWith(typed) ||
					item.label.toLowerCase().includes(` ${typed}`),
			);
			return items.length > 0 ? items : null;
		}
		return null;
	}

	pi.registerCommand("clef-gate", {
		description: "Clef gate status; /clef-gate on|off|auto|clear-auto (session-only)",
		getArgumentCompletions: gateArgumentCompletions,
		handler: handleGateCommand,
	});
	pi.registerCommand("clef", {
		description: "Alias for /clef-gate (status; /clef on|off|auto)",
		getArgumentCompletions: gateArgumentCompletions,
		handler: handleGateCommand,
	});
}
