import { expect, it } from "vitest";
import { imageSupport, validateMessageImage } from "./images.js";
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
