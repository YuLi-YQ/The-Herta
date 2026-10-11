# 可复现来源与运行基线

## 来源

- 来源：[PersonaCLI/Herta](https://github.com/PersonaCLI/Herta)，固定提交 `8fb809934e0807ee0f0f590d87365a83bb720ca2`，不跟随 main 漂移。
- 下载：[固定 codeload tar.gz](https://codeload.github.com/PersonaCLI/Herta/tar.gz/8fb809934e0807ee0f0f590d87365a83bb720ca2)。SHA-256：`a9ef9493a811e0546a719e72938316c14a1287da0e3669ed472abb0dfecae640`。
- 共 1,575 个普通文件。Windows tar 对 20 个中文名称提示 Invalid empty pathname；用 Python tarfile UTF-8 解压并逐文件比对压缩包内容，零不一致。
- 导入没有 `.git`；当前仓库初始 HEAD 为 `c0039de`，起始只有 `.codex/environments/environment.toml`，工作树干净、detached HEAD、无 remote。本轮不提交、推送、上传。
- 规划材料来自同仓库 `C:/Users/Rainy/.codex/worktrees/f04d/Herta` 的未提交 README/docs，原路径未修改。复制到本轮工作树后再演进；上游 README 另存 `docs/upstream/README.md`。主目录与其他工作树均未覆盖。
- 适用父目录、当前工作树、固定上游均没有 AGENTS.md。本轮之前没有实施报告/应用产物。

## 运行时和锁文件

- 使用 Node **22.23.3** Windows x64，按上游 Node 22 约束收窄到已验证补丁版本（原 `.node-version` 为 `22`）。系统现有 Node 24.21.0 没有被替换。
- Node ZIP：[官方固定下载](https://nodejs.org/dist/v22.23.3/node-v22.23.3-win-x64.zip)，SHA-256 `2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71`，解压前已核对。
- 包管理器 **pnpm 9.15.0**，根 packageManager 保持上游固定值。独立本地运行时在忽略目录 `.runtime`；正式复现可使用同版本 Node + Corepack/pnpm。
- 上游 `pnpm-lock.yaml` 原始 SHA-256 `6f03c59fc3e9c329cfd18ca8408965f4998fd9b37b60efe7440f3d458ae1ad24`。使用 `pnpm install --frozen-lockfile`，本轮不升级依赖。
- Node 22 与 better-sqlite3 兼容按实际安装结果判断；GUI 主 bundle 原策略 tree-shake SQLite 原生分支，不打包 node_modules。Electron 本体来自锁文件，不以系统 Chrome 代替。

## 许可证及派生边界

根 LICENSE 的 MIT 授权与 PersonaCLI 归属完整保留。其 scope note 排除 HoYoverse 角色、图像、对白、语音，不能把 MIT 当作角色素材许可。使用的第三方 JavaScript 由 bundle-manifest 生成 THIRD-PARTY-NOTICES.md 并以 `--check` 阻止遗漏；Electron/Chromium 自带 notices 由打包器放在 exe 旁。

本轮原创紫金几何占位替换角色图标；保留源码素材的审计来源，不让它们进入个人包。详见 assets/ASSET_MANIFEST.md 与 docs/ASSET_AUDIT.md。语音、TTS、云语音、3D 不属于个人构建；不抓取新素材。

本项目工作名 Herta Atelier，独立 appId `personal.herta.atelier`、数据目录 `%APPDATA%/HertaAtelier`。个人构建不连接上游更新、不发布。上游网站/其他平台脚本保留溯源但不运行；原定时 CI 已取消定时触发。

本轮执行结果、具体命令与日志见 reports/round-1.md。三协议的真实服务验证不得从安装/编译或 mock 测试推断。
