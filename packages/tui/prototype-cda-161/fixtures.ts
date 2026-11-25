interface Edit {
  readonly line: number;
  readonly remove: number;
  readonly insert: readonly string[];
}

export type DiffLine =
  | {
      readonly kind: "added" | "removed" | "context";
      readonly lineNumber: number;
      readonly text: string;
    }
  | { readonly kind: "gap" | "truncated" };

const CONTEXT_LINES = 4;

function fixture(
  label: string,
  path: string,
  before: string,
  edits: readonly Edit[],
  previewRowsPerEnd?: number,
) {
  const eol = before.includes("\r\n") ? "CRLF" : "LF";
  const lines = before.split(/\r?\n/);
  const added = edits.reduce((count, edit) => count + edit.insert.length, 0);
  const removed = edits.reduce((count, edit) => count + edit.remove, 0);
  const rows: DiffLine[] = [];

  let oldLine = 1;
  let newLine = 1;
  function context(until: number, keepStart: number, keepEnd: number) {
    const count = until - oldLine;
    const visibleAtStart = Math.min(keepStart, count);
    const hidden = Math.max(0, count - visibleAtStart - keepEnd);
    for (const text of lines.slice(oldLine - 1, oldLine - 1 + visibleAtStart)) {
      rows.push({ kind: "context", lineNumber: newLine++, text });
      oldLine++;
    }
    if (hidden > 0) {
      rows.push({ kind: "gap" });
      oldLine += hidden;
      newLine += hidden;
    }
    for (const text of lines.slice(oldLine - 1, until - 1)) {
      rows.push({ kind: "context", lineNumber: newLine++, text });
      oldLine++;
    }
  }

  for (const [index, edit] of edits.entries()) {
    context(edit.line, index === 0 ? 0 : CONTEXT_LINES, CONTEXT_LINES);
    for (const text of lines.slice(oldLine - 1, oldLine - 1 + edit.remove)) {
      rows.push({ kind: "removed", lineNumber: oldLine++, text });
    }
    for (const text of edit.insert) {
      rows.push({ kind: "added", lineNumber: newLine++, text });
    }
  }
  context(lines.length + 1, CONTEXT_LINES, 0);

  if (previewRowsPerEnd !== undefined && rows.length > previewRowsPerEnd * 2 + 1) {
    rows.splice(previewRowsPerEnd, rows.length - previewRowsPerEnd * 2, { kind: "truncated" });
  }
  return { label, path, eol, rows, added, removed };
}

const rule = (id: number, owner: string) =>
  `  { id: "rule-${String(id).padStart(3, "0")}", owner: "${owner}", active: true },`;

export const fixtures = {
  small: fixture(
    "Small edit",
    "src/http/retry.ts",
    [
      'import { sleep } from "./clock.ts";',
      "",
      "const MAX_RETRIES = 2;",
      "const BASE_DELAY_MS = 150;",
      "",
      "export async function retry<T>(request: () => Promise<T>): Promise<T> {",
      "  for (let attempt = 0; ; attempt++) {",
      "    try {",
      "      return await request();",
      "    } catch (error) {",
      "      if (attempt >= MAX_RETRIES) throw error;",
      "      await sleep(BASE_DELAY_MS * (attempt + 1));",
      "    }",
      "  }",
      "}",
    ].join("\n"),
    [
      { line: 3, remove: 1, insert: ["const MAX_RETRIES = 3;"] },
      {
        line: 12,
        remove: 1,
        insert: [
          "      const delay = Math.min(BASE_DELAY_MS * 2 ** attempt, 2_000);",
          "      await sleep(delay);",
        ],
      },
    ],
  ),
  large: fixture(
    "100 replaced lines · truncated",
    "src/policy/ownership.ts",
    [
      "export const ownership = [",
      ...Array.from({ length: 248 }, (_, index) => rule(index + 1, "legacy")),
      "];",
    ].join("\n"),
    [
      {
        line: 18,
        remove: 5,
        insert: Array.from({ length: 5 }, (_, index) => rule(17 + index, "platform")),
      },
      {
        line: 70,
        remove: 90,
        insert: [
          "  // Platform owns the migrated rules.",
          ...Array.from({ length: 90 }, (_, index) => rule(69 + index, "platform")),
        ],
      },
      {
        line: 231,
        remove: 5,
        insert: Array.from({ length: 5 }, (_, index) => rule(230 + index, "support")),
      },
    ],
    64, // Simulate a shortened payload with changed rows at both ends.
  ),
  crlf: fixture(
    "CRLF file",
    "config/windows.ini",
    [
      "[logging]",
      "\tlevel=info",
      "\trotate=true",
      "",
      "[network]",
      "\ttimeout_ms=2500",
      "\tretry_count=2",
      "\tverify_tls=true",
      "",
      "[cache]",
      "\tenabled=true",
      "\tttl_seconds=60",
    ].join("\r\n"),
    [
      {
        line: 6,
        remove: 2,
        insert: ["\ttimeout_ms=5000", "\tretry_count=3", "\tbackoff_ms=125"],
      },
    ],
  ),
  unicode: fixture(
    "Unicode text",
    "src/i18n/vi.ts",
    [
      "export const messages = {",
      '  title: "Cập nhật",',
      '  saved: "Đã lưu 📁",',
      '  retry: "Thử lại",',
      '  status: "進捗 / 进度 / trạng thái",',
      '  loading: "Đang tải",',
      '  online: "Trực tuyến",',
      '  offline: "Ngoại tuyến",',
      '  cancel: "Hủy",',
      '  submit: "Gửi",',
      '  back: "Quay lại",',
      '  confirm: "Xác nhận",',
      '  close: "Đóng",',
      '  separator: "・",',
      '  empty: "Không có dữ liệu",',
      '  help: "Xem hướng dẫn",',
      "};",
    ].join("\n"),
    [
      {
        line: 3,
        remove: 1,
        insert: [
          '  saved: "Đã lưu bởi nhóm 👩🏽‍💻 · 保存完了 · Sẵn sàng đồng bộ khi kết nối trở lại",',
          '  savedFolder: "Thư mục 📁",',
        ],
      },
      {
        line: 16,
        remove: 1,
        insert: ['  help: "Mở tài liệu trợ giúp · 日本語 · e\u0301/é",'],
      },
    ],
  ),
};

export type Fixture = ReturnType<typeof fixture>;
