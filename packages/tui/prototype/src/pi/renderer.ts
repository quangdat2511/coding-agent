import { type Component, ProcessTerminal, ScrollView, TuiAltScreen } from "@earendil-works/pi-tui";
import type { SpikeController, SpikeKey } from "@/controller";
import { approvalPanel, statusStrip, transcriptDocument } from "@/view/document";
import { A, pad, paint } from "@/view/theme";

class TranscriptComponent implements Component {
  constructor(private readonly controller: SpikeController) {}

  render(width: number): string[] {
    this.controller.metrics.frames += 1;
    return transcriptDocument(this.controller.view, width);
  }

  invalidate(): void {}
}

class ChromeComponent implements Component {
  constructor(
    private readonly controller: SpikeController,
    private readonly position: "header" | "footer",
  ) {}

  render(width: number): string[] {
    const { view, config } = this.controller;
    if (this.position === "header") {
      const label = ` coding-agent tui spike  impl=${config.impl}  layout=inline (pi baseline)  ${view.task || "no task"} `;
      return [paint(A.invert, pad(label, width))];
    }
    const panel = approvalPanel(view, width - 2);
    return [
      ...panel.map((line) => pad(` ${line}`, width)),
      pad(
        `${paint(A.magenta, "›")} ${paint(A.gray, "type a follow-up task…")}   ${statusStrip(view)}`,
        width,
      ),
      pad(
        paint(A.gray, " f framework · esc cancel · r replay · ? help · q quit · scroll: pi-owned"),
        width,
      ),
    ];
  }

  invalidate(): void {}
}

export async function runPi(controller: SpikeController): Promise<void> {
  controller.metrics.note("pi-tui 0.85.1 declares engines.node >= 22.19.0; run is on Bun");
  controller.metrics.note("scrolling, resize and mouse are pi-owned, not project code");
  if (controller.config.layout !== "inline") {
    controller.metrics.note(`layout=${controller.config.layout} not built for the pi baseline`);
  }

  const terminal = new ProcessTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true });
  const scroll = new ScrollView(new TranscriptComponent(controller), {
    follow: "end",
    primary: true,
    scrollbar: "auto",
  });

  tui.addChild(new ChromeComponent(controller, "header"));
  tui.addChild(scroll);
  tui.addChild(new ChromeComponent(controller, "footer"));

  return new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      controller.metrics.fullRedraws = tui.fullRedraws;
      controller.stop();
      tui.stop();
      process.stdin.resume();
      resolve();
    };

    tui.addInputListener((data: string) => {
      const key = decode(data);
      if (!key) return;
      const outcome = controller.handleKey(key);
      if (outcome === "quit" || outcome === "switch") finish();
      return undefined;
    });

    tui.start();
    controller.start(() => {
      controller.metrics.beginFrame();
      tui.requestRender();
      controller.metrics.endFrame(false);
    }, finish);
    tui.requestRender();
  });
}

function decode(data: string): SpikeKey | null {
  if (data === "\x03") return { name: "interrupt" };
  if (data === "\x1b") return { name: "escape" };
  if (data.startsWith("\x1b")) return null;
  const char = data[0];
  if (char === undefined || char < " ") return null;
  return { name: "char", value: char };
}
