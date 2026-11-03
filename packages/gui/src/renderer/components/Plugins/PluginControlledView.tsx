import { useId } from "react";
import type { PluginControlledView as ControlledViewData, PluginViewTone } from "../../../shared/plugin-view.js";
import { CodeView } from "../FileViewer/renderers/CodeView.js";
import "../../styles/plugin-controlled-view.css";

const STATUS: Record<PluginViewTone, { label: string; className: string; path: string }> = {
  info: { label: "提示", className: "plugin-view-status-info", path: "M12 8h.01M12 11v5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0" },
  success: { label: "已完成", className: "plugin-view-status-success", path: "m8 12 3 3 5-6M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0" },
  warning: { label: "注意", className: "plugin-view-status-warning", path: "M12 9v4m0 3h.01M12 3 2 20h20L12 3Z" },
  error: { label: "错误", className: "plugin-view-status-error", path: "m9 9 6 6m0-6-6 6M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0" },
};
export interface PluginControlledViewProps {
  readonly view: ControlledViewData;
  readonly disabled?: boolean;
  readonly disabledReason?: string;
  /** Only reports a button ID. The owner revalidates it before opening an editable action form. */
  readonly onAction?: (buttonId: string) => void;
}

/** Host-owned elements only. Plugin text never becomes HTML, a URL, a style or a callback. */
export function PluginControlledView({ view, disabled = true, disabledReason, onAction }: PluginControlledViewProps) {
  const titleId = useId();
  return <section className="plugin-controlled-view" aria-labelledby={titleId} tabIndex={-1}>
    <h5 id={titleId}>{view.title}</h5>
    <div className="plugin-controlled-blocks">{view.blocks.map((block, index) => {
      switch (block.type) {
        case "text": return <p className="plugin-controlled-text" key={index}>{block.text}</p>;
        case "code": return <div className="plugin-controlled-code" key={index}>
          {block.language && <span className="plugin-controlled-language">{block.language}</span>}
          <CodeView content={block.code} language={block.language} truncated={false} />
        </div>;
        case "list": return <ul className="plugin-controlled-list" key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}>{item}</li>)}</ul>;
        case "table": return <div className="plugin-controlled-table-scroll" key={index} role="region" aria-label={`${view.title} · 表格`} tabIndex={0}>
          <table style={{ minWidth: block.columns.length * 112 }}><caption>{view.title} · 数据表</caption><thead><tr>{block.columns.map((column, columnIndex) => <th key={columnIndex} scope="col">{column}</th>)}</tr></thead>
            <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table>
        </div>;
        case "fields": return <dl className="plugin-controlled-fields" key={index}>{block.items.map((item, itemIndex) => <div key={itemIndex}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>;
        case "status": {
          const state = STATUS[block.tone];
          return <div className={`plugin-controlled-status ${state.className}`} key={index}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={state.path} /></svg>
            <div><span className="plugin-controlled-status-label">{state.label}</span><p>{block.text}</p></div>
          </div>;
        }
      }
    })}</div>
    {!!view.actions.length && <div className="plugin-controlled-buttons" role="group" aria-label="结果中的操作">
      {view.actions.map(action => <button type="button" key={action.id} disabled={disabled || !onAction} onClick={() => onAction?.(action.id)}>{action.label}</button>)}
    </div>}
    {disabledReason && !!view.actions.length && <p className="plugin-controlled-note">{disabledReason}</p>}
  </section>;
}
