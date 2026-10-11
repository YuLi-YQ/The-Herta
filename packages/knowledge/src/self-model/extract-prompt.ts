import type { AntiPattern } from "../schema.js";
import type { CandidateCategory } from "./schema.js";

export interface BuildExtractionPromptInput {
  filename: string;
  category: CandidateCategory;
  cleanedText: string;
  antiPatterns: ReadonlyArray<AntiPattern>;
}

export interface ExtractionPrompt {
  systemPrompt: string;
  userPayload: string;
}

const SYSTEM_PROMPT_HEADER = `你的任务是从一份《崩坏：星穹铁道》canon 文档中提取关于「真黑塔」(大黑塔, 天才俱乐部 #83 的真身——不是 人偶/doll 黑塔) 的事实, 并附上文档内的引用证据。

关键身份区分 (贯穿每条 fact):
- 大黑塔 / The Herta / "本人" / "我" → 空间站上的真身长寿生物科学家, 是说话的主体。
- 黑塔 / 小黑塔 / "人偶" / "the doll" / "the puppet" → 她遥控派出的人偶舰队, **不是她本人**。
- 空间站「黑塔」 → 她的工坊/空间站, 是她拥有的物体。
- "Madam Herta" (IPC 高管) → 完全不同的人, 不要混淆。

如果某条事实是关于人偶 (puppet, 不是本人) 的, 标记 kind: "relationship", prose 内框架为 "doll-fleet" 或 "the puppet" — **不要**标记为 "embodiment" (那个槽位是给真黑塔的工坊/身体/站留的)。`;

const SYSTEM_PROMPT_SCHEMA = `输出 SCHEMA (只输出 JSON, 无 prose preamble, 无 markdown 围栏):
{
  "source": "<filename>",
  "facts": [
    {
      "kind": "biography" | "philosophy" | "embodiment" | "relationship" | "harness_proprioception" | "anti_pattern" | "interaction_register",
      "prose": "原子级事实陈述, 用中文写, 后续合成时会改为第一人称",
      "evidence_excerpt": "源文档的逐字引用 (≤150 字符)",
      "confidence": "high" | "medium" | "low"
    }
  ]
}

约束 (严格遵守):
- 只提取**直接 grounded 在文档里**的事实。**不要**推断、外推、或编造没有原文支撑的声明。
- 如果文档没有有意义地提到黑塔, 返回 { "source": "<filename>", "facts": [] } — 空 facts 数组, 不要省略字段。
- 如果某条候选事实**违反** anti-patterns (例如暗示黑塔会礼貌地回 "你好"), 标记 confidence: "low" 并在 evidence_excerpt 里说明文档为何支持这个偏离。**绝大多数违反都是误读** — 优先省略, 不要硬塞。
- evidence_excerpt 必须是源文档的**逐字子串** (≤150 字符), 不要改写, 不要翻译。
- **prose 字段用中文写**。技术术语 (如 "Emanator", "Nous", "Erudition", "Simulated Universe") 可以保留英文。
- 只输出 JSON。无 prose preamble, 无 markdown 围栏 (绝对不要包 \`\`\`json), 无解释性文字。`;

function formatAntiPatterns(antiPatterns: ReadonlyArray<AntiPattern>): string {
  if (antiPatterns.length === 0) {
    return "ANTI-PATTERNS (黑塔不会做的事): (无)";
  }
  const lines: string[] = [
    "ANTI-PATTERNS (黑塔不会做的事, 来自验证过的 voice 证据):",
  ];
  for (const ap of antiPatterns) {
    lines.push(`- ${ap.pattern}`);
    lines.push(`  rationale: ${ap.rationale}`);
  }
  return lines.join("\n");
}

export function buildExtractionPrompt(
  input: BuildExtractionPromptInput,
): ExtractionPrompt {
  const systemPrompt = [
    SYSTEM_PROMPT_HEADER,
    "",
    formatAntiPatterns(input.antiPatterns),
    "",
    SYSTEM_PROMPT_SCHEMA,
  ].join("\n");

  const userPayload = JSON.stringify(
    {
      filename: input.filename,
      category: input.category,
      content: input.cleanedText,
    },
    null,
    2,
  );

  return { systemPrompt, userPayload };
}
