import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { useHertaBridge } from "../context/HertaBridgeContext.js";
import "../styles/slash-menu.css";
import {
  type BackendCommands,
  type ComposerCommand,
  type ComposerState,
  commandAt,
  commandMatches,
  composerCommands,
  composerRoot,
  PROMPT_LIST_FAILED,
  type PromptCommand,
  promptCommands,
  promptListProblem,
  runCommand,
} from "./ComposerActions.js";

/**
 * A composer's `/` menu (R80; on the shared command registry since R123). Typed at the
 * start of a line, `/` lists the composer's actions (the same ones as the 快捷操作 menu) and
 * the enabled prompt actions, narrowed as the user types, by Chinese name or English alias.
 * ↑↓ choose, Enter runs, Esc closes and keeps the draft; running replaces only the typed
 * `/word`. A command that cannot run says why and leaves the draft as typed. A command
 * nothing matches leaves Enter a newline. An IME mid-composition, a paste, a path or a URL
 * never opens or runs it, and a different chat or task closes it. A command of the host's
 * (the export, R124) starts here and reports beside the composer, like from 快捷操作.
 */
export function useSlashMenu({
  scope,
  target,
  textarea,
  draft,
  setDraft,
  disabled,
  state = {},
  backend,
  onPromptAction,
}: {
  readonly scope: "chat" | "workbench";
  /** What may stop a command now (a running turn, a task opening); the 快捷操作 menu reads the same. */
  readonly state?: ComposerState;
  /** The host's own commands, the same ones the 快捷操作 menu lists. */
  readonly backend?: BackendCommands;
  /** The chat or task the composer belongs to: a change closes the menu. */
  readonly target: string;
  readonly textarea: RefObject<HTMLTextAreaElement | null>;
  readonly draft: string;
  readonly setDraft: (value: string) => void;
  readonly disabled: boolean;
  /** Open the prompt action in the 快捷操作 menu, to fill and preview it there. */
  readonly onPromptAction: (
    pluginId: string,
    actionId: string,
    title: string,
  ) => void;
}): {
  readonly menu: ReactNode;
  readonly onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  readonly onChange: (value: string, caret: number) => void;
  readonly onPaste: () => void;
  readonly close: () => void;
  readonly textareaProps: Record<string, string | undefined>;
} {
  const { bridge } = useHertaBridge();
  const id = useId();
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [prompts, setPrompts] = useState<PromptCommand[]>([]);
  // Why the prompt actions could not be listed, and why the last command did not run.
  const [listProblem, setListProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pasted = useRef(false);
  const generation = useRef(0);
  const open = query !== null && !disabled;
  useEffect(() => {
    setQuery(null);
    setPrompts([]);
    setNotice(null);
  }, [target]);
  // The enabled prompt actions, read each time the menu opens (settings may have changed).
  useEffect(() => {
    setPrompts([]);
    setListProblem(null);
    if (!open || !bridge.promptPlugins) return;
    const token = ++generation.current;
    bridge.promptPlugins({ kind: "list" }).then(
      (reply) => {
        if (token !== generation.current) return;
        const problem = promptListProblem(reply);
        if (problem !== null || !reply.ok) {
          setListProblem(problem);
          return;
        }
        setPrompts(promptCommands(reply.snapshot.items, scope));
      },
      () => {
        if (token === generation.current) setListProblem(PROMPT_LIST_FAILED);
      },
    );
    return () => { generation.current += 1; };
  }, [open, bridge, scope, target]);

  const q = query ?? "";
  const entries = open
    ? composerCommands({
        scope,
        root: () => composerRoot(textarea.current),
        state,
        prompts,
        openPrompt: onPromptAction,
        backend,
      })
        .filter((command) => commandMatches(command, q))
        .map((command) => ({ command, availability: command.availability() }))
    : [];
  const current = entries.length ? Math.min(active, entries.length - 1) : -1;

  const commandIsCurrent = () => {
    const field = textarea.current;
    return field !== null && field.selectionStart === field.selectionEnd &&
      commandAt(draft, field.selectionStart) === query;
  };
  const close = () => {
    setQuery(null);
    setNotice(null);
  };
  const run = (command: ComposerCommand) => {
    if (!commandIsCurrent()) {
      close();
      return;
    }
    const caret = textarea.current?.selectionStart ?? draft.length;
    const outcome = runCommand(command);
    if (!outcome.ok) {
      // The typed `/word` stays: nothing ran, so nothing of the draft is used up.
      setNotice(outcome.error);
      return;
    }
    const before = draft.slice(0, caret);
    setDraft(draft.slice(0, before.lastIndexOf("\n") + 1) + draft.slice(caret));
    close();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return false;
    if (!commandIsCurrent()) {
      close();
      return false;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return true;
    }
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && entries.length) {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current + step + entries.length) % entries.length);
      setNotice(null);
      return true;
    }
    if (event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
      const entry = entries[current];
      if (!entry) {
        close();
        return false;
      }
      event.preventDefault();
      run(entry.command);
      return true;
    }
    return false;
  };
  const onChange = (value: string, caret: number) => {
    setNotice(null);
    if (pasted.current) {
      pasted.current = false;
      setQuery(null);
      return;
    }
    const next = commandAt(value, caret);
    if (next !== query) setActive(0);
    setQuery(next);
  };

  const menu = open ? (
    <div className="herta-slash-menu" id={id} role="listbox" aria-label="指令">
      {notice && (
        <p className="herta-slash-notice" role="alert">
          {notice}
        </p>
      )}
      {entries.length ? (
        entries.map(({ command, availability }, index) => (
          <div key={command.key}>
            {entries[index - 1]?.command.group !== command.group && (
              <p className="herta-slash-group" aria-hidden="true">
                {command.group}
              </p>
            )}
            <div
              id={`${id}-${index}`}
              role="option"
              aria-selected={index === current}
              aria-disabled={availability.ok ? undefined : true}
              className="herta-slash-option"
              // Keeps the caret in the draft; the click itself runs the entry.
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => run(command)}
            >
              <span className="herta-slash-title">{command.title}</span>
              {command.aliases[0] && (
                <span className="herta-slash-alias">/{command.aliases[0]}</span>
              )}
              <span className="herta-slash-hint">
                {availability.ok ? command.hint : availability.reason}
              </span>
            </div>
          </div>
        ))
      ) : (
        <p className="herta-slash-empty" role="status">
          没有匹配的指令，按 Enter 照常换行。
        </p>
      )}
      {listProblem && (
        <p className="herta-slash-notice" role="status">
          {listProblem}
        </p>
      )}
    </div>
  ) : null;

  return {
    menu,
    onKeyDown,
    onChange,
    onPaste: () => {
      pasted.current = true;
    },
    close,
    textareaProps: {
      "aria-autocomplete": "list",
      "aria-controls": open ? id : undefined,
      "aria-activedescendant": open && current >= 0 ? `${id}-${current}` : undefined,
    },
  };
}
