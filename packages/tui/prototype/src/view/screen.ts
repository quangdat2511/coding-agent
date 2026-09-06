import type { SpikeController } from "@/controller";
import {
  approvalPanel,
  helpPanel,
  railDocument,
  statusStrip,
  transcriptDocument,
} from "@/view/document";
import { A, ansiPrefix, pad, paint, truncate, visibleWidth } from "@/view/theme";

const HEADER_HEIGHT = 1;
const FOOTER_HEIGHT = 2;

export function composeScreen(
  controller: SpikeController,
  width: number,
  height: number,
): string[] {
  const { view, config } = controller;
  const layout = config.layout;
  const railWidth = layout === "split" ? Math.min(34, Math.max(24, Math.floor(width * 0.3))) : 0;
  const transcriptWidth = layout === "split" ? Math.max(20, width - railWidth - 1) : width;

  const panel = approvalPanel(view, transcriptWidth);
  const inlinePanelHeight = layout === "overlay" ? 0 : panel.length;
  const bodyHeight = Math.max(1, height - HEADER_HEIGHT - FOOTER_HEIGHT - inlinePanelHeight);

  const document = transcriptDocument(view, transcriptWidth);
  controller.setViewport(document.length, bodyHeight);

  const slice = document.slice(controller.scrollTop, controller.scrollTop + bodyHeight);
  while (slice.length < bodyHeight) slice.push("");

  const body =
    layout === "split"
      ? splitBody(slice, railDocument(view, railWidth), transcriptWidth, railWidth)
      : slice;

  const screen = [
    header(controller, width),
    ...body.map((line) => pad(line, width)),
    ...panelRows(panel, width, inlinePanelHeight),
    ...footer(controller, width),
  ];

  const composited =
    layout === "overlay" && panel.length > 0 ? overlay(screen, panel, width, "approval") : screen;
  const withHelp = controller.showHelp
    ? overlay(composited, helpPanel(Math.min(60, width - 8)), width, "help")
    : composited;

  return withHelp.slice(0, height);
}

function header(controller: SpikeController, width: number): string {
  const { config, view } = controller;
  const left = ` coding-agent tui spike  impl=${config.impl}  layout=${config.layout} `;
  const right = ` ${truncate(view.task || "no task", Math.max(10, width - visibleWidth(left) - 2))} `;
  return paint(A.invert, pad(left + right, width));
}

function panelRows(panel: string[], width: number, height: number): string[] {
  if (height === 0) return [];
  const border = paint(A.yellow, "─".repeat(width));
  return [border, ...panel.slice(1).map((line) => pad(` ${line}`, width))].slice(0, height);
}

function splitBody(
  transcript: string[],
  rail: string[],
  transcriptWidth: number,
  railWidth: number,
): string[] {
  return transcript.map((line, index) => {
    const railLine = rail[index] ?? "";
    return `${pad(line, transcriptWidth)}${paint(A.gray, "│")}${pad(railLine, railWidth)}`;
  });
}

function footer(controller: SpikeController, width: number): string[] {
  const { view, follow, scrollTop, contentHeight, viewportHeight } = controller;
  const prompt = view.pendingApproval
    ? paint(A.yellow, "  decision required → y / a / n")
    : `${paint(A.magenta, "›")} ${paint(A.gray, "type a follow-up task…")}`;
  const position = follow
    ? paint(A.gray, "follow")
    : paint(A.yellow, `${scrollTop}/${Math.max(0, contentHeight - viewportHeight)}`);
  const status = `${statusStrip(view)} ${paint(A.gray, "·")} ${position}`;
  const gap = Math.max(1, width - visibleWidth(prompt) - visibleWidth(status) - 1);
  const hints = paint(
    A.gray,
    " f framework · 1/2/3 layout · esc cancel · r replay · ? help · q quit",
  );
  return [pad(`${prompt}${" ".repeat(gap)}${status}`, width), pad(hints, width)];
}

function overlay(screen: string[], content: string[], width: number, title: string): string[] {
  const boxWidth = Math.min(width - 4, Math.max(40, maxWidth(content) + 4));
  const boxHeight = content.length + 2;
  const top = Math.max(1, Math.floor((screen.length - boxHeight) / 2));
  const left = Math.max(0, Math.floor((width - boxWidth) / 2));

  const label = ` ${title} `;
  const box = [
    paint(A.yellow, `┌${label}${"─".repeat(Math.max(0, boxWidth - 2 - label.length))}┐`),
    ...content.map(
      (line) => paint(A.yellow, "│") + pad(` ${line}`, boxWidth - 2) + paint(A.yellow, "│"),
    ),
    paint(A.yellow, `└${"─".repeat(boxWidth - 2)}┘`),
  ];

  const output = [...screen];
  for (let i = 0; i < box.length; i += 1) {
    const row = top + i;
    const base = output[row];
    if (base === undefined) break;
    output[row] = spliceLine(base, box[i] as string, left, boxWidth, width);
  }
  return output;
}

function spliceLine(
  base: string,
  insert: string,
  left: number,
  boxWidth: number,
  width: number,
): string {
  const plain = pad(base, width);
  const before = sliceColumns(plain, 0, left);
  const after = sliceColumns(plain, left + boxWidth, width);
  return `${before}${A.reset}${insert}${A.reset}${after}`;
}

function sliceColumns(text: string, start: number, end: number): string {
  let out = "";
  let column = 0;
  let index = 0;
  while (index < text.length && column < end) {
    const sequence = ansiPrefix(text.slice(index));
    if (sequence) {
      if (column >= start) out += sequence;
      index += sequence.length;
      continue;
    }
    if (column >= start) out += text[index];
    index += 1;
    column += 1;
  }
  return out;
}

function maxWidth(lines: string[]): number {
  return lines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
}
