# 分发素材与许可

本清单只列当前公开源码中的分发素材。文件哈希取自实际文件；构建时还会独立检查安装包内容，台账不能替代包内核验。素材文件不因同仓库的代码采用MIT而自动获得相同许可。

## 来源与授权

- **几何图形与图标**：项目原创的星芒、轨道和圆角图形，不包含角色形象。独立采用MIT，完整版权与许可见下表链接。位图由仓库图标脚本从几何源生成。
- **欢迎页插画**：作者RainySky_13声明参考原画为本人绘制，并授权经其确认的衍生欢迎页插画随本项目源码及安装包/便携包发布。现用PNG由image_gen参考该画生成，经作者确认；它不是手绘参考原图或官方素材。参考原图本体不在分发清单中。此授权不转移HoYoverse角色知识产权，也不把衍生角色图纳入代码MIT或授予任意再分发/商用权。
- **Maple Mono**：来自[Maple-font固定提交](https://github.com/subframe7536/Maple-font/tree/c08fda97fef73d68c1755219852150770f6e6578)的普通可变WOFF2，未改字体字节；采用SIL OFL 1.1，原版权和完整许可随附。
- **Noto Serif SC**：来自Google Fonts的600字重字体，由其text子集接口生成固定标题字符集；来源元数据随字体分发，采用SIL OFL 1.1。正文继续使用系统字体，运行时不请求远程字体。

## 素材文件

| 文件 | 字节 | SHA-256 | 用途 / 许可 |
| --- | ---: | --- | --- |
| [packages/gui/src/renderer/assets/atelier-mark.svg](../packages/gui/src/renderer/assets/atelier-mark.svg) | 1568 | eab5914f6b27cf238d432437a26ad990661b4c8ed2767de3c6448281b8b13108 | 界面标识；[原创几何 MIT](../packages/gui/resources/licenses/atelier-geometric-LICENSE.txt) |
| [packages/gui/src/renderer/assets/atelier-orbit.svg](../packages/gui/src/renderer/assets/atelier-orbit.svg) | 238 | c16901bb525742a6f4ea1e9f642d3586f1eadcc0dc46cedb22454f69d9eb7db1 | 通用状态图形；[原创几何 MIT](../packages/gui/resources/licenses/atelier-geometric-LICENSE.txt) |
| [packages/gui/build/icon.svg](../packages/gui/build/icon.svg) | 1568 | eab5914f6b27cf238d432437a26ad990661b4c8ed2767de3c6448281b8b13108 | 应用图标源；[原创几何 MIT](../packages/gui/resources/licenses/atelier-geometric-LICENSE.txt) |
| [packages/gui/build/icon-small.svg](../packages/gui/build/icon-small.svg) | 819 | 005e48f660679934550bce0b88de85c4025ae60796819486261b01f09810d174 | 小尺寸图标源；[原创几何 MIT](../packages/gui/resources/licenses/atelier-geometric-LICENSE.txt) |
| [packages/gui/build/icon.png](../packages/gui/build/icon.png) | 260099 | a72f9df580b965aed3fb2af0f4ba273b1f26a17bdeadca2d4d9af1f1ef5fe9b5 | 1024像素打包图标；[原创几何 MIT](../packages/gui/resources/licenses/atelier-geometric-LICENSE.txt) |
| [packages/gui/build/icon.ico](../packages/gui/build/icon.ico) | 49590 | 85cab8b48010c06bf2d870d7bd1c158d0dfd5a0fbd9bd66fee75f7cbdd5cd24d | Windows多尺寸图标；[原创几何 MIT](../packages/gui/resources/licenses/atelier-geometric-LICENSE.txt) |
| [packages/gui/resources/herta-icon.png](../packages/gui/resources/herta-icon.png) | 29050 | 05d9fdaf2cc79fc340318fce0c6c30817749c40e80380b41cb6ebfe8b70db383 | 256像素系统图标；[原创几何 MIT](../packages/gui/resources/licenses/atelier-geometric-LICENSE.txt) |
| [packages/gui/src/renderer/assets/great-herta-welcome-v1.png](../packages/gui/src/renderer/assets/great-herta-welcome-v1.png) | 2247557 | 6025dd83afd4d9f536972390039904ee63da97792730a5bd7ed8e653c9efe52a | 透明欢迎页插画；本项目发布授权；不适用代码MIT |
| [packages/gui/src/renderer/assets/fonts/MapleMono-Variable.woff2](../packages/gui/src/renderer/assets/fonts/MapleMono-Variable.woff2) | 130908 | e7080ef37fa8b3a38f71446e53e546634c27ce2cfe97673478cafc029d6344ee | 代码字体；[Maple Mono OFL](../packages/gui/resources/licenses/MapleMono-OFL.txt) |
| [packages/gui/src/renderer/assets/fonts/MapleMono-Italic-Variable.woff2](../packages/gui/src/renderer/assets/fonts/MapleMono-Italic-Variable.woff2) | 152816 | 6ee68f909d35b832b804649c8ddf2baadac0c00a035294b2b0eeef95990641ef | 代码斜体字体；[Maple Mono OFL](../packages/gui/resources/licenses/MapleMono-OFL.txt) |
| [packages/gui/src/renderer/assets/fonts/herta-display.woff2](../packages/gui/src/renderer/assets/fonts/herta-display.woff2) | 8648 | 1d29d0179ce2a6c7e0a678daf25527478788a32161ba657168cbbc82c8a2f301 | 固定标题文字的600字重子集；[Noto Serif SC OFL](../packages/gui/resources/licenses/NotoSerifSC-OFL.txt) |
| [packages/gui/src/renderer/assets/fonts/herta-display.json](../packages/gui/src/renderer/assets/fonts/herta-display.json) | 652 | 054413b07eada0ed3fe899f61919dfd23ae67fd4fe98ddf204e7ab5e3643b756 | 字体子集来源与字符元数据；[Noto Serif SC OFL](../packages/gui/resources/licenses/NotoSerifSC-OFL.txt) |

## 随附许可

| 文件 | SHA-256 |
| --- | --- |
| [atelier-geometric-LICENSE.txt](../packages/gui/resources/licenses/atelier-geometric-LICENSE.txt) | c2130bacb77336ee3b06e764b90d7732d07d0873cf988ad33b31bb5c9151c378 |
| [MapleMono-OFL.txt](../packages/gui/resources/licenses/MapleMono-OFL.txt) | eb2d28d2e565a0757e3d64e34ebb452e75a0cad87c0ab3faf4e08ba7596de902 |
| [NotoSerifSC-OFL.txt](../packages/gui/resources/licenses/NotoSerifSC-OFL.txt) | 5e0da210fb04058a8c0087985d2d456b931c2579811a49655721d3cf0c36b6d6 |

代码及上游归属见[LICENSE](../LICENSE)，软件依赖见[THIRD-PARTY-NOTICES](../THIRD-PARTY-NOTICES.md)。语音模型/音频、未选用的上游人物及网站素材不属于本次素材分发清单；仓库保留的相关实现不表示这些资源已附带或启用。
