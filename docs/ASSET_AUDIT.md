# 第一轮素材与界面基线审查

日期：2026-10-03；固定上游 `8fb809934e0807ee0f0f590d87365a83bb720ca2`。资产逐文件的原路径、当前路径、字节数和 SHA-256 见 [素材台账](../assets/ASSET_MANIFEST.md)。本记录只覆盖源码盘点及本代理运行的检查；真实桌面和最终安装包的结果由协调者写入 `docs/reports/round-1.md`，不以源码检查冒充桌面通过。

| 项目 | 实际观察 / 本轮处理 | 状态与证据 |
| --- | --- | --- |
| 根代码许可 | 保留 PersonaCLI MIT 和素材排除条款；新原创几何素材附独立 MIT 授权，不改变上游授权 | 已核查 `LICENSE` 与 `resources/licenses/atelier-geometric-LICENSE.txt` |
| 仓库内素材 | 80 个上游资产逐文件列出；38 个 GUI 图像、3D、开场 JSON 迁至 `renderer/upstream-assets`（11,189,368 字节）；其余是 4 个参考 PNG 与 38 个网站资源 | 台账含每文件哈希；全部不采用为个人包素材 |
| 应用图标 | 图标 SVG、PNG 和 ICO 是本轮用普通绘图代码绘制的圆环、四角星、菱形；未使用角色素材或图像生成工具 | PowerShell 生成成功；System.Drawing 实际解码 1024 × 1024 PNG、ICO（默认读取 32 × 32 帧），完整七帧由脚本结构生成 |
| 字体 | 对 renderer 和 website 的 CSS/TS/TSX/HTML 查找 `@font-face`、Google Fonts、woff/ttf/otf，未发现外置字体文件或远程字体引用；保留系统字体回退 | 静态搜索结果；依赖中可能打包的第三方代码许可仍由 notices 检查负责 |
| 自动播音 / TTS | App 移除 `useVoiceCues` 挂载；Settings 移除语音、MiniMax 和更新入口，不主动读取语音/更新状态；彩蛋播放调用随原 DeviceCard 删除 | 主进程边界及包内容由桌面代理独立禁用与校验；没有“缺资源后静默失败”交付 |
| 开场角色画面 | App 不挂载 OpeningAscii；入口不启动 glyph worker；JSON 移至非公共归档目录；参考 iframe 不再从 App 导入 | 生产构建必须确认无开场/参考页面输出 |
| 3D / GLSL 装饰 | 静态几何 DeviceCard 替换 3D/拖拽彩蛋；不导入 DeviceScene/DeviceGlow；Composer 移除 AuraVisual | 上游场景代码与许可仍保留源码，不进入产品运行路径；public/device-scene 已迁出 |
| 离线界面 | 保留本地会话、设置和真实工作区菜单；标题栏/首页/设置显著标注第 1 轮基线，说明三个 Provider 尚未接线和旧 DeepSeek completion 依赖 | GUI renderer TypeScript `--noEmit` 本机通过；真实无 Key 桌面启动待协调者验证 |
| 外部打开本地文件 | 按主进程负责人发现的 shell.openPath 可执行文件风险，移除 renderer 外部打开按钮，标注“本轮支持应用内只读预览” | 主进程 IPC 拒绝由契约负责人实现；不以隐藏按钮作为安全边界 |

自有源码的运行检查使用仓库固定 Node 22.23.3 / pnpm 9.15.0。已执行 `tsc -p packages/gui/tsconfig.web.json --noEmit`，退出码 0。素材生成命令：`packages/gui/build/generate-geometric-icons.ps1`。这些检查不验证真实 API、安装、缩放、UI 无障碍或审批安全。

第一轮只做必要的去素材、禁用可选能力与基础紫金调色，保留上游主布局；第二轮还需按 `DESIGN_SPEC.md` 重做工作台交互、完整令牌与多 Provider 管理。角色图没有选定，也未擅自用人偶黑塔代替大黑塔。正式素材要求见台账末尾，整合时再询问用户偏好。

## 第五轮字体补充（2026-10-04）

第一轮“未采用外置字体”的结论是当时基线。第五轮按用户要求新增 Maple Mono 普通版可变正常/斜体 WOFF2；固定 v7 提交、文件哈希和 SIL OFL 1.1 来源见素材台账末尾。字体字节未修改；打包随附完整版权/许可证。代码采用该字体，中文系统回退，正文继续系统字体。没有新增角色素材或图像生成。最终包中的字节门禁与真实字体加载结果写入 round-5 报告，不以 CSS 声明代替加载通过。


## 2026-10-11：参考原画与发布授权补充

项目作者 RainySky_13 声明，提供的参考原画 black.png 由本人绘制，并授权将基于该参考图制作、经其确认的欢迎页插画随 The Herta 源码及安装包/便携版发布至本项目 GitHub Release。欢迎页现用图仍按上文记录为 image_gen 生成的衍生插画，不改记为手绘原图；参考原图本体不随包分发。此确认不改变 Maple Mono、上游保留素材及其他第三方内容各自的来源与许可证，也不将角色素材纳入代码 MIT 授权。
