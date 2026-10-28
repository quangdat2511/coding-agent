import { describe, expect, it } from "bun:test";
import { namesDirectory, normalizeWindowsShellPath } from "../src/paths.ts";

describe("normalizeWindowsShellPath", () => {
  it.each([
    ["/c/Users/dev", "C:\\Users\\dev"],
    ["/C/Users/dev", "C:\\Users\\dev"],
    ["/mnt/d/repo/src/a.ts", "D:\\repo\\src\\a.ts"],
    ["/cygdrive/e/work", "E:\\work"],
    ["/c", "C:\\"],
    ["/c/", "C:\\"],
    ["/mnt/c", "C:\\"],
  ])("converts %s to %s on Windows", (input, expected) => {
    expect(normalizeWindowsShellPath(input, "win32")).toBe(expected);
  });

  it.each(["/foo/bar", "//server/share", "C:\\repo", "relative/path", "~/x", "c:/repo"])(
    "leaves %s unchanged on Windows",
    (input) => {
      expect(normalizeWindowsShellPath(input, "win32")).toBe(input);
    },
  );

  it("leaves a drive-like path unchanged on POSIX", () => {
    expect(normalizeWindowsShellPath("/c/Users/dev", "linux")).toBe("/c/Users/dev");
  });
});

describe("namesDirectory", () => {
  it.each(["src/", "src\\", "src/.", "src\\.", "C:\\", "/"])(
    "treats %s as a directory on Windows",
    (input) => {
      expect(namesDirectory(input, "win32")).toBe(true);
    },
  );

  it.each(["src", "src/file.ts", "src\\file.ts"])(
    "does not treat %s as a directory on Windows",
    (input) => {
      expect(namesDirectory(input, "win32")).toBe(false);
    },
  );

  it.each(["src/", "src/.", "/"])("treats %s as a directory on POSIX", (input) => {
    expect(namesDirectory(input, "linux")).toBe(true);
  });

  it.each(["src", "src\\", "src\\."])("does not treat %s as a directory on POSIX", (input) => {
    expect(namesDirectory(input, "linux")).toBe(false);
  });
});
