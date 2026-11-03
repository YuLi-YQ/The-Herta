# 上游与许可归属

The Herta基于[PersonaCLI/Herta](https://github.com/PersonaCLI/Herta)继续开发，初始导入基线为[固定提交8fb8099](https://github.com/PersonaCLI/Herta/tree/8fb809934e0807ee0f0f590d87365a83bb720ca2)。当前源码包含后续修改，不能将该提交视作当前产品完整版本。

原PersonaCLI版权与MIT许可保留在[LICENSE](../LICENSE)，本项目修改者归属同时列出。HoYoverse角色、美术、游戏对白和声音不由代码MIT授予使用权。项目为非官方同人作品，不代表上游或权利方认可。

## 构建来源

仓库固定Node22.23.3和pnpm9.15.0；依赖以pnpm-lock.yaml为准，使用frozen-lockfile安装，不依赖开发者电脑上的未记录包。Electron来自锁文件，不能以普通浏览器替代桌面运行环境。

从源码运行步骤见[README](../README.md#从源码运行)，协作规则见[AGENTS.md](../AGENTS.md)。应用使用独立appId和资料目录；默认资料目录为%APPDATA%/HertaAtelier，便携启动不代表数据随exe移动。

## 分发边界

当前素材及逐文件哈希见[素材台账](../assets/ASSET_MANIFEST.md)，软件许可见[THIRD-PARTY-NOTICES](../THIRD-PARTY-NOTICES.md)。原创几何图标单独MIT、字体各自OFL、经作者确认的欢迎页衍生图保留其独立授权范围；参考原画和未选用的上游人物/网站/语音资源不列入本次分发。

个人资料、密钥、测试profile、开发交接记录和本机构建缓存不属于源码分发。未启用的TTS、3D或其他保留实现不表示随包提供相应模型/音色/素材。编译与安装成功也不等于所有服务、协议或原生业务均已验证。
