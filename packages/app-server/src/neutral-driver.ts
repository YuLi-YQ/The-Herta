import { randomUUID } from "node:crypto";
import { webSearchSupport } from "@herta/providers/web-search";
import type {
  AgentEvent,
  CodingAgentRuntime,
  EventBus,
  SystemBlock,
  TerminalRecord,
  TerminalRecordBlock,
  ToolCallRequest,
  V2RecordPersister,
} from "@herta/core";
import { readDispatchJournal } from "@herta/core";
import { invokeBanzhuanBridge, type V2ActorDriver } from "@herta/herta";
import {
  createProtocolAdapter,
  type NativeContext,
  type NeutralMessage,
} from "@herta/providers";
import type { BusActorStreamingSink } from "./bus-streaming-sink.js";
import type { NeutralBackendProvider } from "./neutral-provider.js";
import { ownedNativeContext } from "./neutral-provider.js";
import { desktopPersonaIdentity } from "./desktop-persona.js";
import { beginNeutralUsage, readNeutralMetrics } from "./neutral-usage.js";
import { buildRecoverySummary } from "./recovery-summary.js";
import { RoundStore } from "./round-store.js";
import type { AppServerConfig } from "./types.js";
import {
  type InputCheckpoint,
  type PendingUserInput,
  type UserInputAnswer,
  UserInputJournal,
  userInputTool,
  validateAnswer,
  validateQuestions,
} from "./user-input.js";

export type SessionDriver = Pick<
  V2ActorDriver,
  | "getRecord"
  | "loadRecord"
  | "appendSystemNote"
  | "appendSystemBlock"
  | "replaceBlockAt"
  | "runTurn"
  | "markPrefixStale"
  | "regenerateLastReply"
  | "playOpening"
  | "rewindLastUserTurn"
>;

/** Persona uses chat messages and an explicit dispatch tool, never completion/prefill. */
export class NeutralDriver implements SessionDriver {
  readonly roundStore: RoundStore;
  async getRoundSummaries() {
    return Promise.all(
      this.roundStore.summaries().map(async (summary) => ({
        ...summary,
        metrics: await readNeutralMetrics(
          this.deps.usageLogPath,
          this.deps.sessionId,
          summary.attemptIds,
        ),
      })),
    );
  }
  getTaskMetrics() {
    return readNeutralMetrics(this.deps.usageLogPath, this.deps.sessionId);
  }
  private record: TerminalRecord = [];
  private get inputJournal(): UserInputJournal {
    return new UserInputJournal(`${this.deps.journalPath}.user-input.json`);
  }
  getPendingUserInput(): PendingUserInput | null {
    const saved = this.inputJournal.read();
    return saved?.request.state === "waiting_for_input" ? saved.request : null;
  }
  prepareUserInputAnswer(value: unknown): {
    answer: UserInputAnswer;
    checkpoint: InputCheckpoint;
  } {
    const checkpoint = this.inputJournal.read();
    if (!checkpoint) throw new Error("No pending user input");
    const answer = validateAnswer(value, checkpoint.request);
    if (answer.action !== "defer")
      checkpoint.request = {
        ...checkpoint.request,
        state: answer.action === "cancel" ? "cancelled" : "answered",
      };
    checkpoint.answer = answer;
    if (answer.action === "cancel") this.roundStore.cancelWaiting();
    this.inputJournal.write(checkpoint);
    if (answer.action !== "defer") {
      const answeredQuestions = checkpoint.request.questions.map((question) => {
        const entry = answer.answers.find(
          (item) => item.questionId === question.id,
        );
        const content = entry
          ? [
              ...entry.optionIds.map(
                (id) =>
                  question.options.find((option) => option.id === id)?.label ??
                  "",
              ),
              entry.text?.trim() ?? "",
            ]
              .filter(Boolean)
              .join("；")
          : "";
        return `${question.prompt}\n${content || "已跳过"}`;
      });
      this.appendSystemNote(
        "系统",
        answer.action === "cancel"
          ? "已取消补充信息请求，任务未继续。"
          : `用户补充信息：\n${answeredQuestions.join("\n\n")}`,
      );
    }
    return { answer, checkpoint };
  }
  constructor(
    private readonly deps: {
      sessionId: string;
      turnId: () => string;
      resolveTurn: NonNullable<
        AppServerConfig["neutralProviders"]
      >["resolveTurn"];
      backendProvider: NeutralBackendProvider;
      runtimeFactory: () => CodingAgentRuntime;
      bus: EventBus<AgentEvent>;
      persister: V2RecordPersister;
      sink: BusActorStreamingSink;
      lang: "zh" | "en";
      usageLogPath?: string;
      journalPath: string;
      workspace?: () => string;
    },
  ) {
    this.roundStore = new RoundStore(
      `${deps.journalPath}.rounds.json`,
      deps.sessionId,
      deps.workspace ?? (() => process.cwd()),
    );
    deps.sink.setPersistHook((block) => deps.persister.appendBlock(block));
  }
  getRecord(): TerminalRecord {
    return this.record;
  }
  loadRecord(record: TerminalRecord): void {
    this.record = [...record];
  }
  markPrefixStale(): void {}
  appendSystemBlock(block: SystemBlock): void {
    this.append(block);
  }
  appendSystemNote(label: SystemBlock["label"], body: string): void {
    this.append({ kind: "system", label, body });
  }
  replaceBlockAt(index: number, block: SystemBlock): boolean {
    if (!this.record[index] || this.record[index]?.kind !== "system")
      return false;
    this.deps.persister.replaceBlockAt(index, block);
    this.record = this.record.map((old, i) => (i === index ? block : old));
    return true;
  }
  private append(block: TerminalRecordBlock): void {
    this.record = [...this.record, { ...block, at: new Date().toISOString() }];
    this.deps.sink.flushBlocks(this.record);
  }
  async playOpening(): Promise<void> {}
  async regenerateLastReply(): Promise<TerminalRecord> {
    return this.record;
  }
  rewindLastUserTurn(): { userText: string; withdrawn: TerminalRecord } | null {
    let index = -1;
    for (let i = this.record.length - 1; i >= 0; i--) {
      const block = this.record[i];
      if (block?.kind === "user" && !block.steer) {
        index = i;
        break;
      }
    }
    const user = this.record[index];
    if (!user || user.kind !== "user") return null;
    const withdrawn = this.record.slice(index);
    this.deps.persister.truncateToBlockCount(index);
    this.record = this.record.slice(0, index);
    return { userText: user.text, withdrawn };
  }
  async runTurn(
    text: string,
    signal: AbortSignal,
    _voiceEligible?: boolean,
    attachments: readonly SystemBlock[] = [],
    options?: { resume?: boolean; inputContinuation?: InputCheckpoint },
  ): Promise<TerminalRecord> {
    if (!options?.inputContinuation && this.getPendingUserInput())
      throw new Error("请先回答或取消当前补充信息请求");
    this.roundStore.begin(
      this.deps.turnId(),
      this.record.length,
      Boolean(options?.inputContinuation || options?.resume),
    );
    const unsubscribe = this.deps.bus.onAny((event) =>
      this.roundStore.event(event),
    );
    let outcome: import("./round-summary.js").RoundStatus = "completed";
    let resolved:
      | Awaited<
          ReturnType<
            NonNullable<AppServerConfig["neutralProviders"]>["resolveTurn"]
          >
        >
      | undefined;
    try {
      resolved = await this.deps.resolveTurn(
        this.deps.sessionId,
        this.deps.turnId(),
      );
      // Defensive copy: callers cannot mutate an in-flight URL, model or credential.
      const snapshot = structuredClone(resolved.snapshot);
      const freeze = (value: object): void => {
        Object.freeze(value);
        for (const child of Object.values(value))
          if (child && typeof child === "object") freeze(child);
      };
      freeze(snapshot);
      const turn = { ...resolved, snapshot };
      this.deps.backendProvider.turn = turn;
      this.deps.backendProvider.onPublicReasoning = (id, text, format) =>
        this.roundStore.reasoning(id, "executor", text, format);
      signal.throwIfAborted();
      if (!options?.inputContinuation)
        this.append({
          kind: "user",
          text,
          ...(options?.resume ? { resume: true } : {}),
        });
      for (const attachment of attachments) this.append(attachment);
      const messages: NeutralMessage[] =
        options?.inputContinuation?.messages ??
        this.record.flatMap((b): NeutralMessage[] => {
          if (b.kind === "user") return [{ role: "user", text: b.text }];
          if (b.kind === "herta" && b.surface === "speech")
            return [{ role: "assistant", text: b.text, toolCalls: [] }];
          if (b.kind === "system")
            return [
              {
                role: "user",
                text: `[Recorded tool/environment evidence]\n${b.body}\n${b.evidenceDetail ?? ""}`,
              },
            ];
          return [];
        });
      const adapter = createProtocolAdapter(
        snapshot.persona,
        resolved.personaKey,
      );
      const tool = {
        name: "delegate_execution",
        description:
          "Delegate file inspection, coding, commands and verification to the separately bound executor. Use at most once per user turn; quote no invented results.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      };
      // Answer continuation may dispatch new work using the recorded answer. Stored
      // calls are context only: we never re-execute them or resume a prior dispatch.
      let dispatched = false;
      if (options?.inputContinuation)
        messages.push({
          role: "tool",
          toolCallId: options.inputContinuation.callId,
          result: {
            ok: true,
            summary: JSON.stringify(options.inputContinuation.answer),
          },
        });
      let personaNativeContext: NativeContext | undefined;
      const personaTools =
        snapshot.persona.models.find(
          (model) => model.id === snapshot.bindings.persona.modelId,
        )?.capabilities.tools === "supported";
      if (options?.resume) {
        const beforeResume = this.record.length;
        const journalBefore =
          (await readDispatchJournal(this.deps.journalPath)) ?? [];
        let resumeFailed = true;
        try {
          this.record = await invokeBanzhuanBridge(this.record, [], {
            ...this.deps,
            signal,
            resume: true,
          });
          resumeFailed = false;
        } finally {
          this.record = this.deps.sink.flushedRecord() ?? this.record;
          const journalAfter =
            (await readDispatchJournal(this.deps.journalPath)) ?? [];
          const facts = buildRecoverySummary(
            journalBefore,
            journalAfter,
            signal.aborted,
          );
          const summary =
            resumeFailed && !signal.aborted
              ? { ...facts, state: "failed" as const }
              : facts;
          this.append({
            kind: "system",
            label: "系统",
            body: "恢复执行事实（由持久化工具记录生成；此前步骤不代表本次执行）",
            recoverySummary: summary,
            evidenceDetail: JSON.stringify(summary),
          });
        }
        messages.push({
          role: "user",
          text:
            "Continue from the recorded execution evidence. The RecoverySummary phases are authoritative: previously-completed means before this resume; resumed/new means this attempt; not-executed/uncertain never establish success. Do not describe prior work as newly executed. Do not repeat operations.\n" +
            this.record
              .slice(beforeResume)
              .map((b) =>
                b.kind === "system"
                  ? `${b.body}\n${b.evidenceDetail ?? ""}`
                  : "",
              )
              .join("\n"),
        });
        dispatched = true;
      }
      let searchRemaining = 3;
      for (let pass = 0; pass < 3; pass++) {
        const searchIds = new Set<string>();
        const calls: ToolCallRequest[] = [];
        let speech = "";
        const textPlan = !personaTools;
        let planText = "";
        this.deps.sink.beginHertaStream("speech");
        const usage = beginNeutralUsage(this.deps.usageLogPath, {
          sessionId: snapshot.sessionId,
          turnId: snapshot.turnId,
          protocol: snapshot.persona.protocol,
          modelId: snapshot.bindings.persona.modelId,
          role: "persona",
          baseURL: snapshot.persona.baseURL,
          providerId: snapshot.persona.id,
          providerRevision: snapshot.persona.revision,
        });
        try {
          for await (const event of adapter.stream({
            sessionId: snapshot.sessionId,
            turnId: snapshot.turnId,
            modelId: snapshot.bindings.persona.modelId,
            system:
              desktopPersonaIdentity(this.deps.lang) +
              " Delegate whenever the user needs project files, code changes, commands or tests. The executor has no persona role. After execution, report only the supplied evidence, failures and remaining work. Use request_user_input when required human decisions are missing, including when the executor reports missing information. Emit only one tool call per response. After an answer, use the supplied structured result; never repeat already completed execution. A provider HTTP error does not establish its cause: state the recorded failure without guessing causes, recommending repeated requests, or asking the user to remove or clean existing modifications. Do not use narration delimiters, completion prefill or hidden DeepSeek side services." +
              (textPlan
                ? ' For this planning response output only JSON {"execute": boolean, "reply": string, "questions"?: array}. execute=true requests the separate executor for the actual user task and cannot include questions. execute=false means conversational reply or asking for missing decisions. To ask, include 1-8 questions with {id, prompt, kind: "single"|"multiple"|"text", required: boolean, allowText: boolean, options: [{id,label,description?}]}; text questions have options:[], choice questions have 1-12 options. Questions pause the task until the human answers. Omit questions for ordinary replies. After execution use execute=false; do not repeat completed execution. This model is text-only: do not emit native tool calls.'
                : ""),
            messages: personaTools
              ? messages
              : messages.map((message): NeutralMessage => {
                  if (message.role === "tool")
                    return {
                      role: "user",
                      text: `[Structured result]\n${JSON.stringify(message.result)}`,
                    };
                  if (message.role === "assistant")
                    return { ...message, toolCalls: [] };
                  return message;
                }),
            tools: !personaTools
              ? []
              : dispatched
                ? [userInputTool]
                : [tool, userInputTool],
            options: {
              ...snapshot.persona.defaults,
              reasoningEffort: snapshot.bindings.persona.reasoningEffort,
              maxWebSearchUses: searchRemaining,
              webSearch: personaTools && snapshot.bindings.persona.webSearch === true && webSearchSupport(snapshot.persona, snapshot.bindings.persona.modelId),
            },
            signal,
            ...(personaTools &&
            ownedNativeContext(
              personaNativeContext,
              snapshot.persona,
              snapshot.bindings.persona.modelId,
            )
              ? { nativeContext: personaNativeContext }
              : {}),
          })) {
            if (event.type === "finished")
              personaNativeContext = ownedNativeContext(
                event.nativeContext,
                snapshot.persona,
                snapshot.bindings.persona.modelId,
              );
            if (event.type === "web-search") {
              if (event.status === "searching" && !searchIds.has(event.id)) {
                searchIds.add(event.id); searchRemaining = Math.max(0, searchRemaining - 1);
              }
              this.roundStore.search(event);
            }
            if (event.type === "usage") usage.record(event);
            if (event.type === "public-reasoning-delta")
              this.roundStore.reasoning(
                usage.requestId,
                "persona",
                event.text,
                event.format,
              );
            if (event.type === "text-delta") {
              if (textPlan) {
                planText += event.text;
                if (Buffer.byteLength(planText, "utf8") > 65536)
                  throw new Error("Text-only plan exceeds 64 KiB");
              } else {
                speech += event.text;
                this.deps.sink.streamHertaToken(event.text);
              }
            }
            if (
              event.type === "tool-call-ready" &&
              !calls.some((call) => call.id === event.call.id)
            )
              calls.push(event.call);
          }
          if (textPlan) {
            if (calls.length)
              throw new Error(
                "Text-only persona emitted unexpected native tools; no execution dispatched",
              );
            let plan: unknown;
            try {
              plan = JSON.parse(planText);
            } catch {
              throw new Error(
                "Text-only persona returned invalid dispatch JSON; no execution dispatched",
              );
            }
            if (
              !plan ||
              typeof plan !== "object" ||
              !("execute" in plan) ||
              !("reply" in plan) ||
              typeof plan.execute !== "boolean" ||
              typeof plan.reply !== "string" ||
              Object.keys(plan).some(
                (key) =>
                  key !== "execute" && key !== "reply" && key !== "questions",
              )
            )
              throw new Error(
                "Invalid text-only dispatch plan; no execution dispatched",
              );
            if ("questions" in plan) {
              if (plan.execute)
                throw new Error(
                  "Cannot ask questions and execute in the same plan",
                );
              const questions = validateQuestions(plan.questions);
              calls.push({
                id: `input-${randomUUID()}`,
                tool: userInputTool.name,
                input: { questions },
              });
            }
            speech = plan.reply;
            this.deps.sink.streamHertaToken(speech);
            if (plan.execute)
              calls.push({
                id: `dispatch-${snapshot.turnId}`,
                tool: tool.name,
                input: {},
              });
          }
        } finally {
          await usage.finish();
          this.deps.sink.endHertaStream();
          if (speech)
            this.append({ kind: "herta", surface: "speech", text: speech });
        }
        if (!calls.length) break;
        if (calls.length === 1 && calls[0]?.tool === userInputTool.name) {
          const call = calls[0];
          if (
            call.malformedArgs ||
            !call.input ||
            typeof call.input !== "object" ||
            Object.keys(call.input).some((key) => key !== "questions")
          )
            throw new Error("Invalid user input request");
          const questions = validateQuestions(
            (call.input as { questions?: unknown }).questions,
          );
          const request: PendingUserInput = {
            schemaVersion: 1,
            requestId: randomUUID(),
            sessionId: this.deps.sessionId,
            turnId: this.deps.turnId(),
            state: "waiting_for_input",
            questions,
          };
          messages.push({
            role: "assistant",
            text: personaTools
              ? speech
              : `${speech}\n${JSON.stringify({ questions })}`,
            toolCalls: calls,
          });
          this.inputJournal.write({
            request,
            messages,
            callId: call.id,
            dispatched,
          });
          this.appendSystemNote(
            "系统",
            `等待用户补充信息：\n${questions.map((question) => `${question.prompt}${question.options.length ? `\n可选：${question.options.map((option) => option.label).join("；")}` : ""}`).join("\n\n")}`,
          );
          outcome = "waiting";
          return this.record;
        }
        if (
          dispatched ||
          calls.length !== 1 ||
          calls[0]?.tool !== tool.name ||
          calls[0]?.malformedArgs ||
          typeof calls[0]?.input !== "object" ||
          calls[0]?.input === null ||
          Object.keys(calls[0].input).length !== 0
        )
          throw new Error(
            "Invalid persona delegation call; no execution dispatched",
          );
        dispatched = true;
        messages.push({
          role: "assistant",
          text: speech,
          toolCalls: personaTools ? calls : [],
        });
        const before = this.record.length;
        this.record = await invokeBanzhuanBridge(this.record, [], {
          ...this.deps,
          signal,
        });
        this.record = this.deps.sink.flushedRecord() ?? this.record;
        signal.throwIfAborted();
        const evidence = this.record
          .slice(before)
          .map((b) =>
            b.kind === "system" ? `${b.body}\n${b.evidenceDetail ?? ""}` : "",
          )
          .filter(Boolean)
          .join("\n");
        if (!personaTools)
          messages.push({
            role: "user",
            text: `[Actual executor evidence]\n${evidence || "No execution evidence returned. Do not claim success."}`,
          });
        else
          messages.push({
            role: "tool",
            toolCallId: calls[0].id,
            result: {
              ok: true,
              summary:
                evidence ||
                "Executor returned no evidence. Do not claim successful changes.",
            },
          });
      }
      return this.record;
    } catch (error) {
      outcome = signal.aborted ? "cancelled" : "failed";
      throw error;
    } finally {
      unsubscribe();
      this.roundStore.finish(outcome);
      this.deps.backendProvider.turn = null;
      delete this.deps.backendProvider.onPublicReasoning;
      resolved?.release?.();
    }
  }
}
