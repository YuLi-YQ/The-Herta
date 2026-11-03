import { expect, it } from "vitest";
import { imageRequestRefusal, imageSupport, validateMessageImage } from "./images.js";
import { ProviderError } from "./errors.js";
import { encode } from "./protocols/encode.js";
import type { ModelRequest, ProviderConfig } from "./contracts.js";
const image = { mimeType: "image/png" as const, data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=" };
const base: ProviderConfig = { id:"p",name:"test",protocol:"openai-responses",baseURL:"https://api.openai.com/v1",authentication:"api-key",credentialRef:"x",allowRemoteHTTP:false,models:[],defaults:{model:"gpt-4.1",timeoutMs:3000},revision:1 };
const request: ModelRequest = {sessionId:"s",turnId:"t",modelId:"gpt-4.1",system:"test",messages:[{role:"user",text:"Read image",images:[image]}],tools:[],options:{},signal:new AbortController().signal};
it("encodes images into distinct multimodal blocks for all three protocols",()=>{
 const responses = encode(request,base) as any;
 expect(responses.input[0].content[1]).toEqual({type:"input_image",image_url:`data:image/png;base64,${image.data}`,detail:"auto"});
 const chat = encode(request,{...base,protocol:"openai-chat-completions"}) as any;
 expect(chat.messages[1].content[1].image_url.url).toContain(image.data);
 const anthropic = encode({...request,modelId:"claude-sonnet-4-20250514"},{...base,protocol:"anthropic-messages",baseURL:"https://api.anthropic.com"}) as any;
 expect(anthropic.messages[0].content[1]).toEqual({type:"image",source:{type:"base64",media_type:"image/png",data:image.data}});
});
it("refuses unsupported endpoints/models and excessive image context",()=>{
 for(const baseURL of ["https://proxy.example/v1","https://api.deepseek.com","http://api.openai.com","https://api.openai.com/other"]){expect(imageSupport({...base,baseURL},"gpt-4.1")).toBe(false);expect(()=>encode(request,{...base,baseURL})).toThrow();}
 expect(imageSupport(base,"unknown")).toBe(false);
 expect(()=>encode({...request,messages:[{role:"user",text:"x",images:Array(9).fill(image)}]},base)).toThrow();
});
it("rejects URLs, false mime, oversized and malformed payloads",()=>{
 expect(validateMessageImage(image)).toEqual(image);
 for(const i of [{...image,data:"https://example.com/x"},{...image,mimeType:"image/svg+xml"},{...image,data:"A".repeat(2796208)},{...image,data: "A".repeat(20)}]) expect(()=>validateMessageImage(i)).toThrow();
});
it("leaves text-only wire content unchanged",()=>{
 const body=encode({...request,messages:[{role:"user",text:"hello"}]},base) as any;
 expect(body.input).toEqual([{role:"user",content:"hello"}]);
});
it("admits a custom endpoint's model only after an image probe on it passed (R77)",()=>{
 const custom = {...base,baseURL:"https://proxy.example/v1",protocol:"openai-chat-completions" as const};
 const model = (images:"unknown"|"supported"|"unsupported") => ({...custom,models:[{id:"vision-x",source:"manual" as const,capabilities:{streaming:"supported" as const,tools:"supported" as const,images,reasoning:"unknown" as const},validation:{state:"tools-available" as const,protocol:"openai-chat-completions" as const,providerRevision:1}}]});
 // Text and tool validation say nothing about pictures.
 expect(imageSupport(model("unknown"),"vision-x")).toBe(false);
 expect(imageSupport(model("unsupported"),"vision-x")).toBe(false);
 expect(()=>encode({...request,modelId:"vision-x"},model("unknown"))).toThrow();
 expect(imageSupport(model("supported"),"vision-x")).toBe(true);
 expect(imageSupport(model("supported"),"other-model")).toBe(false);
 const chat = encode({...request,modelId:"vision-x"},model("supported")) as any;
 expect(chat.messages[1].content[1].image_url.url).toContain(image.data);
});
// R110 (F06): a refusal is told apart only by local facts — these messages carried pictures — and the status.
const http = (status: number, message = `Provider HTTP ${status}`) => new ProviderError({code:"http",status,message,retryable:false});
const withImage = request.messages, textOnly = [{role:"user" as const,text:"hello"},{role:"assistant" as const,text:"hi",toolCalls:[]}];
it.each([400,415,422])("marks HTTP %i on a request with pictures as an unexplained refusal of it",(status)=>{
 expect(imageRequestRefusal(http(status),withImage)).toEqual({code:"image-rejected",status});
 // Duck-typed like turnErrorPayload, so a provider wrapper keeps working.
 expect(imageRequestRefusal({code:"http",status},withImage)).toEqual({code:"image-rejected",status});
});
it("says 413 is about size, not capability",()=>{
 expect(imageRequestRefusal(http(413),withImage)).toEqual({code:"image-too-large",status:413});
});
it.each([401,402,403,404,408,409,429,500,502,503,504])("leaves HTTP %i on a request with pictures to its usual words",(status)=>{
 expect(imageRequestRefusal(http(status),withImage)).toBeNull();
});
it("leaves timeouts, transport, stream, tool and cancel failures alone even with pictures",()=>{
 for(const error of [new ProviderError({code:"stall",message:"Provider request timed out",retryable:false}),new ProviderError({code:"network",message:"x",retryable:false}),new ProviderError({code:"network-tls",message:"x",retryable:false}),new ProviderError({code:"sse",message:"x",retryable:false}),new ProviderError({code:"tool-json",message:"x",retryable:false}),Object.assign(new Error("aborted"),{name:"AbortError"}),{code:"tool-schema",status:400},{status:400},null,undefined,"Provider HTTP 400"])
  expect(imageRequestRefusal(error,withImage)).toBeNull();
});
it("never marks a request without pictures, whatever the status",()=>{
 for(const status of [400,413,415,422]){
  expect(imageRequestRefusal(http(status),textOnly)).toBeNull();
  expect(imageRequestRefusal(http(status),[{role:"user",text:"x",images:[]}])).toBeNull();
 }
 expect(imageRequestRefusal(http(400),[])).toBeNull();
});
it("does not read the remote body: its words neither make nor unmake a refusal",()=>{
 expect(imageRequestRefusal(http(500,"Provider HTTP 500 (code=image_not_supported; param=messages[0].content[1])"),withImage)).toBeNull();
 expect(imageRequestRefusal(http(400,"Provider HTTP 400 (code=invalid_tool_schema; param=tools[0])"),withImage)).toEqual({code:"image-rejected",status:400});
});
