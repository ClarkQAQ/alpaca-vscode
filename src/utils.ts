import type * as vscode from "vscode";

export function delay(ms: number) {
	return new Promise<void>((r) => setTimeout(r, ms));
}

export function getPrefixLines(
	doc: vscode.TextDocument,
	pos: vscode.Position,
	n: number,
): string[] {
	const start = Math.max(0, pos.line - n);
	return Array.from(
		{ length: pos.line - start },
		(_, i) => doc.lineAt(start + i).text,
	);
}

export function getSuffixLines(
	doc: vscode.TextDocument,
	pos: vscode.Position,
	n: number,
): string[] {
	const end = Math.min(doc.lineCount - 1, pos.line + n);
	return Array.from(
		{ length: end - pos.line },
		(_, i) => doc.lineAt(pos.line + 1 + i).text,
	);
}

export function trimTrailingSlash(s: string): string {
	return s.endsWith("/") ? s.slice(0, -1) : s;
}

export function getLeadingSpaces(s: string): string {
	return s.match(/^[ \t]*/)?.[0] ?? "";
}

export function removeTrailingNewLines(lines: string[]) {
	while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") {
		lines.pop();
	}
}
