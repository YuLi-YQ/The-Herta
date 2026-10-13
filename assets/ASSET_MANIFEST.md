# 素材台账（第 1 轮）
## 2026-10-11：参考原画与发布授权补充

项目作者 RainySky_13 声明，提供的参考原画 black.png 由本人绘制，并授权将基于该参考图制作、经其确认的欢迎页插画随 The Herta 源码及安装包/便携版发布至本项目 GitHub Release。欢迎页现用图仍按上文记录为 image_gen 生成的衍生插画，不改记为手绘原图；参考原图本体不随包分发。此确认不改变 Maple Mono、上游保留素材及其他第三方内容各自的来源与许可证，也不将角色素材纳入代码 MIT 授权。

2026-10-03。固定上游：PersonaCLI/Herta `8fb809934e0807ee0f0f590d87365a83bb720ca2`。
来源统一为 [固定提交文件树](https://github.com/PersonaCLI/Herta/tree/8fb809934e0807ee0f0f590d87365a83bb720ca2)，下表“上游原路径”可拼接到该提交的 `blob/` URL。迁移保留原始字节及 SHA-256，不改其许可证。

## 个人桌面构建实际选用

| 资产 | 来源与生成方式 | 用途 | 授权 |
| --- | --- | --- | --- |
| `packages/gui/src/renderer/assets/atelier-mark.svg` | 本轮手写 SVG：四角星、圆环、菱形；不含角色形象 | 启动页、工作区静态占位、明确标注的设置状态示例 | `packages/gui/resources/licenses/atelier-geometric-LICENSE.txt`（MIT，独立于上游素材排除条款） |
| `packages/gui/src/renderer/assets/atelier-orbit.svg` | 本轮手写 SVG：圆环、四角星 | 真实发送状态通用图标 | 同上 |
| `packages/gui/build/icon.svg` | 从上述 SVG 复制的图标源 | 可审阅源文件 | 同上 |
| `packages/gui/build/icon.png` | `packages/gui/build/generate-geometric-icons.ps1` 以 GDI+ 绘制，1024 × 1024 | 打包图标 | 同上 |
| `packages/gui/build/icon.ico` | 同一脚本，16 / 24 / 32 / 48 / 64 / 128 / 256 七帧 PNG 格式 ICO | Windows 安装与窗口图标 | 同上 |
| `packages/gui/resources/herta-icon.png` | 同一脚本绘制，256 × 256；旧路径仅为兼容主进程引用，内容已完全替换 | Windows 托盘等系统图标 | 同上 |

没有调用图像生成工具，没有新增角色图、字体、音频或 3D。应用只引用系统字体 `Segoe UI Variable` / `Segoe UI` / `Microsoft YaHei UI` 和系统代码字体，不分发字体文件。React/第三方软件和 Electron/Chromium 的 notices 由原有构建校验维护。

## 保留在源码、个人安装包排除的上游资产

`renderer/upstream-assets` 不属于 Vite publicDir；原 `public/device-scene` 已迁出。启动路径移除 `OpeningAscii`、字形 worker、`ReferenceView` 和所有上游图片引用；只保留源码供追溯。网站不是桌面交付，不参与个人 GUI 打包。最终 ASAR 内容由打包代理的 payload preflight 与集成验收检查确认，本表本身不能证明安装包检查通过。

上游 `LICENSE` 明确排除人物形象、角色资料、语音和网站素材等第三方知识产权；代码 MIT 不代表角色素材可再分发。本轮未取得每项角色/3D图像的独立授权，均不采用。Basis Universal 的 JS/WASM 属第三方软件，许可文本保留于 `packages/gui/resources/licenses/basis-universal-LICENSE.txt`；本轮 3D 关闭，仍不打包。

| 当前源码路径（均不进个人安装包） | 上游原路径 | 字节数 | SHA-256 | 当前采用状态 / 授权 |
| --- | --- | ---: | --- | --- |
| `packages/gui/src/renderer/reference/agent_device_transparent.png` | `packages/gui/src/renderer/reference/agent_device_transparent.png` | 753497 | `12afc2e1b28fb58417833a8803cb2c7a3cd9e7ad3e667a6190300e2f2c8df7e2` | 未选定；不套用代码 MIT |
| `packages/gui/src/renderer/reference/agent_shadow_transparent.png` | `packages/gui/src/renderer/reference/agent_shadow_transparent.png` | 19489 | `4a0d2e515e3ccf0ad835882d5c14b074712ec6a53b2450a6d8e9e47579ae5ed5` | 未选定；不套用代码 MIT |
| `packages/gui/src/renderer/reference/EarthIcon_transparent.png` | `packages/gui/src/renderer/reference/EarthIcon_transparent.png` | 368922 | `909fdce13248d8cf91f529992280c48f2cb51d8d678d4803a8a3ba2ed561efe0` | 未选定；不套用代码 MIT |
| `packages/gui/src/renderer/reference/HertaSpaceStationIcon_transparent.png` | `packages/gui/src/renderer/reference/HertaSpaceStationIcon_transparent.png` | 273626 | `53dded54c1ebebc506d86153122c475aa3cd19d7575e0e3abee9a9afb87b197c` | 未选定；不套用代码 MIT |
| `packages/gui/src/renderer/upstream-assets/artwork/agent_device_night.png` | `packages/gui/src/renderer/assets/agent_device_night.png` | 580756 | `d20901f82c2863a3513b7b1b8c41dd8c0b6135b8b32d44ba2dafe24c2b9dec51` | 未选定；不套用代码 MIT |
| `packages/gui/src/renderer/upstream-assets/artwork/agent_device.png` | `packages/gui/src/renderer/assets/agent_device.png` | 822318 | `12c04e1878b8424bba257c7937d80af46ee369f036781ab680b95f4e5cd165d4` | 未选定；不套用代码 MIT |
| `packages/gui/src/renderer/upstream-assets/artwork/agent_frost_night.webp` | `packages/gui/src/renderer/assets/agent_frost_night.webp` | 1178 | `d146028b4f0238fc1c2cf52e73b4f8534479cf52d75c065bbaf2c1aac26539e5` | 未选定；不套用代码 MIT |
| `packages/gui/src/renderer/upstream-assets/artwork/agent_frost.webp` | `packages/gui/src/renderer/assets/agent_frost.webp` | 1078 | `f0b79c08cfcc8159873cd9e188971fda747d795d4407fd69231746220c992d58` | 未选定；不套用代码 MIT |
| `packages/gui/src/renderer/upstream-assets/artwork/agent_lamp_night.webp` | `packages/gui/src/renderer/assets/agent_lamp_night.webp` | 2816 | `fca7821e503d876a574c6d660d450231e0def176279b5d605f0527909b98daa2` | 未选定；不套用代码 MIT |
| `packages/gui/src/renderer/upstream-assets/artwork/agent_lamp.webp` | `packages/gui/src/renderer/assets/agent_lamp.webp` | 1872 | `7a391d072b8af23b10dc43b944511a70ea9303980beb9d48c73f6b654d2a23cc` | 未选定；不套用代码 MIT |
| `packages/gui/src/renderer/upstream-assets/artwork/agent_shadow.png` | `packages/gui/src/renderer/assets/agent_shadow.png` | 15914 | `d108b577961f68935af8eebea0c641fabd19d48b206d294ca287ef52f18b2499` | 未选定；不套用代码 MIT |
| `packages/gui/src/renderer/upstream-assets/artwork/default-herta.png` | `packages/gui/src/renderer/assets/default-herta.png` | 247 | `46b7da34853b4d5091a364bde205443c087acf12e8ef3d8d8e3cb4701267b6aa` | 未选定；不套用代码 MIT |
| `packages/gui/src/renderer/upstream-assets/artwork/default-trailblazer.png` | `packages/gui/src/renderer/assets/default-trailblazer.png` | 247 | `b9038d8bb064884f14559167cc848860934320e0de4cc4701504ad7b4a2292b9` | 未选定；不套用代码 MIT |
| `packages/gui/src/renderer/upstream-assets/artwork/earth-icon-night.png` | `packages/gui/src/renderer/assets/earth-icon-night.png` | 46143 | `a12b6f010d35bc953aa3e69697fa03ce95f8393a123f6d5de2ee82dde94ef1e5` | 未选定；不套用代码 MIT |
| `packages/gui/src/renderer/upstream-assets/artwork/earth-icon.png` | `packages/gui/src/renderer/assets/earth-icon.png` | 84612 | `0a2bb237484dcd9c615d2352d99f67e014c731f546d64fc143da0865577cb661` | 未选定；不套用代码 MIT |
| `packages/gui/src/renderer/upstream-assets/artwork/herta-station-icon-night.png` | `packages/gui/src/renderer/assets/herta-station-icon-night.png` | 30849 | `7183b166415df304856c4bb5223444617e596c8238e696bcf8d64a96bc093780` | 未选定；不套用代码 MIT |
| `packages/gui/src/renderer/upstream-assets/artwork/herta-station-icon.png` | `packages/gui/src/renderer/assets/herta-station-icon.png` | 52061 | `2ddb06d6bb37eba3e1fbe561ee33c3febae3132ee8a0660050d9e46fa389d50d` | 未选定；不套用代码 MIT |
| `packages/gui/src/renderer/upstream-assets/artwork/upstream-build-icon.ico` | `packages/gui/build/icon.ico` | 122507 | `649f5f1e4dfa190b65085e214aff8d37938da1a12911c564f07e651d6d9514ae` | 未选定；不套用代码 MIT |
| `packages/gui/src/renderer/upstream-assets/artwork/upstream-build-icon.png` | `packages/gui/build/icon.png` | 1211739 | `58fd53a0f25fb2e356972545bbf006d39a350e418843ef82d98f419268874a17` | 未选定；不套用代码 MIT |
| `packages/gui/src/renderer/upstream-assets/artwork/upstream-resources-herta-icon.png` | `packages/gui/resources/herta-icon.png` | 1211739 | `58fd53a0f25fb2e356972545bbf006d39a350e418843ef82d98f419268874a17` | 未选定；不套用代码 MIT |
| `packages/gui/src/renderer/upstream-assets/device-scene/alcove.glb` | `packages/gui/src/renderer/public/device-scene/alcove.glb` | 54040 | `e52565ad52eb3565a2d7dec3bd5e282d2ac8ea25d53f4dae0b65f0847f5b409f` | 未选定；不套用代码 MIT |
| `packages/gui/src/renderer/upstream-assets/device-scene/baked-v1-basecolor.ktx2` | `packages/gui/src/renderer/public/device-scene/baked-v1-basecolor.ktx2` | 585890 | `585126ab21f41d146a45c5c0c6301279fd8a11667d093b5379e741178b01e68b` | 未选定；不套用代码 MIT |
| `packages/gui/src/renderer/upstream-assets/device-scene/baked-v1-cavity.png` | `packages/gui/src/renderer/public/device-scene/baked-v1-cavity.png` | 12243 | `495abe6166b3b1a1a3322fea5ac8454299e4e8b9d6ec00f97010b961dda0ecdd` | 未选定；不套用代码 MIT |
| `packages/gui/src/renderer/upstream-assets/device-scene/baked-v1-normal.ktx2` | `packages/gui/src/renderer/public/device-scene/baked-v1-normal.ktx2` | 522622 | `1b51f1d42e8cde4e3d1b1fbf5541ada5324a36e51a94e3569d20b76b44856410` | 未选定；不套用代码 MIT |
| `packages/gui/src/renderer/upstream-assets/device-scene/baked-v1-ring-channel.ktx2` | `packages/gui/src/renderer/public/device-scene/baked-v1-ring-channel.ktx2` | 137532 | `5c43731c66a623a2d4ed20600b9d4b4ea73ef839254c11470307b1ce8156f7ab` | 未选定；不套用代码 MIT |
| `packages/gui/src/renderer/upstream-assets/device-scene/baked-v1-ring-diffuse.ktx2` | `packages/gui/src/renderer/public/device-scene/baked-v1-ring-diffuse.ktx2` | 19553 | `d111c0d50ef5fc3b56c357daba6fee929dffd7554a1cbba76199a92352d7b38d` | 未选定；不套用代码 MIT |
| `packages/gui/src/renderer/upstream-assets/device-scene/baked-v1-roughness.png` | `packages/gui/src/renderer/public/device-scene/baked-v1-roughness.png` | 95014 | `2c12b096ac4acec9fe4088dabcab73d155bd08252ef3832cbf4f3ca39b8ebd9b` | 未选定；不套用代码 MIT |
| `packages/gui/src/renderer/upstream-assets/device-scene/basis/basis_transcoder.js` | `packages/gui/src/renderer/public/device-scene/basis/basis_transcoder.js` | 50010 | `aa46b437cd6501a7a49fcaad40760adbc3e35d70d7872448a0ad4f2f1667bb10` | Basis Universal MIT（仍不进包） |
| `packages/gui/src/renderer/upstream-assets/device-scene/basis/basis_transcoder.wasm` | `packages/gui/src/renderer/public/device-scene/basis/basis_transcoder.wasm` | 521932 | `52374568435e2eb9c6dd88e492dac9911f212de2fa77db268c9c4443cbc79236` | Basis Universal MIT（仍不进包） |
| `packages/gui/src/renderer/upstream-assets/device-scene/device.glb` | `packages/gui/src/renderer/public/device-scene/device.glb` | 760736 | `2785bab2d59b296b440dfd3dfe6c200f0729fdbc62df17d4932e3ecf2d0b06cb` | 未选定；不套用代码 MIT |
| `packages/gui/src/renderer/upstream-assets/device-scene/space-v1-device-evening.ktx2` | `packages/gui/src/renderer/public/device-scene/space-v1-device-evening.ktx2` | 158753 | `9352486503c7922f51132e6f614b6044b3ca7c98390db43aa7608edc9c3941e3` | 未选定；不套用代码 MIT |
| `packages/gui/src/renderer/upstream-assets/device-scene/space-v1-device-midday.ktx2` | `packages/gui/src/renderer/public/device-scene/space-v1-device-midday.ktx2` | 158030 | `b46ab015dbe331ae6a9c52dede5f60c841900abae04f64706c772103573fa4d6` | 未选定；不套用代码 MIT |
| `packages/gui/src/renderer/upstream-assets/device-scene/space-v1-device-morning.ktx2` | `packages/gui/src/renderer/public/device-scene/space-v1-device-morning.ktx2` | 159208 | `fc0730a38813bac90030d1aed05a649c5a97dbfc56c5950d1c83d70f0ad4fec2` | 未选定；不套用代码 MIT |
| `packages/gui/src/renderer/upstream-assets/device-scene/space-v1-lamp-device.ktx2` | `packages/gui/src/renderer/public/device-scene/space-v1-lamp-device.ktx2` | 152279 | `c4ce52fee6dab03ec45cc5b93fd94fe8ba21a4b8c4322968a293b05cf054e6cd` | 未选定；不套用代码 MIT |
| `packages/gui/src/renderer/upstream-assets/device-scene/space-v1-lamp-space.ktx2` | `packages/gui/src/renderer/public/device-scene/space-v1-lamp-space.ktx2` | 145954 | `3df2af4eb1b9c992498bafd32f84dceb3e42416bffb08b9018959bae049358c6` | 未选定；不套用代码 MIT |
| `packages/gui/src/renderer/upstream-assets/device-scene/space-v1-space-evening.ktx2` | `packages/gui/src/renderer/public/device-scene/space-v1-space-evening.ktx2` | 72513 | `b7a915b627bfebbdddb12b46bcb7a3945fc17b555e807253e63477762f14708a` | 未选定；不套用代码 MIT |
| `packages/gui/src/renderer/upstream-assets/device-scene/space-v1-space-midday.ktx2` | `packages/gui/src/renderer/public/device-scene/space-v1-space-midday.ktx2` | 70209 | `bc5cc08a2d54217678704d5c19d097a6a6a39f75fea940764e759a599a72b76f` | 未选定；不套用代码 MIT |
| `packages/gui/src/renderer/upstream-assets/device-scene/space-v1-space-morning.ktx2` | `packages/gui/src/renderer/public/device-scene/space-v1-space-morning.ktx2` | 71876 | `e624c835ad5717c40eb7865d43f7017e88f9bea2984f210a38ff5ff849b24231` | 未选定；不套用代码 MIT |
| `packages/gui/src/renderer/upstream-assets/openings/b-0.json` | `packages/gui/src/renderer/assets/openings/b-0.json` | 787819 | `e908a655dd251498ae13c9cb405b74d1ba592eb0a71911e4958d9829c4dfa314` | 未选定；不套用代码 MIT |
| `packages/gui/src/renderer/upstream-assets/openings/b-1.json` | `packages/gui/src/renderer/assets/openings/b-1.json` | 787819 | `7413f514337515874df2305509bdc383c951b2816a0341de6f5bae478daa9705` | 未选定；不套用代码 MIT |
| `packages/gui/src/renderer/upstream-assets/openings/c-0.json` | `packages/gui/src/renderer/assets/openings/c-0.json` | 839630 | `43853fd84057d87f16ebfcc5824af5eb615073481d83eaf8dc82cbec3998124d` | 未选定；不套用代码 MIT |
| `packages/gui/src/renderer/upstream-assets/openings/c-1.json` | `packages/gui/src/renderer/assets/openings/c-1.json` | 839630 | `8fa09502fb7a5baa9bfe7f5e39ceda4272adf38eeca64210509bb7df834d8219` | 未选定；不套用代码 MIT |
| `website/public/favicon.png` | `website/public/favicon.png` | 25851 | `c7586b2826942e8b471d44c96562157588c7de843f3d34b6da30db489a83eec5` | 未选定；不套用代码 MIT |
| `website/public/og.jpg` | `website/public/og.jpg` | 59224 | `14f77e7de7d77c0ddc708cae7bcb4ea723f82df9cba02aab8f8316a365d5bc16` | 未选定；不套用代码 MIT |
| `website/src/assets/agent_device_night.webp` | `website/src/assets/agent_device_night.webp` | 4852 | `2a1b390f62021228fca96dff39bf7ed5b83465ad8858eceb6dc080a9239bd5b1` | 未选定；不套用代码 MIT |
| `website/src/assets/agent_device.webp` | `website/src/assets/agent_device.webp` | 10382 | `9493b6e25ed0de17d68a71b1fa39d88b7fb53b189e23391b81cce583f5db02e9` | 未选定；不套用代码 MIT |
| `website/src/assets/demo-panel-after.png` | `website/src/assets/demo-panel-after.png` | 35810 | `1848334b616d58db07192d97805f59d45d6dc568455126057e50674e701c78c8` | 未选定；不套用代码 MIT |
| `website/src/assets/demo-panel-alerts.png` | `website/src/assets/demo-panel-alerts.png` | 35296 | `782070e2f27c08d2839b0eb8446001e98daaf05b52e476ba6ae1a8d921fe6010` | 未选定；不套用代码 MIT |
| `website/src/assets/demo-poster-dark.png` | `website/src/assets/demo-poster-dark.png` | 520520 | `d0ca271232b87610f941dc9a49fa796334819a4d9f15f613b77a73b290048813` | 未选定；不套用代码 MIT |
| `website/src/assets/demo-poster-dark.webp` | `website/src/assets/demo-poster-dark.webp` | 68088 | `a15b5375bcb25b1cf0319b6b6762b1d2cee5a85c23ca3de73e66f07abfbed676` | 未选定；不套用代码 MIT |
| `website/src/assets/demo-poster-en-dark.png` | `website/src/assets/demo-poster-en-dark.png` | 489843 | `afd175615bc1a17a5b5c73aee1915718515c7ae189382b5a96f2ac8ff2eeb033` | 未选定；不套用代码 MIT |
| `website/src/assets/demo-poster-en-dark.webp` | `website/src/assets/demo-poster-en-dark.webp` | 68926 | `fec7c045484efa9934ac69c1cb322f4f76360b7198f9306d6f81e9a5ff193eb7` | 未选定；不套用代码 MIT |
| `website/src/assets/demo-poster-en.png` | `website/src/assets/demo-poster-en.png` | 668167 | `3fd815c61539849fcfba3c8949e15dbb6d23b35ea9aff8e26f2765d07277b02e` | 未选定；不套用代码 MIT |
| `website/src/assets/demo-poster-en.webp` | `website/src/assets/demo-poster-en.webp` | 73140 | `6faf451a2a622ec94e4312e437c379eb558ae2c12ddbab23a942c8d0c4fbbc4a` | 未选定；不套用代码 MIT |
| `website/src/assets/demo-poster.png` | `website/src/assets/demo-poster.png` | 692772 | `90858d24b24572d9fe844effded570c0f29df4a593566e371f0723fd0014048d` | 未选定；不套用代码 MIT |
| `website/src/assets/demo-poster.webp` | `website/src/assets/demo-poster.webp` | 72154 | `a5d82111fdb759f1a98b8c38ce7ad31429b0306bb57cc0e2ab8461639a7acf20` | 未选定；不套用代码 MIT |
| `website/src/assets/device-dusk.webp` | `website/src/assets/device-dusk.webp` | 9274 | `2aa58c0a5ec60fc3c6b311f2dbd9d0b0df511a121b3957accd2f70d30f4ffcee` | 未选定；不套用代码 MIT |
| `website/src/assets/device-morning.webp` | `website/src/assets/device-morning.webp` | 8432 | `ff6683f1e3b84f43ee25f632539403925a8ca005b7f190a883af1fe55f1b236b` | 未选定；不套用代码 MIT |
| `website/src/assets/device-night.webp` | `website/src/assets/device-night.webp` | 7744 | `08a5b383a9037bd6c81ccdb17726fdc5bc02398908e51002d8f995c813cae014` | 未选定；不套用代码 MIT |
| `website/src/assets/device-noon.webp` | `website/src/assets/device-noon.webp` | 7598 | `3f01e7eca5eb674e208bf5e2a5f1d812614600fe57b3b4b91874476eb62f0314` | 未选定；不套用代码 MIT |
| `website/src/assets/dream-cycle-en.svg` | `website/src/assets/dream-cycle-en.svg` | 6956 | `9af0cab4804c2de156a2f06ab73ae93f7e6a1c07a112b82d152871f98083b595` | 未选定；不套用代码 MIT |
| `website/src/assets/dream-cycle.svg` | `website/src/assets/dream-cycle.svg` | 6599 | `54156af66965cfa065f5a65b83d25dee9cda839601e061102e32515130569afe` | 未选定；不套用代码 MIT |
| `website/src/assets/earth-icon-night.webp` | `website/src/assets/earth-icon-night.webp` | 22368 | `30d3a7e5012203fc6645ff18598c5f3e98fd0252bdfde3935cdf743148891958` | 未选定；不套用代码 MIT |
| `website/src/assets/earth-icon.webp` | `website/src/assets/earth-icon.webp` | 16826 | `6e187f06e45ae33d21422041390a0fd38a96cc07f650d353707e31ca21828d89` | 未选定；不套用代码 MIT |
| `website/src/assets/feature-git-card-dark.webp` | `website/src/assets/feature-git-card-dark.webp` | 15218 | `7bc132ba7eaca83ebcc27be355aa5da898756c6c66e3d947b857ac6f66da4612` | 未选定；不套用代码 MIT |
| `website/src/assets/feature-git-card-light.webp` | `website/src/assets/feature-git-card-light.webp` | 17324 | `a787f94cf68e03e8d41a581ca9a18a81b15b2b232d61059d411d6caba08bb217` | 未选定；不套用代码 MIT |
| `website/src/assets/feature-git-commit-dark.webp` | `website/src/assets/feature-git-commit-dark.webp` | 43828 | `9ee1b1d5228cb7894e13769de4d48a54c93ba6df436c5a76094a71e7a6b1b5cb` | 未选定；不套用代码 MIT |
| `website/src/assets/feature-git-commit-light.webp` | `website/src/assets/feature-git-commit-light.webp` | 47406 | `5b4e19d205f19db54698909561db2b76656c721eeb1c998e837484196ca168c3` | 未选定；不套用代码 MIT |
| `website/src/assets/feature-voice-en-dark.webp` | `website/src/assets/feature-voice-en-dark.webp` | 22974 | `6fc35f7d10984ee54c4754da8edb4c5b9f214d85427673572797423731b73951` | 未选定；不套用代码 MIT |
| `website/src/assets/feature-voice-en-light.webp` | `website/src/assets/feature-voice-en-light.webp` | 22616 | `936435db77c2adabc68da845ec52fbe473dbc7c33a1975aa66f0a390170a6577` | 未选定；不套用代码 MIT |
| `website/src/assets/feature-voice-zh-dark.webp` | `website/src/assets/feature-voice-zh-dark.webp` | 26614 | `d0a332047befb870c21c2951a30fb7424890c81409f62b54a8243655c09b0794` | 未选定；不套用代码 MIT |
| `website/src/assets/feature-voice-zh-light.webp` | `website/src/assets/feature-voice-zh-light.webp` | 25106 | `9bf3023b369ddeb5d96f91622c67b69bc6f86cf1122fae4bef9307e902a6abd4` | 未选定；不套用代码 MIT |
| `website/src/assets/herta-icon.webp` | `website/src/assets/herta-icon.webp` | 25594 | `73cd14b1d6b12ffe5c9749e0e1960ed2f2f5620c7255b9007f9176c53d07376b` | 未选定；不套用代码 MIT |
| `website/src/assets/herta-station-icon-night.webp` | `website/src/assets/herta-station-icon-night.webp` | 14660 | `4e236de65cc245b41a9af62835672ed0578c4a9f1c0b8db1a09087067ad9617c` | 未选定；不套用代码 MIT |
| `website/src/assets/herta-station-icon.webp` | `website/src/assets/herta-station-icon.webp` | 11478 | `118f15a65f327b3a79d85d7ff8b4d60d50e116c653c1085989be114eb0f3f51a` | 未选定；不套用代码 MIT |
| `website/src/assets/opening-voice.opus` | `website/src/assets/opening-voice.opus` | 52100 | `3d035685e00cd9bd9e3dcce0c807e0707b39ea58f0444b4525b34581491c0d55` | 未选定；不套用代码 MIT |
| `website/src/assets/turn-flow-en.svg` | `website/src/assets/turn-flow-en.svg` | 7176 | `3219de33a197284ccd0d53148cc01d6bb525aa775ae568111a051f0cf619290d` | 未选定；不套用代码 MIT |
| `website/src/assets/turn-flow.svg` | `website/src/assets/turn-flow.svg` | 6748 | `d94c1ff3f3b2e7545c4bbc43965834396dfcb147e57a4d5346b5df060f897938` | 未选定；不套用代码 MIT |
| `website/src/assets/vision-autobiography-en.svg` | `website/src/assets/vision-autobiography-en.svg` | 5156 | `cec34830a0c50b3b383383b74e9d1d92cf195f354b4e229d9da871fd14651157` | 未选定；不套用代码 MIT |
| `website/src/assets/vision-autobiography.svg` | `website/src/assets/vision-autobiography.svg` | 4826 | `6019e351d72af3a8c93b062f12e41db66e620cd417a74f9ca5b301a0dabd2504` | 未选定；不套用代码 MIT |
## 语音 / TTS / 角色文本

- 上游 `data/voice/**` 不在固定源码分发内；本轮没有下载。`website/src/assets/opening-voice.opus` 为唯一仓库内 `.opus`，见上表，网站源文件保留、不进个人包。
- sherpa-onnx / ONNX Runtime / piper-phonemize / espeak-ng 的许可文本保留于 `packages/gui/resources/licenses/`；原生运行时和 Kokoro 模型本轮不准备、不下载、不采用。关闭云 MiniMax 及自动播音路径，不能将“缺文件后静默失败”当作无语音模式。
- 上游角色提示材料 `packages/herta/prompts/**` 与 `prompts-en/**` 受根 `LICENSE` 排除条款；本轮未重写角色资料，仅保留上游链路并如实标注 DeepSeek 专用 completion 耦合。素材去除不表示角色协议解耦已经完成。

## 正式素材需求（第二轮整合前确认）

1. 至多一张大黑塔头像或透明半身图（优先已有/用户提供素材）；需要原始来源与可用范围。欢迎页一侧使用，不铺在聊天/代码/审批内容后。
2. 如选半身图，建议身体朝向内容区、背景透明，保留头发与帽檐，提供允许裁切区域；尺寸可在实际选定图后适配。无图可继续用几何布局。
3. 正式应用图标是否继续保留当前原创几何标识；没有选择前按本轮几何图标交付，不要求用户现在停工确认。
## 第五轮补充：Maple Mono（2026-10-04）

代码块与行内代码采用 Maple Mono；正文继续系统字体。使用普通版可变 WOFF2，中文由系统字体回退，不声明 CN 字形覆盖。未修改字体内容，仅重命名文件。来源为 [Maple-font](https://github.com/subframe7536/Maple-font)，固定 v7 快照提交 `c08fda97fef73d68c1755219852150770f6e6578`；不是跟随分支浮动下载。

| 本地文件（renderer/assets/fonts/） | 字节 | SHA-256 |
| --- | ---: | --- |
| MapleMono-Variable.woff2 | 130908 | e7080ef37fa8b3a38f71446e53e546634c27ce2cfe97673478cafc029d6344ee |
| MapleMono-Italic-Variable.woff2 | 152816 | 6ee68f909d35b832b804649c8ddf2baadac0c00a035294b2b0eeef95990641ef |

原文件在该提交的 `woff2/var/MapleMono[wght]-VF.woff2` 与 `MapleMono-Italic[wght]-VF.woff2`。授权为 SIL OFL 1.1；保留原版权与完整许可证于 `packages/gui/resources/licenses/MapleMono-OFL.txt`，安装/便携资源随附 `licenses/MapleMono-OFL.txt`。许可证 SHA-256：`eb2d28d2e565a0757e3d64e34ebb452e75a0cad87c0ab3faf4e08ba7596de902`。来源证据：`docs/reports/evidence/round-5/maple-font-source.json`。打包门禁校验两份字体与许可证哈希，不引入远程字体请求。

## 第十七轮：用户确认的大黑塔欢迎页插画（2026-10-08）

- 文件：packages/gui/src/renderer/assets/great-herta-welcome-v1.png；SHA256：6025DD83AFD4D9F536972390039904EE63DA97792730A5BD7ED8E653C9EFE52A。
- 来源：内置image_gen生成，参考用户提供的C:/Users/Rainy/Pictures/Material/black.png；用户看过候选并回复“可以”，授权接入欢迎页。
- 生成方向：保留参考图的深紫渐变发色、紫眼、花饰魔女帽、服装及指尖近唇神态；独立半身、透明背景，去掉牵手与星空。生成原文件exec-db10900c-b5d2-42ad-bf22-8ca7d225aeb7.png，未修改像素。
- 用途：仅空任务欢迎页；聊天、代码和审批不使用人物背景。并非官方素材，不将衍生角色图纳入代码MIT授权。用户参考图本体未复制进发布包。
