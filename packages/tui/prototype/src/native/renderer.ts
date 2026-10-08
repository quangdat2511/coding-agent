import type { SpikeController } from "../controller.ts";
import { composeScreen } from "../view/screen.ts";
import { NativeTerminal } from "./terminal.ts";

const FRAME_INTERVAL_MS = 16;

export function runNative(controller: SpikeController): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let done = false;

    const draw = (): void => {
      if (done) return;
      const { width, height } = terminal.size;
      controller.metrics.beginFrame();
      const stats = terminal.render(composeScreen(controller, width, height));
      controller.metrics.endFrame(stats.fullRedraw);
      controller.metrics.changedRows += stats.changedRows;
      controller.metrics.candidateRows += stats.totalRows;
    };

    const schedule = (): void => {
      if (done || timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        draw();
      }, FRAME_INTERVAL_MS);
    };

    const finish = (): void => {
      if (done) return;
      done = true;
      if (timer !== null) clearTimeout(timer);
      controller.stop();
      terminal.stop();
      resolve();
    };

    const terminal = new NativeTerminal({
      synchronizedOutput: true,
      onResize: () => {
        controller.metrics.resizes += 1;
        draw();
      },
      onKey: (key) => {
        const outcome = controller.handleKey(key);
        if (outcome === "quit" || outcome === "switch") finish();
      },
    });

    controller.metrics.note("alternate screen entered via CSI ?1049h");
    controller.metrics.note("synchronized output via CSI ?2026h/l");
    terminal.start();
    controller.start(schedule, finish);
    draw();
  });
}
