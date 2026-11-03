import {expect,it,vi} from "vitest";
import {createProtocolAdapter} from "./protocols/index.js";
import {deepSeekSearchInput,webSearchSupport} from "./web-search.js";
import type {ModelRequest,ProviderConfig,ModelEvent,NeutralMessage} from "./contracts.js";
const config:ProviderConfig={id:"test",name:"test",protocol:"openai-chat-completions",baseURL:"https://api.deepseek.com",authentication:"api-key",credentialRef:"test",allowRemoteHTTP:false,models:[],defaults:{model:"deepseek-flash",timeoutMs:3000},revision:1};
// Legacy model IDs keep the R40 pre-search; deepseek-flash/v4-pro use model-driven tools (deepseek-web-tools.test.ts).
const request=():ModelRequest=>({sessionId:"s",turnId:"t",modelId:"deepseek-chat",system:"persona",messages:[{role:"user",text:"最新消息"}],tools:[],options:{webSearch:true},signal:new AbortController().signal});
const completion=()=>new Response('data: '+JSON.stringify({choices:[{index:0,delta:{content:"answer"},finish_reason:"stop"}]})+'\n\ndata: [DONE]\n\n',{headers:{"content-type":"text/event-stream"}});
async function collect(r:ModelRequest,fetcher:typeof fetch,c=config){const events:ModelEvent[]=[];for await(const e of createProtocolAdapter(c,"test-key",{fetch:fetcher}).stream(r))events.push(e);return events;}
it("searches the official endpoint with bearer auth then supplies bounded untrusted references to the model",async()=>{
 const calls:{url:string;body:any;headers:any}[]=[];const fetcher=vi.fn(async(url:any,init:any)=>{calls.push({url:String(url),body:JSON.parse(init.body),headers:init.headers});return String(url).endsWith('/tools/search')?Response.json({results:[{title:"资料",url:"https://example.com/news",summary:"最新资料"},{url:"javascript:evil",summary:"bad"}]}):completion();}) as typeof fetch;
 const events=await collect(request(),fetcher);expect(calls[0]).toMatchObject({url:"https://api.deepseek.com/v1/tools/search",body:{query:"最新消息",ori_question:"最新消息",count:5,need_content:false},headers:{Authorization:"Bearer test-key"}});
 expect(calls[1]?.body.tools).toBeUndefined();
 expect(calls[1]?.body.messages[0].content).toContain("untrusted reference material");expect(calls[1]?.body.messages[0].content).toContain("https://example.com/news");expect(calls[1]?.body.messages[0].content).not.toContain("javascript:");
 expect(events.filter(e=>e.type==="web-search")).toHaveLength(2);expect(events.at(-1)?.type).toBe("finished");
});
it("does not search when disabled, exhausted, or processing tool continuations",async()=>{
 for(const r of [{...request(),options:{webSearch:false}},{...request(),options:{webSearch:true,maxWebSearchUses:0}},{...request(),messages:[{role:"assistant" as const,text:"done",toolCalls:[]}]}]){const f=vi.fn(async()=>completion()) as typeof fetch;await collect(r,f);expect(f).toHaveBeenCalledTimes(1);}
});
it("bounds Unicode queries and handles empty search results without inventing sources",async()=>{
 const f=vi.fn(async(url:any,init:any)=>{if(String(url).endsWith('/search')){expect(Array.from(JSON.parse(init.body).query)).toHaveLength(128);return Response.json({results:[]});}return completion();}) as typeof fetch;
 const events=await collect({...request(),messages:[{role:"user",text:"🌌".repeat(130)}]},f);expect(events.find(e=>e.type==="web-search"&&e.status==="completed")).toMatchObject({sources:[]});
});
it("cleans code from the query, keeps the user's wording as ori_question, and gives short follow-ups the previous topic",()=>{
 const code="这个报错怎么修？\n```ts\nconst x: number = \"a\";\n```\n见 `tsc` 输出";
 expect(deepSeekSearchInput([{role:"user",text:code}])).toEqual({query:"这个报错怎么修？ 见 输出",original:code});
 const history:NeutralMessage[]=[{role:"user",text:"DeepSeek V4 发布了哪些新功能"},{role:"assistant",text:"……",toolCalls:[]},{role:"user",text:"那它的价格呢？"}];
 expect(deepSeekSearchInput(history)).toEqual({query:"那它的价格呢？ DeepSeek V4 发布了哪些新功能",original:"那它的价格呢？"});
 const long="请比较 DeepSeek V4 与上一代在长上下文和工具调用上的差异";expect(deepSeekSearchInput([...history.slice(0,2),{role:"user",text:long}])?.query).toBe(long);
 expect(Array.from(deepSeekSearchInput([{role:"user",text:"x".repeat(200)},{role:"user",text:"价格？"}])!.query)).toHaveLength(128);
 expect(deepSeekSearchInput(history.slice(0,2))).toBeNull();
});
it("answers without search after a search failure and asks the model to say so",async()=>{
 for(const searchFailure of [()=>Response.json({error:{type:"server_error"}},{status:500}),()=>{throw new TypeError("fetch failed");},()=>Response.json({unexpected:true})]){
  const calls:{url:string;body:any}[]=[];const f=vi.fn(async(url:any,init:any)=>{calls.push({url:String(url),body:JSON.parse(init.body)});return String(url).endsWith("/tools/search")?searchFailure():completion();}) as typeof fetch;
  const events=await collect(request(),f);
  expect(events.flatMap(e=>e.type==="web-search"?[e.status]:[])).toEqual(["searching","failed"]);
  expect(calls).toHaveLength(2);expect(calls[0]?.body).toMatchObject({query:"最新消息",ori_question:"最新消息"});
  expect(calls[1]?.body.messages[0].content).toContain("web search was unavailable");expect(calls[1]?.body.messages[0].content).not.toContain("Web search data");
  expect(events.at(-1)?.type).toBe("finished");
 }
});
it("gives a stalled search its own deadline and still answers",async()=>{
 const f=vi.fn((url:any,init:any)=>String(url).endsWith("/tools/search")?new Promise<Response>((_,reject)=>init.signal.addEventListener("abort",()=>reject(init.signal.reason))):Promise.resolve(completion())) as typeof fetch;
 const events=await collect(request(),f,{...config,defaults:{...config.defaults,timeoutMs:400}});
 expect(events.some(e=>e.type==="web-search"&&e.status==="failed")).toBe(true);expect(events.at(-1)?.type).toBe("finished");expect(f).toHaveBeenCalledTimes(2);
});
it("still stops the turn on an invalid key or a user cancellation during search",async()=>{
 const f=vi.fn(async()=>Response.json({error:{type:"authentication_error"}},{status:401})) as typeof fetch;
 await expect(collect(request(),f)).rejects.toThrow();expect(f).toHaveBeenCalledTimes(1);
 const controller=new AbortController();const g=vi.fn((_url:any,init:any)=>new Promise<Response>((_,reject)=>{init.signal.addEventListener("abort",()=>reject(init.signal.reason));setTimeout(()=>controller.abort(),10);})) as typeof fetch;
 await expect(collect({...request(),signal:controller.signal},g)).rejects.toThrow();expect(g).toHaveBeenCalledTimes(1);
});
it("rejects unauthorised endpoints and malformed budgets before search; does not retry billing failures",async()=>{
 for(const baseURL of ["https://api.deepseek.com.evil","https://api.deepseek.com/anthropic","https://api.deepseek.com:444"]){expect(webSearchSupport({...config,baseURL},"deepseek-flash")).toBe(false);}
 expect(webSearchSupport({...config,baseURL:"https://api.deepseek.com/v1"},"deepseek-flash")).toBe(true);
 const f=vi.fn(async()=>Response.json({error:{type:"insufficient_balance"}},{status:402})) as typeof fetch;
 await expect(collect({...request(),options:{webSearch:true,maxWebSearchUses:4}},f)).rejects.toThrow();expect(f).not.toHaveBeenCalled();
 await expect(collect(request(),f)).rejects.toThrow();expect(f).toHaveBeenCalledTimes(1);
});
