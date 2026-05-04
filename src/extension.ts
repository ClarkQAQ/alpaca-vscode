import type * as vscode from "vscode";
import { initCommit } from "./commit";
import { initCompletion } from "./completion";
import * as statusbar from "./statusbar";

export function activate(context: vscode.ExtensionContext) {
	statusbar.init();
	statusbar.registerListeners(context);
	initCompletion(context);
	initCommit(context);
}

export function deactivate() {
	// VS Code disposes all subscriptions automatically
}
