// PROTOTYPE (CDA-144), throwaway. bun packages/tui/prototype-cda-144/main.tsx [--variant=A|B|C|D]
//   [--scene=<name>] [--keys=unix|windows] [--kitty=off]
import { mountApp } from "./app.tsx";
import type { Platform, Variant } from "./views.ts";

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [name = "", value = "true"] = arg.replace(/^--/, "").split("=");
    return [name, value] as const;
  }),
);
const variant = (args.get("variant") ?? "D").toUpperCase() as Variant;
const windowsLike =
  process.platform === "win32" ||
  process.env.WSL_DISTRO_NAME !== undefined ||
  process.env.WSL_INTEROP !== undefined;
const keys = args.get("keys");
const platform: Platform =
  keys === "windows" || keys === "unix" ? keys : windowsLike ? "windows" : "unix";

mountApp(
  { stdout: process.stdout, stdin: process.stdin },
  {
    variant: ["A", "B", "C", "D"].includes(variant) ? variant : "D",
    platform,
    scene: args.get("scene") ?? "running",
    kitty: args.get("kitty") !== "off",
    live: true,
  },
);
