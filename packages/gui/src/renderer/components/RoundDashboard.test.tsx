import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { RoundDashboard } from "./RoundDashboard.js";
it("does not invent missing usage or context percentage",()=>{
 render(<RoundDashboard rounds={[]} metrics={null}/>);
 expect(screen.getByText("用量 -- tok")).toBeInTheDocument();
 expect(screen.getByText("上下文 --")).toBeInTheDocument();
});
it("shows actual zero usage but requires a known context window",()=>{
 render(<RoundDashboard rounds={[]} metrics={{totalTokens:0,cacheHitRate:0,outputTokensPerSecond:null,contextUsed:123,contextWindow:null,partial:false}}/>);
 expect(screen.getByText("用量 0 tok")).toBeInTheDocument();
 expect(screen.getByText("缓存 0%")).toBeInTheDocument();
 expect(screen.getByText("上下文 --")).toBeInTheDocument();
});
