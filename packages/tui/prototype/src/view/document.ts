import type { SessionViewModel, ToolCallView } from "../session/view-model.ts";
import { A, checkGlyph, paint, riskColor, toolGlyph, truncate, wrap } from "./theme.ts";

const TOOL_OUTPUT_TAIL = 12;

export function transcriptDocument(view: SessionViewModel, width: number): string[] {
  const lines: string[] = [];
  const inner = Math.max(20, width - 2);

  for (const entry of view.transcript) {
    switch (entry.type) {
      case "task":
        for (const line of wrap(entry.text, inner - 2)) {
          lines.push(`${paint(A.magenta, "›")} ${paint(A.bold, line)}`);
        }
        lines.push("");
        break;

      case "assistant":
        for (const line of wrap(entry.text, inner)) lines.push(line);
        if (entry.streaming) {
          const last = lines.pop() ?? "";
          lines.push(`${last}${paint(A.cyan, "▌")}`);
        }
        lines.push("");
        break;

      case "tool":
        lines.push(...toolLines(entry.call, inner));
        lines.push("");
        break;

      case "approval": {
        const label =
          entry.decision === null
            ? paint(A.yellow, "awaiting decision")
            : entry.decision === "reject"
              ? paint(A.red, "rejected")
              : paint(A.green, entry.decision);
        lines.push(
          `  ${paint(A.gray, "approval")} ${truncate(entry.question, inner - 24)} ${label}`,
        );
        break;
      }

      case "notice":
        lines.push(
          paint(
            entry.tone === "error" ? A.red : entry.tone === "warn" ? A.yellow : A.gray,
            `  ${entry.text}`,
          ),
        );
        lines.push("");
        break;

      case "verification":
        lines.push(paint(A.bold, "verification"));
        for (const row of entry.rows) {
          const note = row.note ? paint(A.gray, `  ${row.note}`) : "";
          lines.push(`  ${checkGlyph(row.status)} ${truncate(row.name, 34)}${note}`);
        }
        lines.push("");
        break;

      case "summary": {
        const s = entry.summary;
        lines.push(paint(A.bold, s.outcome === "completed" ? "done" : "cancelled"));
        for (const line of wrap(s.headline, inner - 2)) lines.push(`  ${line}`);
        if (s.filesChanged.length > 0) {
          lines.push(paint(A.gray, "  files changed"));
          for (const file of s.filesChanged) lines.push(`    ${paint(A.green, file)}`);
        }
        lines.push(
          paint(
            A.gray,
            `  ${s.toolCalls} tool calls · ${s.approvals} approved · ${s.rejections} rejected · ` +
              `${s.checksPassed} passed · ${s.checksFailed} failed · ${(s.elapsedMs / 1000).toFixed(1)}s`,
          ),
        );
        lines.push("");
        break;
      }
    }
  }

  return lines;
}

function toolLines(call: ToolCallView, width: number): string[] {
  const head =
    `${toolGlyph(call.status)} ${paint(A.bold, call.name)} ` +
    `${paint(riskColor(call.risk), call.target)}`;
  const lines = [truncate(head, width)];
  const shown = call.output.slice(-TOOL_OUTPUT_TAIL);
  const hidden = call.output.length - shown.length;
  if (hidden > 0) lines.push(paint(A.gray, `    … ${hidden} earlier lines`));
  for (const line of shown) lines.push(paint(A.gray, `  │ ${truncate(line, width - 4)}`));
  return lines;
}

export function railDocument(view: SessionViewModel, width: number): string[] {
  const lines: string[] = [paint(A.bold, "tool calls")];
  if (view.calls.length === 0) lines.push(paint(A.gray, "  none yet"));
  for (const call of view.calls) {
    lines.push(`  ${toolGlyph(call.status)} ${truncate(`${call.name} ${call.target}`, width - 5)}`);
  }
  lines.push("");
  lines.push(paint(A.bold, "verification"));
  if (view.checks.length === 0) lines.push(paint(A.gray, "  not started"));
  for (const row of view.checks) {
    lines.push(`  ${checkGlyph(row.status)} ${truncate(row.name, width - 5)}`);
    if (row.note) lines.push(paint(A.gray, `    ${truncate(row.note, width - 5)}`));
  }
  lines.push("");
  lines.push(paint(A.bold, "session"));
  lines.push(paint(A.gray, `  phase    ${view.phase}`));
  lines.push(paint(A.gray, `  deltas   ${view.tokens}`));
  return lines;
}

export function approvalPanel(view: SessionViewModel, width: number): string[] {
  const request = view.pendingApproval;
  if (!request) return [];
  const inner = width - 4;
  const lines: string[] = [];
  lines.push(
    `${paint(A.yellow, "⏸ approval")} ${paint(riskColor(request.risk), `[${request.risk}]`)}`,
  );
  for (const line of wrap(request.question, inner)) lines.push(paint(A.bold, line));
  for (const line of request.detail.slice(0, 8)) {
    lines.push(paint(diffColor(line), `  ${truncate(line, inner - 2)}`));
  }
  if (request.detail.length > 8) {
    lines.push(paint(A.gray, `  … ${request.detail.length - 8} more lines`));
  }
  lines.push(
    `${paint(A.green, "[y]")} allow once  ${paint(A.green, "[a]")} allow always  ` +
      `${paint(A.red, "[n]")} reject  ${paint(A.gray, "[esc]")} cancel session`,
  );
  return lines;
}

function diffColor(line: string): string {
  if (line.startsWith("+")) return A.green;
  if (line.startsWith("-")) return A.red;
  if (line.startsWith("@@")) return A.cyan;
  return A.gray;
}

export function statusStrip(view: SessionViewModel): string {
  const passed = view.checks.filter((row) => row.status === "pass").length;
  const failed = view.checks.filter((row) => row.status === "fail").length;
  const verify =
    view.checks.length === 0
      ? paint(A.gray, "verify pending")
      : `verify ${paint(A.green, `${passed}✓`)} ${paint(failed > 0 ? A.red : A.gray, `${failed}✗`)}`;
  return `${phaseBadge(view.phase)} ${paint(A.gray, "·")} ${verify}`;
}

function phaseBadge(phase: string): string {
  const color =
    phase === "cancelled"
      ? A.yellow
      : phase === "settled"
        ? A.green
        : phase === "awaiting-approval"
          ? A.yellow
          : A.cyan;
  return paint(color, phase);
}

export function helpPanel(width: number): string[] {
  const rows: Array<[string, string]> = [
    ["f", "cycle framework (ink → native → pi)"],
    ["1 / 2 / 3", "layout: inline / split / overlay"],
    ["y / a / n", "approve once / always / reject"],
    ["esc", "cancel the running session"],
    ["r", "replay the scripted session"],
    ["↑ ↓ j k", "scroll one line"],
    ["pgup pgdn", "scroll one page"],
    ["g / G", "jump to top / bottom"],
    ["?", "toggle this help"],
    ["q / ctrl-c", "quit and print the report"],
  ];
  const lines = [paint(A.bold, "keys")];
  for (const [key, description] of rows) {
    lines.push(`  ${paint(A.cyan, key.padEnd(11))} ${truncate(description, width - 16)}`);
  }
  return lines;
}
