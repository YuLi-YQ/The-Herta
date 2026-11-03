import type { ExecutablePluginCapability, ExecutablePluginCapabilityName } from "../../../shared/executable-plugins.js";

const LABELS: Record<ExecutablePluginCapabilityName, string> = {
  "workspace.readText": "读取当前项目文件", "workspace.proposePatch": "提出项目文件修改", "commands.run": "运行项目命令",
  "network.request": "联网请求", "storage.get": "读取插件自己的资料", "storage.set": "保存插件自己的资料",
  "draft.append": "准备聊天草稿", "artifacts.create": "生成文件", "ui.present": "展示插件面板", "ui.update": "更新插件面板",
  log: "记录处理过程", progress: "显示处理进度",
};
export function executableCapabilityLabel(name: ExecutablePluginCapabilityName): string { return LABELS[name]; }
export function PermissionChoices({ capabilities, selected, available, disabled, onChange }: {
  capabilities: readonly ExecutablePluginCapability[]; selected: readonly ExecutablePluginCapabilityName[];
  available: readonly ExecutablePluginCapabilityName[]; disabled: boolean; onChange(selected: ExecutablePluginCapabilityName[]): void;
}) {
  return <fieldset className="executable-plugin-permissions" disabled={disabled}><legend>允许的操作</legend>
    {!capabilities.length ? <p className="executable-plugin-muted">无需额外权限。</p> : capabilities.map(capability => {
      const checked = selected.includes(capability.name), supported = available.includes(capability.name);
      return <div className="executable-plugin-permission" key={capability.name}>
        <label className="executable-plugin-check"><input type="checkbox" checked={checked} disabled={!supported && !checked}
          onChange={event => onChange(event.target.checked ? [...selected, capability.name] : selected.filter(name => name !== capability.name))} />
          <span>{executableCapabilityLabel(capability.name)}{!supported && <small>此版本暂不可用</small>}</span></label>
        {capability.name === "network.request" && <p className="executable-plugin-muted executable-plugin-origin">{capability.origins.join("、")} · {capability.methods.join(" / ")}</p>}
      </div>;
    })}
  </fieldset>;
}
