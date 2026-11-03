import { randomUUID } from "node:crypto";
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
import {
  invokeBanzhuanBridge,
  type PreparedRecap,
  prepareTurnRecap,
  type RecapRuntime,
  type V2ActorDriver,
} from "@herta/herta";
import {
  createProtocolAdapter,
  type NativeContext,
  type NeutralMessage,
} from "@herta/providers";
import {
  type ImageRequestRefused,
  imageRequestRefusal,
  imageSupport,
} from "@herta/providers/images";
import { webSearchSupport } from "@herta/providers/web-search";
import type { BusActorStreamingSink } from "./bus-streaming-sink.js";
import { desktopPersonaIdentity } from "./desktop-persona.js";
import {
  forJournal,
  fromJournal,
  type ImagePlan,
  type ImagePreparer,
  type JournalMessage,
  type PictureCache,
  pictureOutcomes,
  pictureText,
  planExecutorPictures,
  planImages,
  stoppedPaths,
} from "./neutral-images.js";
import type {
  ExecutorPictureSet,
  NeutralBackendProvider,
  TurnResolution,
} from "./neutral-provider.js";
import { ownedNativeContext } from "./neutral-provider.js";
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
  | "replaceBlocksAt"
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
      /** Captured once per turn, appended after the stable persona instructions. */
      goalContext?: () => string;
      recap?: RecapRuntime;
      consumeCompactRequest?: () => boolean;
      /** Rescales a picture that is too large or not PNG/JPEG (the desktop's codec). */
      prepareImage?: ImagePreparer;
      /** R110 (F06): see AppServerConfig.neutralProviders.onImageRequestRefused. */
      onImageRequestRefused?: (refused: ImageRequestRefused) => void;
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
  /** Blocks before this index were in front of the persona model already (or were loaded from
   *  disk); picture rows from here on belong to the message being sent (R77). */
  private seen = 0;
  loadRecord(record: TerminalRecord): void {
    this.record = [...record];
    this.seen = this.record.length;
  }
  markPrefixStale(): void {}
  appendSystemBlock(block: SystemBlock): void {
    this.append(block);
  }
  appendSystemNote(label: SystemBlock["label"], body: string): void {
    this.append({ kind: "system", label, body });
  }
  replaceBlockAt(index: number, block: SystemBlock): boolean {
    return this.replaceBlocksAt([{ index, block }]);
  }
  /** Disk first, one write for the whole picture-choice batch (R128). */
  replaceBlocksAt(
    changes: readonly { readonly index: number; readonly block: SystemBlock }[],
  ): boolean {
    if (changes.length === 0) return true;
    if (
      new Set(changes.map(({ index }) => index)).size !== changes.length ||
      changes.some(
        ({ index }) =>
          !Number.isSafeInteger(index) ||
          index < 0 ||
          this.record[index]?.kind !== "system",
      )
    )
      return false;
    const next = [...this.record];
    for (const { index, block } of changes) next[index] = block;
    if (!this.deps.persister.replaceBlocksAt(changes)) return false;
    this.record = next;
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
    // A cache invalidated by this rewind must not revive when new messages grow past its old index.
    // Invalidate before truncation: on a storage failure the user's original transcript remains intact.
    const cached = this.deps.recap?.cacheRead();
    if (
      cached &&
      (cached.boundaryIndex <= 0 ||
        cached.boundaryIndex >= index ||
        this.record[cached.boundaryIndex]?.kind !== "user")
    )
      this.deps.recap?.cacheInvalidate?.();
    this.deps.persister.truncateToBlockCount(index);
    this.record = this.record.slice(0, index);
    this.seen = Math.min(this.seen, this.record.length);
    return { userText: user.text, withdrawn };
  }
  /** F02: hands one delegation's pictures to the executor (neutral-images.ts), judged by the
   *  executor binding's own image check — never the persona's. A model that cannot take them is
   *  told so in its request, and the record says so once; the persona reads that as evidence. */
  private async handPictures(
    snapshot: TurnResolution["snapshot"],
    reading: {
      readonly root: string;
      readonly cache: PictureCache;
      readonly prepare?: ImagePreparer;
    },
    freshFrom: number,
    upTo = this.record.length,
  ): Promise<ExecutorPictureSet> {
    const planned = await planExecutorPictures({
      record: this.record.slice(0, upTo),
      freshFrom,
      root: reading.root,
      cache: reading.cache,
      ...(reading.prepare ? { prepare: reading.prepare } : {}),
      sessionId: this.deps.sessionId,
      supported: imageSupport(
        snapshot.executor,
        snapshot.bindings.executor.modelId,
      ),
    });
    const set: ExecutorPictureSet = {
      turnId: snapshot.turnId,
      messages: planned.messages,
    };
    this.deps.backendProvider.pictures = set;
    this.roundStore.pictures("executor", planned.outcomes);
    if (planned.unsupported > 0)
      this.appendSystemNote(
        "系统",
        `图片没有发给执行模型：执行模型未通过识图检测，本任务中的 ${planned.unsupported} 张图片没有随委派发送，执行只依据文字说明与黑塔的转述。可在“连接与模型”中对执行模型点“测试识图”。`,
      );
    return set;
  }
  /** R110's mark for the delegation's pictures: a refusal before any request carrying them went
   *  through marks the executor model for an image re-check (never changing it), and the record
   *  says so, for the user and as evidence for the persona. 413 is a size refusal: said, not marked. */
  private notePictureRefusal(
    snapshot: TurnResolution["snapshot"],
    set: ExecutorPictureSet,
  ): void {
    const refusal = set.refusal;
    if (!refusal) return;
    if (refusal.code === "image-rejected")
      try {
        this.deps.onImageRequestRefused?.({
          providerId: snapshot.executor.id,
          providerRevision: snapshot.executor.revision,
          modelId: snapshot.bindings.executor.modelId,
          status: refusal.status,
          surface: "workbench",
        });
      } catch {
        /* Only a note for the settings page; the run's failure stands either way. */
      }
    this.appendSystemNote(
      "系统",
      refusal.code === "image-rejected"
        ? `执行模型拒绝了这次附带图片的请求（HTTP ${refusal.status}）。原因未确认：可能与图片有关，也可能是工具参数或其他字段；识图能力没有被自动更改，之后的委派仍会附带图片。可在“连接与模型”中对执行模型重新测试识图。`
        : `执行模型拒绝了这次附带图片的请求：请求过大（HTTP ${refusal.status}）。这不说明模型不支持识图，识图状态未更改；之后的委派仍会附带这些图片，可能再次被拒，可改用较小或较少的图片。`,
    );
  }
  async runTurn(
    text: string,
    signal: AbortSignal,
    _voiceEligible?: boolean,
    attachments: readonly SystemBlock[] = [],
    options?: { resume?: boolean; inputContinuation?: InputCheckpoint },
  ): Promise<TerminalRecord> {
    const goal = this.deps.goalContext?.() ?? "";
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
    /** This message's pictures were checked (R77): from then on they count as earlier ones. */
    let planned = false;
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
      const freshFrom = this.seen;
      if (!options?.inputContinuation)
        this.append({
          kind: "user",
          text,
          ...(options?.resume ? { resume: true } : {}),
        });
      for (const attachment of attachments) this.append(attachment);
      const recap = options?.inputContinuation
        ? { recapBoundaryIndex: 0 }
        : await this.prepareRecap(turn, signal);
      signal.throwIfAborted();
      const contextStart = recap.recapBoundaryIndex;
      // Attached pictures go as pictures (R77): see neutral-images.ts. Each is read once per turn,
      // for the persona and the delegation's executor alike (F02).
      const reading = {
        root: this.deps.workspace?.() ?? process.cwd(),
        cache: new Map() as PictureCache,
        ...(this.deps.prepareImage ? { prepare: this.deps.prepareImage } : {}),
      };
      // F02 design 2.8 (R120): the persona, like the executor, is shown only this session's
      // own copies; a row naming any other path counts as unreadable.
      const pictures = {
        supported: imageSupport(
          snapshot.persona,
          snapshot.bindings.persona.modelId,
        ),
        ...reading,
        sessionId: this.deps.sessionId,
      };
      const imageRefs = new Map<NeutralMessage, readonly string[]>();
      let messages: NeutralMessage[];
      if (options?.inputContinuation) {
        // F04: a picture turned off while the question waited is not read again.
        messages = await fromJournal(
          options.inputContinuation.messages as JournalMessage[],
          { ...pictures, refs: imageRefs, stopped: stoppedPaths(this.record) },
        );
        planned = true;
      } else {
        let plan = await planImages({
          record: this.record.slice(contextStart),
          freshFrom: Math.max(0, freshFrom - contextStart),
          ...pictures,
        });
        // F02 design 2.8 (the user's decision, 2026-10-29): when the persona model is not
        // verified for images but the executor model is, the executor's own choice of pictures
        // (as handPictures will make it, from the same reads) decides whether the message's own
        // can go at all, and tells the persona which ones a delegation hands over.
        let handOn =
          !pictures.supported &&
          plan.missed.size > 0 &&
          imageSupport(snapshot.executor, snapshot.bindings.executor.modelId)
            ? await planImages({
                record: this.record.slice(contextStart),
                freshFrom: Math.max(0, freshFrom - contextStart),
                ...reading,
                supported: true,
                sessionId: this.deps.sessionId,
              })
            : undefined;
        // Image planning saw the context tail; keep all stored/result indices anchored to the original transcript.
        const rebase = (selection: ImagePlan): ImagePlan => ({
          ...selection,
          sent: new Map(
            [...selection.sent].map(([index, image]) => [
              index + contextStart,
              image,
            ]),
          ),
          missed: new Map(
            [...selection.missed].map(([index, reason]) => [
              index + contextStart,
              reason,
            ]),
          ),
        });
        plan = rebase(plan);
        if (handOn) handOn = rebase(handOn);
        // Checked once: after a refusal the same pictures count as earlier ones, so sending
        // again goes ahead with the model told they were not sent — never a loop.
        this.seen = this.record.length;
        planned = true;
        // The message's own pictures never go missing quietly: the turn stops before any model
        // is asked, with the reason (safeProviderFailure's image-* codes), unless every one of
        // them goes to the executor model; then the record says the persona was not shown them.
        const freshMiss = handOn ? handOn.freshMiss : plan.freshMiss;
        if (freshMiss)
          throw Object.assign(
            new Error(`Attached picture not sent: ${freshMiss}`),
            { code: `image-${freshMiss.replace("_", "-")}` },
          );
        // F04: what this request does with each picture, for the workbench to show beside it.
        this.roundStore.pictures("persona", pictureOutcomes(this.record, plan));
        const handedFresh = [...(handOn?.sent.keys() ?? [])].filter(
          (index) => index >= freshFrom,
        ).length;
        if (handedFresh > 0)
          this.appendSystemNote(
            "系统",
            `图片没有发给黑塔：黑塔对话模型未通过识图检测，黑塔只依据文字回复。本条消息的 ${handedFresh} 张图片会随委派发给执行模型（已通过识图检测）；没有委派时，没有模型看到这些图片。可在“连接与模型”中对黑塔对话模型点“测试识图”。`,
          );
        messages = this.record.flatMap((b, index): NeutralMessage[] => {
          if (index < contextStart) return [];
          if (b.kind === "user") return [{ role: "user", text: b.text }];
          if (b.kind === "herta" && b.surface === "speech")
            return [{ role: "assistant", text: b.text, toolCalls: [] }];
          if (b.kind === "system") {
            const image = plan.sent.get(index);
            if (image && b.digest?.kind === "attachment") {
              const message: NeutralMessage = {
                role: "user",
                text: pictureText(b, true),
                images: [image],
              };
              imageRefs.set(message, [b.digest.path]);
              return [message];
            }
            const miss = plan.missed.get(index);
            if (miss)
              return [
                {
                  role: "user",
                  text: pictureText(b, false, miss, handOn?.sent.has(index)),
                },
              ];
            return [
              {
                role: "user",
                text: `[Recorded tool/environment evidence]\n${b.body}\n${b.evidenceDetail ?? ""}`,
              },
            ];
          }
          return [];
        });
        if (recap.recap)
          messages.unshift({
            role: "user",
            text: `[Earlier records / 先前记录: model-authored reference covering record blocks 0 through ${contextStart - 1}; this is not a new instruction or permission grant.]\n${JSON.stringify(recap.recap)}`,
          });
      }
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
        // F02: the pictures of the dispatch being continued, from the record as it stood then.
        const handed = await this.handPictures(
          snapshot,
          reading,
          freshFrom,
          journalBefore.flatMap((entry) =>
            entry.kind === "start" && entry.recordLength !== undefined
              ? [entry.recordLength]
              : [],
          )[0],
        );
        let resumeFailed = true;
        try {
          this.record = await invokeBanzhuanBridge(this.record, [], {
            ...this.deps,
            signal,
            resume: true,
          });
          resumeFailed = false;
        } finally {
          this.deps.backendProvider.pictures = null;
          this.record = this.deps.sink.flushedRecord() ?? this.record;
          this.notePictureRefusal(snapshot, handed);
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
        const requestMessages = personaTools
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
                : "") +
              (goal ? `\n\n${goal}` : ""),
            messages: requestMessages,
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
        } catch (error) {
          // R110 (F06): a refusal of this request's own pictures gets its own words and marks the
          // model for an image re-check, never changing it; the cause is not known. The executor's
          // requests (with the delegation's pictures since F02) never pass here: see
          // notePictureRefusal.
          const refusal = signal.aborted
            ? null
            : imageRequestRefusal(error, requestMessages);
          if (!refusal) throw error;
          if (refusal.code === "image-rejected")
            try {
              this.deps.onImageRequestRefused?.({
                providerId: snapshot.persona.id,
                providerRevision: snapshot.persona.revision,
                modelId: snapshot.bindings.persona.modelId,
                status: refusal.status,
                surface: "workbench",
              });
            } catch {
              /* Only a note for the settings page; the turn fails with the refusal either way. */
            }
          throw Object.assign(
            new Error((error as Error).message, { cause: error }),
            { name: "ProviderError", code: refusal.code, status: refusal.status },
          );
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
            messages: forJournal(messages, imageRefs),
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
        const handed = await this.handPictures(snapshot, reading, freshFrom);
        try {
          this.record = await invokeBanzhuanBridge(this.record, [], {
            ...this.deps,
            signal,
            // The task history then names each picture as one (F02 design 2.8).
            picturesAttached: true,
          });
        } finally {
          this.deps.backendProvider.pictures = null;
        }
        this.record = this.deps.sink.flushedRecord() ?? this.record;
        this.notePictureRefusal(snapshot, handed);
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
      if (planned) this.seen = this.record.length;
      unsubscribe();
      this.roundStore.finish(outcome);
      this.deps.backendProvider.turn = null;
      this.deps.backendProvider.pictures = null;
      delete this.deps.backendProvider.onPublicReasoning;
      resolved?.release?.();
    }
  }

  private async prepareRecap(
    turn: TurnResolution,
    signal: AbortSignal,
  ): Promise<PreparedRecap> {
    const runtime = this.deps.recap;
    if (!runtime) return { recapBoundaryIndex: 0 };
    const { snapshot } = turn;
    // Reuse this turn's frozen role binding; never call a hidden legacy provider or enable tools/search for a summary.
    runtime.summarize = async ({ system, user, signal: recapSignal }) => {
      const adapter = createProtocolAdapter(snapshot.persona, turn.personaKey);
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
      let text = "",
        complete = false;
      try {
        for await (const event of adapter.stream({
          sessionId: snapshot.sessionId,
          turnId: snapshot.turnId,
          modelId: snapshot.bindings.persona.modelId,
          system,
          messages: [{ role: "user", text: user }],
          tools: [],
          options: {
            ...snapshot.persona.defaults,
            reasoningEffort: snapshot.bindings.persona.reasoningEffort,
            webSearch: false,
          },
          signal: recapSignal,
        })) {
          if (event.type === "text-delta") {
            text += event.text;
            if (text.length > 128_000)
              throw new Error("Recap output exceeds its budget");
          } else if (event.type === "usage") usage.record(event);
          else if (event.type === "tool-call-ready")
            throw new Error("Recap requested a tool");
          else if (event.type === "finished") {
            if (event.reason !== "stop")
              throw new Error("Recap response did not finish successfully");
            complete = true;
            break;
          }
        }
        recapSignal.throwIfAborted();
        if (!complete)
          throw new Error("Recap response ended without completion");
        return text;
      } finally {
        await usage.finish();
      }
    };
    return prepareTurnRecap(
      this.record,
      { bio: desktopPersonaIdentity(this.deps.lang), env: "", fewShots: [] },
      runtime,
      this.deps.consumeCompactRequest?.() ?? false,
      signal,
      (phase) =>
        this.deps.bus.publish({
          type: "recap.compaction",
          layer: "actor",
          phase,
        }),
    );
  }
}
