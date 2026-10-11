import { z } from "zod";

/** The trained shape's parameters (ADR 0040): four commands over one path. */
export const strReplaceEditorInputSchema = z
  .object({
    command: z.enum(["view", "create", "str_replace", "insert"]),
    path: z.string().min(1, "path must be non-empty"),
    file_text: z.string().optional(),
    insert_line: z.number().int().optional(),
    new_str: z.string().optional(),
    old_str: z.string().optional(),
    view_range: z.array(z.number().int()).optional(),
  })
  .strict();

export type StrReplaceEditorInput = z.infer<typeof strReplaceEditorInputSchema>;

/** Hand-written JSON schema — the exact wire shape the model was trained on
 *  (descriptions included; `${ws}` is the workspace as the shell spells it,
 *  substituted per session so the example paths are real). */
export function strReplaceEditorJsonSchema(
  workspaceShellPath: string,
): unknown {
  return {
    type: "object",
    properties: {
      command: {
        type: "string",
        enum: ["view", "create", "str_replace", "insert"],
        description:
          "The commands to run. Allowed options are: `view`, `create`, `str_replace`, `insert`.",
      },
      path: {
        type: "string",
        description: `Absolute path to file or directory, e.g. \`${workspaceShellPath}/src/main.ts\` or \`${workspaceShellPath}\`.`,
      },
      file_text: {
        type: "string",
        description:
          "Required parameter of `create` command, with the content of the file to be created.",
      },
      insert_line: {
        type: "integer",
        description:
          "Required parameter of `insert` command. The `new_str` will be inserted AFTER the line `insert_line` of `path`.",
      },
      new_str: {
        type: "string",
        description:
          "Optional parameter of `str_replace` command containing the new string (if not given, no string will be added). Required parameter of `insert` command containing the string to insert.",
      },
      old_str: {
        type: "string",
        description:
          "Required parameter of `str_replace` command containing the string in `path` to replace.",
      },
      view_range: {
        type: "array",
        items: { type: "integer" },
        description:
          "Optional parameter of `view` command when `path` points to a file. If none is given, the full file is shown. If provided, the file will be shown in the indicated line number range, e.g. [11, 12] will show lines 11 and 12. Indexing at 1 to start. Setting `[start_line, -1]` shows all lines from `start_line` to the end of the file.",
      },
    },
    required: ["command", "path"],
  };
}

export const STR_REPLACE_EDITOR_DESCRIPTION = [
  "Custom editing tool for viewing, creating and editing files",
  "* State is persistent across command calls and discussions with the user",
  "* If `path` is a file, `view` displays the result of applying `cat -n`. If `path` is a directory, `view` lists non-hidden files and directories up to 2 levels deep",
  "* The `create` command cannot be used if the specified `path` already exists as a file",
  "* If a `command` generates a long output, it will be truncated and marked with `<response clipped>`",
  "",
  "Notes for using the `str_replace` command:",
  "* The `old_str` parameter should match EXACTLY one or more consecutive lines from the original file. Be mindful of whitespaces!",
  "* If the `old_str` parameter is not unique in the file, the replacement will not be performed. Make sure to include enough context in `old_str` to make it unique",
  "* The `new_str` parameter should contain the edited lines that should replace the `old_str`",
].join("\n");
