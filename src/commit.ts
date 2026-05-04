import axios from "axios";
import * as fs from "fs";
import * as https from "https";
import * as vscode from "vscode";
import * as utils from "./utils";

interface Config {
	endpoint: string;
	model: string;
	apiKey: string;
	apiVersion: string;
	sslCert: string;
}

let cfg: Config;

function readCfg(): Config {
	const c = vscode.workspace.getConfiguration("alpaca-vscode");
	return {
		endpoint: utils.trimTrailingSlash(
			String(c.get<string>("commit_endpoint", "")),
		),
		model: String(c.get<string>("commit_model", "")),
		apiKey: String(c.get<string>("commit_api_key", "")),
		apiVersion: String(c.get<string>("commit_api_version", "v1")),
		sslCert: String(c.get<string>("self_signed_certificate", "")),
	};
}

function reqConfig() {
	const h: Record<string, string> = { "Content-Type": "application/json" };
	if (cfg.apiKey) {
		h.Authorization = `Bearer ${cfg.apiKey}`;
	}
	const r: Record<string, unknown> = { headers: h };
	if (cfg.sslCert && fs.existsSync(cfg.sslCert)) {
		r.httpsAgent = new https.Agent({ ca: fs.readFileSync(cfg.sslCert) });
	}
	return r;
}

const PROMPT_TEMPLATE = `Please generate a readable and concise git commit message based on the file changes.

Requirements:
1. **Type** (feat, fix, docs, style, refactor, perf, test, chore)
2. **Short description** (no more than 50 characters)
3. **Detailed description** (optional, up to 72 characters)
4. **Output format** must follow the below format:

[Type]: [Short description]
[Detailed description]

**Example OUTPUT:**
feat: add user authentication feature

- Implemented JWT-based authentication
- Added login and registration endpoints

**INPUT:**

{diff}

**OUTPUT:**:`;

export interface ChatResponse {
	choices: [{ message: { content?: string } }];
}

async function generate() {
	const endpoint = cfg.endpoint;
	if (!endpoint) {
		vscode.window.showErrorMessage(
			"Set alpaca-vscode commit_endpoint in settings.",
		);
		return;
	}

	const gitExt = vscode.extensions.getExtension("vscode.git")?.exports;
	const git = gitExt?.getAPI(1);
	if (!git) {
		vscode.window.showErrorMessage("vscode.git not found");
		return;
	}
	if (git.repositories.length === 0) {
		vscode.window.showErrorMessage("not a git repository");
		return;
	}

	const repo = git.repositories[0];
	try {
		let diff = await repo.diff(true);
		if (!diff?.trim()) {
			diff = await repo.diff(false);
			if (!diff?.trim()) {
				vscode.window.showWarningMessage("git diff is empty");
				return;
			}
			vscode.window.showWarningMessage("staged diff empty, using unstaged");
		}

		const prompt = PROMPT_TEMPLATE.replace("{diff}", diff);
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.SourceControl,
				title: "alpaca-vscode generating commit message...",
			},
			async () => {
				try {
					const res = await axios.post<ChatResponse>(
						`${endpoint}/${cfg.apiVersion}/chat/completions`,
						{
							messages: [
								{ role: "system", content: "You are an expert coder." },
								{ role: "user", content: prompt },
							],
							stream: false,
							temperature: 0.8,
							top_p: 0.95,
							...(cfg.model ? { model: cfg.model } : {}),
						},
						reqConfig(),
					);
					const msg = res.data?.choices?.[0]?.message?.content;
					if (msg) {
						repo.inputBox.value = msg;
					} else {
						vscode.window.showErrorMessage("commit message is empty");
					}
				} catch (err: any) {
					const details = err?.response?.data
						? JSON.stringify(err.response.data, null, 2).slice(0, 1000)
						: err?.message || String(err);
					vscode.window.showErrorMessage(
						`Commit API error (${err?.response?.status ?? 400}): ${details}`,
					);
				}
			},
		);
	} catch (err) {
		vscode.window.showErrorMessage(
			`commit error: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

export function initCommit(ctx: vscode.ExtensionContext) {
	cfg = readCfg();
	ctx.subscriptions.push(
		vscode.commands.registerCommand(
			"extension.generateGitCommitMessage",
			generate,
		),
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration("alpaca-vscode")) {
				cfg = readCfg();
			}
		}),
	);
}
