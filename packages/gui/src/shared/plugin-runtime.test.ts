import { describe, expect, it } from "vitest";
import { parseExecutablePluginManifest } from "./executable-plugins.js";
import { isPluginRunResult, parsePluginJson, PLUGIN_RUNTIME_LIMITS, validatePluginActionInput } from "./plugin-runtime.js";

const action = parseExecutablePluginManifest(JSON.stringify({schemaVersion:2,apiVersion:1,id:"example.runtime",name:"Runtime",version:"1.0.0",description:"",entry:"main.js",capabilities:[],actions:[{id:"run",title:"Run",scope:"both",export:"run",capabilities:[],inputs:[
  {id:"text",label:"Text",type:"text",required:true,maxLength:10},
  {id:"choice",label:"Choice",type:"select",required:false,options:["a","b"],default:"a"},
  {id:"amount",label:"Amount",type:"number",required:false,min:0,max:3,integer:true},
  {id:"check",label:"Check",type:"boolean",required:false,default:false},
]}]})).actions[0]!;

describe("plugin runtime boundary", () => {
  it("owns and freezes nested data; never reflects caller objects", () => {
    let invoked=false;
    expect(()=>parsePluginJson(new Proxy({}, {get(){invoked=true;throw Error();}}),1024)).toThrow();
    expect(invoked).toBe(false);
    const value = parsePluginJson('{"a":[{"b":1}]}',1024) as any;
    expect(Object.getPrototypeOf(value)).toBeNull();
    expect(Object.isFrozen(value.a[0])).toBe(true);
  });
  it.each(['{"__proto__":1}','{"constructor":1}','{"prototype":1}','1e999','{"a":}','[1,]'])('rejects invalid or dangerous data %s',text=>{
    expect(()=>parsePluginJson(text,1024)).toThrow();
  });
  it("counts UTF8 bytes and bounds nesting/node counts", () => {
    expect(()=>parsePluginJson('"黑塔"',5)).toThrow();
    expect(()=>parsePluginJson('['.repeat(14)+'0'+']'.repeat(14),1024)).toThrow();
    expect(()=>parsePluginJson(JSON.stringify(Array(8193).fill(0)),32768)).toThrow();
  });
  it("validates actual input and applies declared defaults without coercion", () => {
    expect(JSON.parse(validatePluginActionInput(action,'{"text":"测试","amount":0}'))).toEqual({text:"测试",choice:"a",amount:0,check:false});
  });
  it.each(['{}','{"text":" "}','{"text":"abcdefghijk"}','{"text":"ok","amount":1.5}','{"text":"ok","amount":4}','{"text":"ok","check":"false"}','{"text":"ok","choice":"c"}','{"text":"ok","extra":1}','{"text":null}','[]'])('denies invalid input %s',text=>{
    expect(()=>validatePluginActionInput(action,text)).toThrow();
  });
  it("bounds the aggregate of injected defaults", () => {
    const large={...action,inputs:Array.from({length:3},(_,i)=>({id:`field${i}`,label:"",type:"text" as const,required:false,maxLength:16000,default:"x".repeat(16000)}))};
    expect(()=>validatePluginActionInput(large,'{}')).toThrow();
  });
  it("rejects malformed and oversized result envelopes", () => {
    expect(isPluginRunResult({ok:true,valueJson:'{"a":1}'})).toBe(true);
    expect(isPluginRunResult({ok:false,code:"cancelled"})).toBe(true);
    expect(isPluginRunResult({ok:false,code:"raw private failure"})).toBe(false);
    expect(isPluginRunResult({ok:true,valueJson:'{}',identity:"forged"})).toBe(false);
    expect(isPluginRunResult({ok:true,valueJson:JSON.stringify("x".repeat(PLUGIN_RUNTIME_LIMITS.outputBytes))})).toBe(false);
    expect(isPluginRunResult({ok:true,valueJson:'{"__proto__":1}'})).toBe(false);
  });
});
