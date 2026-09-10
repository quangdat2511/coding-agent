import { Box, render, Text, useApp, useInput, useStdout } from "ink";
import { useEffect, useRef, useState } from "react";
import type { SpikeController, SpikeKey } from "@/controller";
import {
  approvalPanel,
  helpPanel,
  railDocument,
  statusStrip,
  transcriptDocument,
} from "@/view/document";
import { A, paint, truncate } from "@/view/theme";

const FRAME_INTERVAL_MS = 16;

interface AppProps {
  controller: SpikeController;
  finish: () => void;
}

function ScrollViewport({ lines, top, height }: { lines: string[]; top: number; height: number }) {
  const window: string[] = [];
  for (let row = 0; row < height; row += 1) {
    window.push(lines[top + row] ?? "");
  }
  return (
    <Box flexDirection="column" height={height} flexShrink={0}>
      {window.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed-size window, index is the row identity
        <Text key={index} wrap="truncate">
          {line}
        </Text>
      ))}
    </Box>
  );
}

function Header({ controller, width }: { controller: SpikeController; width: number }) {
  const { config, view } = controller;
  const label = ` coding-agent tui spike  impl=${config.impl}  layout=${config.layout}  ${view.task || "no task"} `;
  return (
    <Box flexShrink={0}>
      <Text inverse wrap="truncate">
        {label.padEnd(width, " ")}
      </Text>
    </Box>
  );
}

function Footer({ controller, width }: { controller: SpikeController; width: number }) {
  const { view, follow, scrollTop, contentHeight, viewportHeight } = controller;
  const position = follow
    ? "follow"
    : `${scrollTop}/${Math.max(0, contentHeight - viewportHeight)}`;
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Box justifyContent="space-between" width={width}>
        <Text wrap="truncate">
          {view.pendingApproval
            ? paint(A.yellow, "  decision required → y / a / n")
            : `${paint(A.magenta, "›")} ${paint(A.gray, "type a follow-up task…")}`}
        </Text>
        <Text wrap="truncate">{`${statusStrip(view)} ${paint(A.gray, "·")} ${paint(A.gray, position)}`}</Text>
      </Box>
      <Text wrap="truncate">
        {paint(A.gray, " f framework · 1/2/3 layout · esc cancel · r replay · ? help · q quit")}
      </Text>
    </Box>
  );
}

function Panel({ lines, title, width }: { lines: string[]; title: string; width: number }) {
  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      borderStyle="round"
      borderColor="yellow"
      width={width}
    >
      <Text color="yellow" bold>
        {title}
      </Text>
      {lines.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static panel rows
        <Text key={index} wrap="truncate">
          {line}
        </Text>
      ))}
    </Box>
  );
}

function App({ controller, finish }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [, bump] = useState(0);
  const lastSize = useRef("");

  const width = stdout.columns ?? 80;
  const height = stdout.rows ?? 24;
  const size = `${width}x${height}`;
  if (lastSize.current !== "" && lastSize.current !== size) controller.metrics.resizes += 1;
  lastSize.current = size;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    controller.start(
      () => {
        if (timer !== null) return;
        timer = setTimeout(() => {
          timer = null;
          bump((value) => value + 1);
        }, FRAME_INTERVAL_MS);
      },
      () => {
        finish();
        exit();
      },
    );
    return () => {
      if (timer !== null) clearTimeout(timer);
    };
  }, [controller, finish, exit]);

  useInput((input, key) => {
    const outcome = controller.handleKey(toSpikeKey(input, key));
    if (outcome === "quit" || outcome === "switch") {
      finish();
      exit();
    }
  });

  const layout = controller.config.layout;
  const railWidth = layout === "split" ? Math.min(34, Math.max(24, Math.floor(width * 0.3))) : 0;
  const transcriptWidth = layout === "split" ? Math.max(20, width - railWidth - 1) : width;

  const panel = approvalPanel(controller.view, transcriptWidth - 4);
  const inlinePanelHeight = layout === "overlay" || panel.length === 0 ? 0 : panel.length + 1;
  const bodyHeight = Math.max(1, height - 3 - inlinePanelHeight);

  const document = transcriptDocument(controller.view, transcriptWidth);
  controller.setViewport(document.length, bodyHeight);

  const overlayLines = controller.showHelp
    ? helpPanel(Math.min(60, width - 8))
    : layout === "overlay" && panel.length > 0
      ? panel
      : null;
  const overlayWidth = Math.min(width - 6, 68);
  const overlayHeight = (overlayLines?.length ?? 0) + 3;
  const overlayTop = Math.max(0, Math.floor((bodyHeight - overlayHeight) / 2));
  const overlayLeft = Math.max(0, Math.floor((width - overlayWidth) / 2));

  const body =
    layout === "split" ? (
      <Box flexDirection="row" height={bodyHeight}>
        <Box width={transcriptWidth}>
          <ScrollViewport lines={document} top={controller.scrollTop} height={bodyHeight} />
        </Box>
        <Box
          width={railWidth}
          borderStyle="single"
          borderTop={false}
          borderRight={false}
          borderBottom={false}
          borderColor="gray"
        >
          <ScrollViewport
            lines={railDocument(controller.view, railWidth)}
            top={0}
            height={bodyHeight}
          />
        </Box>
      </Box>
    ) : (
      <ScrollViewport lines={document} top={controller.scrollTop} height={bodyHeight} />
    );

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Header controller={controller} width={width} />
      <Box position="relative" height={bodyHeight} flexShrink={0}>
        {body}
        {overlayLines ? (
          <Box position="absolute" top={overlayTop} left={overlayLeft}>
            <Panel
              lines={overlayLines}
              title={controller.showHelp ? "help" : "approval"}
              width={overlayWidth}
            />
          </Box>
        ) : null}
      </Box>
      {inlinePanelHeight > 0 ? (
        <Panel lines={panel.slice(1)} title={truncate(panel[0] ?? "", width - 4)} width={width} />
      ) : null}
      <Footer controller={controller} width={width} />
    </Box>
  );
}

interface InkKey {
  ctrl: boolean;
  escape: boolean;
  return: boolean;
  upArrow: boolean;
  downArrow: boolean;
  pageUp: boolean;
  pageDown: boolean;
}

function toSpikeKey(input: string, key: InkKey): SpikeKey {
  if (key.ctrl && input === "c") return { name: "interrupt" };
  if (key.escape) return { name: "escape" };
  if (key.return) return { name: "enter" };
  if (key.upArrow) return { name: "up" };
  if (key.downArrow) return { name: "down" };
  if (key.pageUp) return { name: "pageup" };
  if (key.pageDown) return { name: "pagedown" };
  return { name: "char", value: input };
}

export async function runInk(controller: SpikeController): Promise<void> {
  controller.metrics.note("alternate screen and terminal suspension are provided by Ink 7.1.1");
  controller.metrics.note("scroll viewport is project-owned; Ink ships none (ink#773)");
  if (controller.config.layout === "overlay") {
    controller.metrics.note("approval uses Ink absolute positioning over the transcript");
  }
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    controller.stop();
  };

  const instance = render(<App controller={controller} finish={finish} />, {
    alternateScreen: true,
    exitOnCtrlC: false,
    incrementalRendering: true,
    maxFps: 60,
    onRender: ({ renderTime }) => {
      controller.metrics.frames += 1;
      controller.metrics.frameMs.push(renderTime);
    },
    patchConsole: false,
  });

  await instance.waitUntilExit();
  finish();
  instance.cleanup();
}
