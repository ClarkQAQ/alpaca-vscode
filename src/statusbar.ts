import * as vscode from "vscode";

let item: vscode.StatusBarItem;

export function init() {
	item = vscode.window.createStatusBarItem(
		vscode.StatusBarAlignment.Right,
		1000,
	);
	update();
	item.show();
}

export function showText(text: string) {
	item.text = "alpaca-vscode | " + text;
	item.show();
}

export function showNoSuggestion(elapsed: number) {
	item.text = `alpaca-vscode | no suggestion | t: ${elapsed} ms`;
	item.show();
}

export function showStats(
	elapsed: number,
	cached?: number,
	ctxUsed?: number,
	ctxMax?: number,
	promptN?: number,
	promptMs?: number,
	predN?: number,
	predMs?: number,
) {
	if (cached !== undefined && predN !== undefined && predMs !== undefined) {
		item.text = `alpaca-vscode | c: ${cached}/${predN}, r: ${ctxUsed}/${ctxMax} | p: ${promptN} (${(promptMs ?? 0).toFixed(2)} ms) | g: ${predN} (${(predMs ?? 0).toFixed(2)} ms) | t: ${elapsed} ms`;
	} else {
		item.text = `alpaca-vscode | no suggestion | t: ${elapsed} ms`;
	}
	item.show();
}

export function showCached(elapsed: number, size: number, max: number) {
	item.text = `alpaca-vscode | C: ${size}/${max} | t: ${elapsed} ms`;
	item.show();
}

export function showThinking() {
	item.text = "alpaca-vscode | thinking...";
	item.show();
}

export function update() {
	if (!item) {
		return;
	}
	const editor = vscode.window.activeTextEditor;
	const lang = editor?.document.languageId;
	const config = vscode.workspace.getConfiguration("alpaca-vscode");
	const enabled = config.get<boolean>("enabled", true);
	const langSettings = config.get<Record<string, boolean>>(
		"language_settings",
		{},
	);
	const langOk = lang ? (langSettings[lang] ?? true) : true;
	if (!enabled) {
		item.text = "$(x) alpaca-vscode";
	} else if (lang && !langOk) {
		item.text = `$(x) alpaca-vscode (${lang})`;
	} else {
		item.text = "$(check) alpaca-vscode";
	}
	item.show();
}

export function registerListeners(ctx: vscode.ExtensionContext) {
	ctx.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration("alpaca-vscode")) {
				update();
			}
		}),
		vscode.window.onDidChangeActiveTextEditor(() => update()),
	);
}
