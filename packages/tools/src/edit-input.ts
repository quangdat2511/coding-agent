import { type Static, Type } from "typebox";
import { quote } from "./messages.ts";
import { boundToolOutput } from "./output-budget.ts";
import { FILE_PATH_PATTERN } from "./paths.ts";

export const EditParams = Type.Object(
  {
    path: Type.String({
      pattern: FILE_PATH_PATTERN.source,
      description: "Path of an existing file relative to the repository root or absolute inside it",
    }),
    edits: Type.Array(
      Type.Object(
        {
          oldText: Type.String({
            minLength: 1,
            description: "Text that uniquely matches a range in the original file",
          }),
          newText: Type.String({
            description: "Replacement text, or an empty string to delete the range",
          }),
        },
        { additionalProperties: false },
      ),
      {
        minItems: 1,
        description: "Disjoint replacements matched independently against the original file",
      },
    ),
  },
  { additionalProperties: false },
);

export type EditInput = Static<typeof EditParams>;

type Fields = Record<string, unknown>;

function isObject(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(input: Fields, correction: string): { ok: false; message: string } {
  const file = typeof input.path === "string" ? ` for ${quote(input.path)}` : "";
  return {
    ok: false,
    message: boundToolOutput(`Invalid edit arguments${file}. ${correction}`).content,
  };
}

function hasEither(input: Fields, first: string, second: string): boolean {
  return Object.hasOwn(input, first) || Object.hasOwn(input, second);
}

export function normalizeEditArguments(
  raw: unknown,
): { ok: true; input: unknown } | { ok: false; message: string } {
  if (!isObject(raw)) return invalid({}, "Supply an object with path and a non-empty edits array.");
  const legacy = hasEither(raw, "targetContent", "replacementContent");
  const piLegacy = hasEither(raw, "oldText", "newText");
  const hasBatch = Object.hasOwn(raw, "edits");
  if ((legacy && piLegacy) || (hasBatch && (legacy || piLegacy))) {
    return invalid(raw, "Use one input form. Supply path and a non-empty edits array.");
  }

  let edits = raw.edits;
  let input = raw;
  if (legacy || piLegacy) {
    const oldKey = legacy ? "targetContent" : "oldText";
    const newKey = legacy ? "replacementContent" : "newText";
    if (!Object.hasOwn(raw, oldKey) || !Object.hasOwn(raw, newKey)) {
      return invalid(raw, `Supply both ${oldKey} and ${newKey}, or use an edits array.`);
    }
    const { [oldKey]: oldText, [newKey]: newText, ...rest } = raw;
    input = rest;
    edits = [{ oldText, newText }];
  } else if (typeof edits === "string") {
    try {
      edits = JSON.parse(edits);
    } catch {
      return invalid(
        raw,
        "Supply edits as an array or a JSON string containing an object or array.",
      );
    }
  }

  const normalized = { ...input, edits: isObject(edits) ? [edits] : edits };
  const failure = checkEditInput(normalized);
  return failure ?? { ok: true, input: normalized };
}

export function checkEditInput(input: Fields): { ok: false; message: string } | undefined {
  const { path } = input;
  if (typeof path !== "string" || !FILE_PATH_PATTERN.test(path)) {
    return invalid(input, "Supply a non-empty path naming a file.");
  }
  if (!path.isWellFormed()) {
    return invalid(input, "Supply a file path with well-formed Unicode text.");
  }
  if (Object.keys(input).some((key) => key !== "path" && key !== "edits")) {
    return invalid(input, "Supply only path and edits.");
  }
  const { edits } = input;
  if (!Array.isArray(edits) || edits.length === 0) {
    return invalid(input, "Supply a non-empty edits array.");
  }
  for (const [index, edit] of edits.entries()) {
    if (
      !isObject(edit) ||
      Object.keys(edit).some((key) => key !== "oldText" && key !== "newText")
    ) {
      return invalid(input, `Supply edits[${index}] as an object with only oldText and newText.`);
    }
    if (typeof edit.oldText !== "string" || edit.oldText === "" || !edit.oldText.isWellFormed()) {
      return invalid(input, `Supply edits[${index}].oldText as a non-empty, well-formed string.`);
    }
    if (typeof edit.newText !== "string" || !edit.newText.isWellFormed()) {
      return invalid(input, `Supply edits[${index}].newText as a well-formed string.`);
    }
  }
  return undefined;
}
