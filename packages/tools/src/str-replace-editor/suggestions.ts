/**
 * What to do next, per `str_replace_editor` failure code — the corrective
 * half every tool failure carries (2026-09-18 review). The trained editor's
 * messages say WHAT went wrong in the trained wording; the harness adds the
 * move that fixes it, the way the other tools' `usage:` hints do. Shared by
 * the tool (`fail`) and its permission rule (`deny`): the edit is planned
 * at rule time, so `edit_not_found` and `edit_ambiguous` are rule-denies
 * and reach the model through the turn loop's gate, which carries the
 * rule's suggestion. Codes without an entry carry their own remedy in the
 * message (`path_not_absolute` names the likely path; `file_too_large`
 * names the bash slice).
 */
export const STR_REPLACE_EDITOR_SUGGESTIONS: Readonly<Record<string, string>> =
  {
    edit_not_found:
      "`view` the file (or the lines around the edit) and copy `old_str` verbatim from the output, whitespace and indentation included; do not retype it from memory.",
    edit_ambiguous:
      "Widen `old_str` with the surrounding lines until it occurs exactly once, then call str_replace again.",
    insert_out_of_range:
      "`view` the file to count its lines; `insert_line` is 0-based from the top and may equal the line count to append.",
    not_found:
      "`view` the parent directory to see what exists, then use the exact path; `create` makes a new file.",
    create_exists:
      "The file exists: `view` it and use `str_replace` or `insert` to change it, or choose another path.",
    invalid_input:
      "Check the command's required parameters: str_replace needs `old_str`, insert needs `insert_line` and `new_str`, create needs `file_text`.",
  };
