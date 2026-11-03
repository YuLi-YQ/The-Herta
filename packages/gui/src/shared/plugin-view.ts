import { parsePluginJson, PLUGIN_RUNTIME_LIMITS, type PluginJsonValue } from "./plugin-runtime.js";

export const PLUGIN_VIEW_LIMITS = Object.freeze({
  jsonBytes: 48 * 1024,
  actionInputBytes: PLUGIN_RUNTIME_LIMITS.inputBytes,
  titleLength: 120,
  blocks: 24,
  actions: 8,
  textLength: 8000,
  codeLength: 16000,
  languageLength: 32,
  listItems: 100,
  tableColumns: 12,
  tableRows: 100,
  cellLength: 2000,
  fields: 32,
});
export type PluginViewTone = "info" | "success" | "warning" | "error";
export type PluginViewBlock =
  | Readonly<{ type: "text"; text: string }>
  | Readonly<{ type: "code"; code: string; language?: string }>
  | Readonly<{ type: "list"; items: readonly string[] }>
  | Readonly<{ type: "table"; columns: readonly string[]; rows: readonly (readonly string[])[] }>
  | Readonly<{ type: "status"; tone: PluginViewTone; text: string }>
  | Readonly<{ type: "fields"; items: readonly Readonly<{ label: string; value: string }>[] }>;
export interface PluginViewAction {
  readonly id: string;
  readonly label: string;
  readonly actionId: string;
  /** Complete, bounded JSON object; the controller checks the target manifest's actual input schema. */
  readonly inputJson: string;
}
export interface PluginControlledViewDefinition {
  readonly title: string;
  readonly blocks: readonly PluginViewBlock[];
  readonly actions: readonly PluginViewAction[];
}
/** id/revision are host-owned and cannot be supplied in a Guest view definition. */
export interface PluginControlledView extends PluginControlledViewDefinition {
  readonly id: string;
  readonly revision: number;
}
export class PluginViewFault extends Error {
  constructor() { super("受控视图内容不符合协议。"); this.name = "PluginViewFault"; }
}
const forbidden = new Set(["__proto__", "constructor", "prototype"]);
const idPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const languagePattern = /^[A-Za-z][A-Za-z0-9_+-]*$/;
const tones = new Set<string>(["info", "success", "warning", "error"]);
function invalid(): never { throw new PluginViewFault(); }
function own<const T extends object>(value: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null) as T, value));
}
function withinBytes(text: string, maximum: number): void {
  if (text.length > maximum || new TextEncoder().encode(text).length > maximum) invalid();
}
function safeCharacters(text: string): void {
  // Permit TAB/LF/CR for ordinary text and code; reject other C0, DEL and C1
  // controls and malformed UTF-16 rather than silently changing their content.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(text)) invalid();
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = text.charCodeAt(++index);
      if (!(low >= 0xdc00 && low <= 0xdfff)) invalid();
    } else if (unit >= 0xdc00 && unit <= 0xdfff) invalid();
  }
}
function text(raw: unknown, maximum: number, nonblank = false): string {
  if (typeof raw !== "string" || raw.length > maximum || (nonblank && !raw.trim())) invalid();
  safeCharacters(raw);
  return raw;
}
function identifier(raw: unknown): string {
  const value = text(raw, 64, true);
  if (!idPattern.test(value) || forbidden.has(value)) invalid();
  return value;
}
/** Helpers only inspect parser-owned JSON data, never caller-provided JS objects. */
function object(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid();
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some((key) => !keys.includes(key))) invalid();
  return value;
}
function array(raw: unknown, maximum: number, minimum = 0): readonly unknown[] {
  if (!Array.isArray(raw) || raw.length < minimum || raw.length > maximum) invalid();
  return raw;
}
function safeJsonStrings(value: PluginJsonValue): void {
  if (typeof value === "string") safeCharacters(value);
  else if (Array.isArray(value)) value.forEach(safeJsonStrings);
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) { safeCharacters(key); safeJsonStrings(item); }
  }
}
function actionInput(raw: unknown): string {
  if (typeof raw !== "string") invalid();
  const value = parsePluginJson(raw, PLUGIN_VIEW_LIMITS.actionInputBytes);
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  safeJsonStrings(value);
  // parsePluginJson creates own data with no getters/callable toJSON. It is safe
  // to normalize this owned value; arbitrary external objects never reach here.
  const normalized = JSON.stringify(value);
  withinBytes(normalized, PLUGIN_VIEW_LIMITS.actionInputBytes);
  return normalized;
}
function block(raw: unknown): PluginViewBlock {
  const type = object(raw, ["type", "text", "code", "language", "items", "columns", "rows", "tone"]).type;
  switch (type) {
    case "text": {
      const item = object(raw, ["type", "text"]);
      return own({ type, text: text(item.text, PLUGIN_VIEW_LIMITS.textLength) });
    }
    case "code": {
      const item = object(raw, ["type", "code", "language"]), code = text(item.code, PLUGIN_VIEW_LIMITS.codeLength);
      if (item.language === undefined) return own({ type, code });
      const language = text(item.language, PLUGIN_VIEW_LIMITS.languageLength, true);
      if (!languagePattern.test(language)) invalid();
      return own({ type, code, language });
    }
    case "list": {
      const item = object(raw, ["type", "items"]);
      return own({ type, items: Object.freeze(array(item.items, PLUGIN_VIEW_LIMITS.listItems).map((value) => text(value, PLUGIN_VIEW_LIMITS.cellLength))) });
    }
    case "table": {
      const item = object(raw, ["type", "columns", "rows"]);
      const columns = Object.freeze(array(item.columns, PLUGIN_VIEW_LIMITS.tableColumns, 1).map((value) => text(value, PLUGIN_VIEW_LIMITS.cellLength)));
      const rows = Object.freeze(array(item.rows, PLUGIN_VIEW_LIMITS.tableRows).map((rawRow) => {
        const row = array(rawRow, columns.length, columns.length);
        return Object.freeze(row.map((value) => text(value, PLUGIN_VIEW_LIMITS.cellLength)));
      }));
      return own({ type, columns, rows });
    }
    case "status": {
      const item = object(raw, ["type", "tone", "text"]);
      if (typeof item.tone !== "string" || !tones.has(item.tone)) invalid();
      return own({ type, tone: item.tone as PluginViewTone, text: text(item.text, PLUGIN_VIEW_LIMITS.cellLength) });
    }
    case "fields": {
      const item = object(raw, ["type", "items"]);
      const fields = array(item.items, PLUGIN_VIEW_LIMITS.fields).map((rawField) => {
        const field = object(rawField, ["label", "value"]);
        return own({ label: text(field.label, PLUGIN_VIEW_LIMITS.titleLength), value: text(field.value, PLUGIN_VIEW_LIMITS.cellLength) });
      });
      return own({ type, items: Object.freeze(fields) });
    }
    default: return invalid();
  }
}

/**
 * JSON text is the only public input. Reject external objects without reflection,
 * stringify or coercion so accessors/Proxy/toJSON cannot run in the host realm.
 * The controller separately checks declared target actions, scope and actual
 * input definitions; parsing never grants permission or executes an action.
 */
export function parsePluginControlledView(json: unknown): PluginControlledViewDefinition {
  if (typeof json !== "string") invalid();
  try {
    const raw = object(parsePluginJson(json, PLUGIN_VIEW_LIMITS.jsonBytes), ["title", "blocks", "actions"]);
    const title = text(raw.title, PLUGIN_VIEW_LIMITS.titleLength, true);
    const blocks = Object.freeze(array(raw.blocks, PLUGIN_VIEW_LIMITS.blocks).map(block));
    const actions = Object.freeze(array(raw.actions, PLUGIN_VIEW_LIMITS.actions).map((rawAction) => {
      const action = object(rawAction, ["id", "label", "actionId", "inputJson"]);
      return own({ id: identifier(action.id), label: text(action.label, PLUGIN_VIEW_LIMITS.titleLength, true),
        actionId: identifier(action.actionId), inputJson: actionInput(action.inputJson) });
    }));
    if (new Set(actions.map((action) => action.id)).size !== actions.length) invalid();
    const value = own({ title, blocks, actions });
    withinBytes(JSON.stringify(value), PLUGIN_VIEW_LIMITS.jsonBytes);
    return value;
  } catch { return invalid(); }
}
