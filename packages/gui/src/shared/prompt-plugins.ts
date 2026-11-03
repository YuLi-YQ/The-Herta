/** Validation failure; `path` locates the field inside the plugin file without echoing its content. */
export class PluginFault extends Error {
 constructor(readonly reason: string, readonly path: string[] = []) { super(path.length ? `${path.join(" · ")}：${reason}` : reason); }
}
/** Data-only prompt extensions: no executable content or implicit context. */
export type PluginScope = "chat" | "workbench" | "both";
export interface PromptInput { id: string; label: string; type: "text" | "select"; required: boolean; default?: string; options?: string[] }
export interface PromptAction { id: string; title: string; scope: PluginScope; prompt: string; inputs: PromptInput[] }
export interface PromptManifest { schemaVersion: 1; id: string; name: string; version: string; description: string; actions: PromptAction[] }
export interface PromptPlugin { manifest: PromptManifest; enabled: boolean; contentHash: string; installedAt: string; updatedAt: string }
export interface PluginSnapshot { revision: number; items: PromptPlugin[]; damaged?: boolean }
export type PluginRequest = { kind: "discard"; previewId: string } | { kind: "list" | "preview" | "restore" | "reset" } | { kind: "install"; previewId: string; revision: number } | { kind: "enable"; id: string; enabled: boolean; revision: number } | { kind: "remove"; id: string; revision: number } | { kind: "prepare"; id: string; actionId: string; contentHash: string; scope: "chat" | "workbench"; values: Record<string,string> };
export type PluginReply = { ok: true; snapshot: PluginSnapshot; preview?: { id: string; manifest: PromptManifest; existing?: PromptPlugin; identical: boolean }; text?: string } | { ok: false; message: string };
const ID=/^[a-z][a-z0-9.-]{2,79}$/, PLACEHOLDER=/\{\{([a-z][a-z0-9.-]{2,79})\}\}/g;
function within<T>(place: string, run: () => T): T {
 try{return run();}catch(e){if(e instanceof PluginFault)throw new PluginFault(e.reason,[place,...e.path]);throw e;}
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
 if (!value || typeof value !== "object" || Array.isArray(value)) throw new PluginFault("应为 JSON 对象。");
 const unknown=Object.keys(value).find(k=>!keys.includes(k));
 if(unknown!==undefined)throw new PluginFault(`不支持字段“${unknown.slice(0,40)}”；可用字段：${keys.join("、")}。`);
 return value as Record<string, unknown>;
}
function str(v: unknown, max: number, empty=false): string {
 if(typeof v!=="string")throw new PluginFault(v===undefined?"缺少此字段。":"应为文字。");
 if(v.length>max)throw new PluginFault(`不能超过 ${max} 个字符。`);
 if(!empty&&!v.trim())throw new PluginFault("不能为空。");return v;
}
function id(v: unknown): string {const s=str(v,80);if(!ID.test(s))throw new PluginFault("需为 3–80 个字符，以小写英文字母开头，只含小写字母、数字、点和短横线。");return s;}
function duplicate(ids: string[]): string|undefined {return ids.find((x,k)=>ids.indexOf(x)!==k);}
function ordinal(kind: string, n: number, raw: unknown): string {const rawId=(raw as {id?:unknown}|null)?.id;return `第${n+1}个${kind}`+(typeof rawId==="string"&&ID.test(rawId)?`（${rawId}）`:"");}
export function parsePromptManifest(raw: unknown): PromptManifest {
 const o=object(raw,["schemaVersion","id","name","version","description","actions"]);
 if(o.schemaVersion!==1)throw new PluginFault("必须为 1。",["schemaVersion"]);
 const pluginId=within("id",()=>id(o.id)),name=within("name",()=>str(o.name,80));
 const version=within("version",()=>{const v=str(o.version,40);if(!/^\d+\.\d+\.\d+$/.test(v))throw new PluginFault("需为三段数字，如 1.0.0。");return v;});
 const description=within("description",()=>str(o.description,500,true));
 if(!Array.isArray(o.actions)||o.actions.length<1||o.actions.length>20)throw new PluginFault("需要 1–20 个动作。",["actions"]);
 const actions=o.actions.map((rawAction,n)=>within(ordinal("动作",n,rawAction),()=>{
  const a=object(rawAction,["id","title","scope","prompt","inputs"]);
  const actionId=within("id",()=>id(a.id)),title=within("title",()=>str(a.title,80));
  if(!["chat","workbench","both"].includes(a.scope as string))throw new PluginFault("只能是 chat、workbench 或 both。",["scope"]);
  if(!Array.isArray(a.inputs)||a.inputs.length>8)throw new PluginFault("需为最多 8 个参数的数组；没有参数时写 []。",["inputs"]);
  const inputs=a.inputs.map((rawInput,m)=>within(ordinal("参数",m,rawInput),()=>{
   const i=object(rawInput,["id","label","type","required","default","options"]);
   const inputId=within("id",()=>id(i.id)),label=within("label",()=>str(i.label,80));
   if(!["text","select"].includes(i.type as string))throw new PluginFault("只能是 text 或 select。",["type"]);
   if(typeof i.required!=="boolean")throw new PluginFault("应为 true 或 false。",["required"]);
   const input:PromptInput={id:inputId,label,type:i.type as PromptInput["type"],required:i.required};
   if(i.default!==undefined)input.default=within("default",()=>str(i.default,4000,true));
   if(input.type==="select") {
    if(!Array.isArray(i.options)||i.options.length<1||i.options.length>20)throw new PluginFault("选择参数需要 1–20 个选项。",["options"]);
    input.options=i.options.map((x,k)=>within("options",()=>within(`第${k+1}项`,()=>str(x,200))));
    if(duplicate(input.options)!==undefined)throw new PluginFault("选项不能重复。",["options"]);
    if(input.default!==undefined&&!input.options.includes(input.default))throw new PluginFault("默认值必须是选项之一。",["default"]);
   } else if(i.options!==undefined)throw new PluginFault("文本参数不能包含选项。",["options"]);
   return input;
  }));
  const repeatedInput=duplicate(inputs.map(x=>x.id));if(repeatedInput)throw new PluginFault(`参数标识“${repeatedInput}”重复。`,["inputs"]);
  const prompt=within("prompt",()=>{
   const text=str(a.prompt,16000);
   const remaining=text.replace(PLACEHOLDER,(_,key:string)=>{if(!inputs.some(i=>i.id===key))throw new PluginFault(`引用了未定义参数 {{${key}}}；请在 inputs 中定义，或删除此占位符。`);return "";});
   if(remaining.includes("{{")||remaining.includes("}}"))throw new PluginFault("占位符只能写成 {{参数id}}，不能含空格；其他位置不能出现 {{ 或 }}。");
   return text;
  });
  return {id:actionId,title,scope:a.scope as PluginScope,prompt,inputs};
 }));
 const repeatedAction=duplicate(actions.map(a=>a.id));if(repeatedAction)throw new PluginFault(`动作标识“${repeatedAction}”重复。`,["actions"]);
 return {schemaVersion:1,id:pluginId,name,version,description,actions};
}
export function renderPrompt(action: PromptAction, raw: unknown): string {
 const values=object(raw,action.inputs.map(x=>x.id)), safe=new Map<string,string>();
 for(const input of action.inputs){const value=str(values[input.id]??input.default??"",4000,true);if(input.required&&!value.trim())throw new PluginFault("请填写所有必填参数。");if(input.type==="select"&&value&&!input.options!.includes(value))throw new PluginFault("请选择有效选项。");safe.set(input.id,value);}
 const text=action.prompt.replace(PLACEHOLDER,(_,key:string)=>safe.get(key)??"");
 if(text.length>32000)throw new PluginFault("生成的草稿超过长度限制。");return text;
}
