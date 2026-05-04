import axios from "axios";
import { createHash } from "crypto";
import * as fs from "fs";
import * as https from "https";
import * as vscode from "vscode";
import * as statusbar from "./statusbar";
import * as utils from "./utils";

interface Config {
	endpoint: string;
	model: string;
	apiKey: string;
	sslCert: string;
	nPrefix: number;
	nSuffix: number;
	nPredict: number;
	tMaxPrompt: number;
	tMaxPredict: number;
	auto: boolean;
	debounceMs: number;
	maxLineSuffix: number;
	maxCacheKeys: number;
	maxParallel: number;
	ringNChunks: number;
	ringChunkSize: number;
	ringScope: number;
	ringUpdateMs: number;
	showInfo: boolean;
	enabled: boolean;
	langSettings: Record<string, boolean>;
}

let cfg: Config;

function readCfg(): Config {
	const c = vscode.workspace.getConfiguration("alpaca-vscode");
	return {
		endpoint: utils.trimTrailingSlash(
			String(c.get<string>("completion_endpoint", "")),
		),
		model: String(c.get<string>("completion_model", "")),
		apiKey: String(c.get<string>("completion_api_key", "")),
		sslCert: String(c.get<string>("self_signed_certificate", "")),
		nPrefix: Number(c.get<number>("n_prefix", 256)),
		nSuffix: Number(c.get<number>("n_suffix", 64)),
		nPredict: Number(c.get<number>("n_predict", 128)),
		tMaxPrompt: Number(c.get<number>("t_max_prompt_ms", 500)),
		tMaxPredict: Number(c.get<number>("t_max_predict_ms", 2500)),
		auto: Boolean(c.get<boolean>("auto", true)),
		debounceMs: Number(c.get<number>("debounce_ms", 0)),
		maxLineSuffix: Number(c.get<number>("max_line_suffix", 8)),
		maxCacheKeys: Number(c.get<number>("max_cache_keys", 250)),
		maxParallel: Number(c.get<number>("max_parallel_completions", 1)),
		ringNChunks: Number(c.get<number>("ring_n_chunks", 16)),
		ringChunkSize: Number(c.get<number>("ring_chunk_size", 64)),
		ringScope: Number(c.get<number>("ring_scope", 1024)),
		ringUpdateMs: Number(c.get<number>("ring_update_ms", 1000)),
		showInfo: Boolean(c.get<boolean>("show_info", true)),
		enabled: Boolean(c.get<boolean>("enabled", true)),
		langSettings: c.get<Record<string, boolean>>("language_settings", {}),
	};
}

// LRU cache
const lru = new Map<string, string[]>();
let lruMax = 250;

// Ring buffer
interface Chunk {
	text: string;
	time: number;
	filename: string;
}
const chunks: Chunk[] = [];
const chunksLines: string[][] = [];
const queuedChunks: Chunk[] = [];
const queuedChunksLines: string[][] = [];
let lastComplStart = Date.now();
let lastLinePick = -9999;

// Request state
let inFlight = false;
let forcedNew = false;
interface LastCompl {
	completions: string[];
	index: number;
	position: vscode.Position;
	inputPrefix: string;
	inputSuffix: string;
	prompt: string;
}
let lastCompl: LastCompl | null = null;

// Timers
let ringTimer: ReturnType<typeof setInterval> | undefined;

// Axios config
function reqConfig(): Record<string, unknown> {
	const h: Record<string, string> = { "Content-Type": "application/json" };
	if (cfg.apiKey) {
		h["Authorization"] = `Bearer ${cfg.apiKey}`;
	}
	const r: Record<string, unknown> = { headers: h };
	if (cfg.sslCert && fs.existsSync(cfg.sslCert)) {
		r["httpsAgent"] = new https.Agent({ ca: fs.readFileSync(cfg.sslCert) });
	}
	return r;
}

function hash(s: string): string {
	return createHash("sha256").update(s).digest("hex");
}

function cacheGet(key: string): string[] | undefined {
	if (!lru.has(key)) {
		return undefined;
	}
	const v = lru.get(key)!;
	lru.delete(key);
	lru.set(key, v);
	return v;
}

function cachePut(key: string, val: string[]) {
	if (lru.has(key)) {
		lru.delete(key);
	}
	lru.set(key, val);
	if (lru.size > lruMax) {
		lru.delete(lru.keys().next().value!);
	}
}

/** Try to find a cached completion whose prefix matches the prompt. */
function lookupCache(
	inputPrefix: string,
	inputSuffix: string,
	prompt: string,
): string[] | undefined {
	const key = hash(`${inputPrefix}|${inputSuffix}|${prompt}`);
	const hit = cacheGet(key);
	if (hit) {
		return hit;
	}
	for (let i = prompt.length; i >= 0; i--) {
		const sub = prompt.slice(0, i);
		const cut = prompt.slice(i);
		const k = hash(`${inputPrefix}|${inputSuffix}|${sub}`);
		const r = cacheGet(k);
		if (!r) {
			continue;
		}
		const out: string[] = [];
		for (const c of r) {
			if (c && cut === c.slice(0, cut.length)) {
				out.push(c.slice(prompt.length - sub.length));
			}
		}
		if (out.length) {
			return out;
		}
	}
	return undefined;
}

export interface Response {
	content?: string;
	generation_settings?: any;
	tokens_cached?: number;
	timings?: {
		prompt_n?: number;
		prompt_ms?: number;
		prompt_per_second?: number;
		predicted_n?: number;
		predicted_ms?: number;
		predicted_per_second?: number;
	};
}

async function getFIM(
	prefix: string,
	suffix: string,
	prompt: string,
	extra: Chunk[],
	nindent?: number,
): Promise<string[] | undefined> {
	if (!cfg.endpoint) {
		return undefined;
	}
	const body: Record<string, unknown> = {
		id_slot: 0,
		input_prefix: prefix,
		input_suffix: suffix,
		input_extra: extra,
		prompt,
		n_predict: cfg.nPredict,
		n_cmpl: cfg.maxParallel,
		...(cfg.model ? { model: cfg.model } : {}),
		top_k: 40,
		top_p: 0.99,
		stream: false,
		samplers: ["top_k", "top_p", "infill"],
		cache_prompt: true,
		...(nindent ? { n_indent: nindent } : {}),
		t_max_prompt_ms: cfg.tMaxPrompt,
		t_max_predict_ms: cfg.tMaxPredict,
	};
	const res = await axios.post<Response>(`${cfg.endpoint}/infill`, body, {
		...reqConfig(),
		timeout: cfg.tMaxPrompt + cfg.tMaxPredict + 10000,
	});
	if (res.status !== 200) {
		return undefined;
	}
	const d = res.data;
	if (!d) {
		return undefined;
	}
	if ("content" in d) {
		const text = d.content ?? "";
		return text ? [text] : undefined;
	}
	if (Array.isArray(d)) {
		const out = [
			...new Set(d.map((r: any) => r?.content ?? "").filter(Boolean)),
		];
		return out.length ? out : undefined;
	}
	return undefined;
}

function shouldDiscard(
	lines: string[],
	doc: vscode.TextDocument,
	pos: vscode.Position,
	linePrefix: string,
	lineSuffix: string,
): boolean {
	if (lines.length === 0) {
		return true;
	}
	if (lines.length === 1 && lines[0].trim() === "") {
		return true;
	}
	if (pos.line === doc.lineCount - 1) {
		return false;
	}
	if (
		lines.length > 1 &&
		(lines[0].trim() === "" || lines[0].trim() === lineSuffix.trim()) &&
		lines.slice(1).every((v, i) => v === doc.lineAt(pos.line + 1 + i).text)
	) {
		return true;
	}
	if (lines.length === 1 && lines[0] === lineSuffix) {
		return true;
	}
	let nl = pos.line + 1;
	while (nl < doc.lineCount && doc.lineAt(nl).text.trim() === "") {
		nl++;
	}
	if (nl >= doc.lineCount) {
		return false;
	}
	if (linePrefix + lines[0] === doc.lineAt(nl).text) {
		if (lines.length === 1) {
			return true;
		}
		if (
			lines.length === 2 &&
			lines[1] === doc.lineAt(nl + 1).text.slice(0, lines[1].length)
		) {
			return true;
		}
		if (
			lines.length > 2 &&
			lines.slice(1).every((v, i) => v === doc.lineAt(nl + 1 + i).text)
		) {
			return true;
		}
	}
	return false;
}

function fixSuggestion(lines: string[], lineSuffix: string): string {
	if (lineSuffix.trim() !== "") {
		if (lines[0].endsWith(lineSuffix)) {
			return lines[0].slice(0, -lineSuffix.length);
		}
		if (lines.length > 1) {
			return lines[0];
		}
	}
	return lines.join("\n");
}

async function prefetch(
	prefix: string,
	suffix: string,
	prompt: string,
	lines: string[],
) {
	const futurePrompt = prompt + lines[0];
	let futurePrefix = prefix;
	if (lines.length > 1) {
		futurePrefix = `${prefix + prompt + lines.slice(0, -1).join("\n")}\n`;
		const pLines = futurePrefix.slice(0, -1).split(/\r?\n/);
		if (pLines.length > cfg.nPrefix) {
			futurePrefix = `${pLines.slice(pLines.length - cfg.nPrefix).join("\n")}\n`;
		}
	}
	const k = hash(`${futurePrefix}|${suffix}|${futurePrompt}`);
	if (cacheGet(k)) {
		return;
	}
	const data = await getFIM(futurePrefix, suffix, futurePrompt, chunks);
	if (data) {
		cachePut(k, data);
	}
}

async function prefetchAcceptLine(
	prefix: string,
	suffix: string,
	prompt: string,
	lines: string[],
) {
	if (lines.length <= 1) {
		return;
	}
	const k = hash(`${prefix + prompt + lines[0]}\n|${suffix}|`);
	if (cacheGet(k)) {
		return;
	}
	cachePut(k, [lines.slice(1).join("\n")]);
}

function jaccard(a: string[], b: string[]): number {
	if (a.length === 0 && b.length === 0) {
		return 1;
	}
	const sa = new Set(a),
		sb = new Set(b);
	const inter = new Set([...sa].filter((x) => sb.has(x)));
	const union = new Set([...sa, ...sb]);
	return inter.size / union.size;
}

function pickChunk(
	lines: string[],
	noMod: boolean,
	doEvict: boolean,
	doc: vscode.TextDocument,
) {
	if (noMod && doc.isDirty) {
		return;
	}
	if (cfg.ringNChunks <= 0) {
		return;
	}
	if (lines.length < 3) {
		return;
	}
	let cLines: string[];
	if (lines.length + 1 < cfg.ringChunkSize) {
		cLines = lines;
	} else {
		const start = Math.floor(
			Math.random() * Math.max(0, lines.length - cfg.ringChunkSize / 2 + 1),
		);
		cLines = lines.slice(start, start + cfg.ringChunkSize / 2);
	}
	const text = `${cLines.join("\n")}\n`;
	if (
		doEvict &&
		(chunks.some((c) => c.text === text) ||
			queuedChunks.some((c) => c.text === text))
	) {
		return;
	}
	if (doEvict) {
		for (let i = chunks.length - 1; i >= 0; i--) {
			if (jaccard(chunksLines[i], cLines) > 0.9) {
				chunks.splice(i, 1);
				chunksLines.splice(i, 1);
			}
		}
		for (let i = queuedChunksLines.length - 1; i >= 0; i--) {
			if (jaccard(queuedChunksLines[i], cLines) > 0.9) {
				queuedChunks.splice(i, 1);
				queuedChunksLines.splice(i, 1);
			}
		}
	}
	if (queuedChunks.length >= 16) {
		queuedChunks.splice(0, 1);
	}
	queuedChunks.push({ text, time: Date.now(), filename: doc.fileName });
	queuedChunksLines.push(cLines);
}

function pickChunkAroundCursor(line: number, doc: vscode.TextDocument) {
	const r = cfg.ringChunkSize / 2;
	const l = Math.max(0, line - r);
	const e = Math.min(line + r, doc.lineCount - 1);
	const lines = Array.from(
		{ length: e - l + 1 },
		(_, i) => doc.lineAt(l + i).text,
	);
	pickChunk(lines, true, true, doc);
}

function afterCompletion(pos: vscode.Position, doc: vscode.TextDocument) {
	const delta = Math.abs(pos.line - lastLinePick);
	if (delta > 32) {
		const prefixLines = Array.from(
			{
				length:
					Math.max(0, pos.line - cfg.nPrefix) -
					Math.max(0, pos.line - cfg.ringScope),
			},
			(_, i) => doc.lineAt(Math.max(0, pos.line - cfg.ringScope) + i).text,
		);
		pickChunk(prefixLines, false, false, doc);
		const sl = Math.min(doc.lineCount - 1, pos.line + cfg.nSuffix);
		const el = Math.min(
			doc.lineCount - 1,
			pos.line + cfg.nSuffix + cfg.ringChunkSize,
		);
		const suffixLines = Array.from(
			{ length: el - sl + 1 },
			(_, i) => doc.lineAt(sl + i).text,
		);
		pickChunk(suffixLines, false, false, doc);
		lastLinePick = pos.line;
	}
}

function onDocumentSave(doc: vscode.TextDocument) {
	setTimeout(() => {
		if (!cfg.enabled) {
			return;
		}
		const ed = vscode.window.activeTextEditor;
		if (ed && ed.document === doc) {
			pickChunkAroundCursor(ed.selection.active.line, doc);
		} else {
			pickChunk(doc.getText().split(/\r?\n/), true, true, doc);
		}
	}, 1000);
}

function addChunkFromSelection(editor: vscode.TextEditor) {
	const sel = editor.selection;
	const lines = editor.document.getText(sel).split(/\r?\n/);
	setTimeout(() => pickChunk(lines, false, true, editor.document), 1000);
}

function ringBufferTick() {
	const ed = vscode.window.activeTextEditor;
	if (!ed?.document) {
		return;
	}
	if (!cfg.enabled) {
		return;
	}
	if (queuedChunks.length === 0) {
		return;
	}
	if (Date.now() - lastComplStart < 3000) {
		return;
	}
	const cl = queuedChunksLines.shift()!;
	chunksLines.push(cl);
	chunks.push(queuedChunks.shift()!);
	while (chunks.length > cfg.ringNChunks) {
		chunks.shift();
		chunksLines.shift();
	}
	// Warm the FIM server cache
	if (cfg.endpoint) {
		axios
			.post(
				`${cfg.endpoint}/infill`,
				{
					id_slot: 0,
					input_prefix: "",
					input_suffix: "",
					input_extra: chunks.map((c) => c.text),
					prompt: "",
					n_predict: 0,
					samplers: [],
					cache_prompt: true,
					t_max_prompt_ms: cfg.tMaxPrompt,
					t_max_predict_ms: 1,
				},
				reqConfig(),
			)
			.catch(() => {});
	}
}

async function provideInlineCompletionItems(
	document: vscode.TextDocument,
	position: vscode.Position,
	ctx: vscode.InlineCompletionContext,
	token: vscode.CancellationToken,
): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList | null> {
	if (
		!cfg.auto &&
		ctx.triggerKind === vscode.InlineCompletionTriggerKind.Automatic
	) {
		return null;
	}
	if (
		cfg.debounceMs > 0 &&
		ctx.triggerKind === vscode.InlineCompletionTriggerKind.Automatic
	) {
		await utils.delay(cfg.debounceMs);
		if (token.isCancellationRequested) {
			return null;
		}
	}
	while (inFlight) {
		await utils.delay(150);
		if (token.isCancellationRequested) {
			return null;
		}
	}
	inFlight = true;

	const prefixLines = utils.getPrefixLines(document, position, cfg.nPrefix);
	const suffixLines = utils.getSuffixLines(document, position, cfg.nSuffix);
	const lineText = document.lineAt(position.line).text;
	const cursorChar = position.character;
	const linePrefix = lineText.slice(0, cursorChar);
	const lineSuffix = lineText.slice(cursorChar);
	const nindent = lineText.length - lineText.trimStart().length;

	if (
		ctx.triggerKind === vscode.InlineCompletionTriggerKind.Automatic &&
		lineSuffix.length > cfg.maxLineSuffix
	) {
		inFlight = false;
		return null;
	}

	let prompt = linePrefix;
	let spacesToRemove = 0;
	if (/^[ \t]*$/.test(prompt)) {
		prompt = "";
		spacesToRemove = linePrefix.length;
	}
	const inputPrefix = `${prefixLines.join("\n")}\n`;
	const inputSuffix = `${lineSuffix}\n${suffixLines.join("\n")}\n`;

	try {
		let completions: string[] | undefined;
		let cached = false;
		const ck = hash(`${inputPrefix}|${inputSuffix}|${prompt}`);
		if (!forcedNew) {
			completions = lookupCache(inputPrefix, inputSuffix, prompt);
		}
		cached = completions !== undefined;
		if (!cached) {
			forcedNew = false;
			if (token.isCancellationRequested) {
				inFlight = false;
				return null;
			}
			statusbar.showThinking();
			const data = await getFIM(
				inputPrefix,
				inputSuffix,
				prompt,
				chunks,
				nindent,
			);
			completions = data;
		}
		if (!completions || completions.length === 0) {
			inFlight = false;
			statusbar.showNoSuggestion(Date.now() - lastComplStart);
			return [];
		}

		const filtered: string[] = [];
		let firstLines: string[] = [];
		for (const raw of completions) {
			const sl = raw.split(/\r?\n/);
			utils.removeTrailingNewLines(sl);
			if (shouldDiscard(sl, document, position, linePrefix, lineSuffix)) {
				continue;
			}
			const fixed = fixSuggestion(sl, lineSuffix);
			filtered.push(fixed);
			if (firstLines.length === 0) {
				firstLines = sl;
			}
		}
		if (filtered.length === 0) {
			inFlight = false;
			return [];
		}

		if (!cached) {
			cachePut(ck, filtered);
		}
		lastCompl = {
			completions: filtered,
			index: 0,
			position,
			inputPrefix,
			inputSuffix,
			prompt,
		};

		// Background: status, prefetch, context
		setTimeout(async () => {
			if (!token.isCancellationRequested) {
				statusbar.showStats(
					Date.now() - lastComplStart,
					undefined,
					chunks.length,
					cfg.ringNChunks,
				);
				if (lineSuffix.trim() === "") {
					await prefetch(inputPrefix, inputSuffix, prompt, firstLines);
					await prefetchAcceptLine(
						inputPrefix,
						inputSuffix,
						prompt,
						firstLines,
					);
				}
				afterCompletion(position, document);
			}
		}, 0);

		lastComplStart = Date.now();
		inFlight = false;
		return filtered.map((c) => {
			// remove up to spacesToRemove leading whitespace chars
			let text = c;
			if (spacesToRemove > 0) {
				let i = 0;
				while (
					i < text.length &&
					i < spacesToRemove &&
					(text[i] === " " || text[i] === "\t")
				) {
					i++;
				}
				text = text.slice(i);
			}
			return new vscode.InlineCompletionItem(
				text,
				new vscode.Range(position, position),
			);
		});
	} catch (err) {
		inFlight = false;
		statusbar.showNoSuggestion(Date.now() - lastComplStart);
		const msg = err instanceof Error ? err.message : String(err);
		vscode.window.showErrorMessage(`FIM error: ${msg}`);
		return [];
	}
}

function registerCommands(ctx: vscode.ExtensionContext) {
	ctx.subscriptions.push(
		vscode.commands.registerCommand(
			"extension.triggerInlineCompletion",
			async () => {
				if (!vscode.window.activeTextEditor) {
					return;
				}
				await vscode.commands.executeCommand(
					"editor.action.inlineSuggest.trigger",
				);
			},
		),
	);

	ctx.subscriptions.push(
		vscode.commands.registerCommand(
			"extension.triggerNoCacheCompletion",
			async () => {
				const ed = vscode.window.activeTextEditor;
				if (!ed) {
					return;
				}
				await vscode.commands.executeCommand(
					"editor.action.inlineSuggest.hide",
				);
				await utils.delay(50);
				forcedNew = true;
				await vscode.commands.executeCommand(
					"editor.action.inlineSuggest.trigger",
				);
			},
		),
	);

	ctx.subscriptions.push(
		vscode.commands.registerCommand("extension.acceptFirstLine", async () => {
			const ed = vscode.window.activeTextEditor;
			if (!ed || !lastCompl) {
				return;
			}
			const lines = lastCompl.completions[lastCompl.index].split("\n");
			const text =
				lines[0]?.trim() === "" && lines.length > 1
					? `\n${lines[1]}`
					: (lines[0] ?? "");
			await ed.edit((b) => b.insert(ed.selection.active, text));
		}),
	);

	ctx.subscriptions.push(
		vscode.commands.registerCommand("extension.acceptFirstWord", async () => {
			const ed = vscode.window.activeTextEditor;
			if (!ed || !lastCompl) {
				return;
			}
			const lines = lastCompl.completions[lastCompl.index].split(/\r?\n/);
			const first = lines[0] ?? "";
			const prefix = utils.getLeadingSpaces(first);
			const word = prefix + first.trimStart().split(" ")[0];
			if (word === "" && lines.length > 1) {
				const second = lines[1];
				const p2 = utils.getLeadingSpaces(second);
				await ed.edit((b) =>
					b.insert(
						ed.selection.active,
						`\n${p2}${second.trimStart().split(" ")[0]}`,
					),
				);
			} else {
				await ed.edit((b) => b.insert(ed.selection.active, word));
			}
		}),
	);

	ctx.subscriptions.push(
		vscode.commands.registerCommand(
			"extension.selectNextSuggestion",
			async () => {
				const ed = vscode.window.activeTextEditor;
				if (!ed) {
					return;
				}
				await vscode.commands.executeCommand(
					"editor.action.inlineSuggest.showNext",
				);
				if (lastCompl) {
					lastCompl.index =
						(lastCompl.index + 1) % lastCompl.completions.length;
				}
			},
		),
	);
	ctx.subscriptions.push(
		vscode.commands.registerCommand(
			"extension.selectPreviousSuggestion",
			async () => {
				const ed = vscode.window.activeTextEditor;
				if (!ed) {
					return;
				}
				await vscode.commands.executeCommand(
					"editor.action.inlineSuggest.showPrevious",
				);
				if (lastCompl && lastCompl.completions.length > 0) {
					lastCompl.index =
						(lastCompl.index - 1 + lastCompl.completions.length) %
						lastCompl.completions.length;
				}
			},
		),
	);

	ctx.subscriptions.push(
		vscode.commands.registerCommand("extension.copyChunks", async () => {
			const text = chunks
				.map((c) => `Time: ${c.time}\nFile: ${c.filename}\nText:\n${c.text}\n`)
				.join("\n");
			await vscode.env.clipboard.writeText(`Extra context:\n${text}`);
		}),
	);

	ctx.subscriptions.push(
		vscode.commands.registerCommand("extension.copyIntercept", async () => {
			const ed = vscode.window.activeTextEditor;
			if (ed && cfg.enabled) {
				addChunkFromSelection(ed);
			}
			await vscode.commands.executeCommand("editor.action.clipboardCopyAction");
		}),
	);
	ctx.subscriptions.push(
		vscode.commands.registerCommand("extension.cutIntercept", async () => {
			const ed = vscode.window.activeTextEditor;
			if (ed && cfg.enabled) {
				addChunkFromSelection(ed);
			}
			await vscode.commands.executeCommand("editor.action.clipboardCutAction");
		}),
	);
}

export function initCompletion(ctx: vscode.ExtensionContext) {
	cfg = readCfg();
	lruMax = cfg.maxCacheKeys;

	ctx.subscriptions.push(
		vscode.languages.registerInlineCompletionItemProvider(
			{ pattern: "**" },
			{ provideInlineCompletionItems },
		),
	);

	registerCommands(ctx);

	ctx.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration("alpaca-vscode")) {
				cfg = readCfg();
				lruMax = cfg.maxCacheKeys;
			}
		}),
		vscode.workspace.onDidSaveTextDocument(onDocumentSave),
		vscode.window.onDidChangeActiveTextEditor((ed) => {
			if (ed?.document && cfg.enabled) {
				setTimeout(
					() => pickChunkAroundCursor(ed.selection.active.line, ed.document),
					0,
				);
			}
		}),
	);

	ringTimer = setInterval(ringBufferTick, cfg.ringUpdateMs);
	ctx.subscriptions.push({
		dispose: () => {
			if (ringTimer) {
				clearInterval(ringTimer);
			}
		},
	});
}
