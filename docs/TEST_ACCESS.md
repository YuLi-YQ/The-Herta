# 本机测试服务交接

更新：2026-10-04。用户明确授权为 The Herta 持久化测试凭据，并允许后续施工模型使用；余额有限，测试结束后由用户销毁密钥。无需重复索取授权或Key，除非本机文件不可用或服务已撤销。授权用于相关测试，不包括无关服务/上传/发布。

## 存储与读取

仓库外目录：`C:/Users/Rainy/AppData/Local/TheHerta-TestAccess`。

- `connection.json`：服务、地址、候选模型及授权说明，无明文Key。
- `deepseek-key.dpapi`：Windows当前用户DPAPI保护的密钥，同机器同用户可解密。本次保存并回读成功，未联网测试。

PowerShell读取入口：

```powershell
$testAccessDir = Join-Path $env:LOCALAPPDATA 'TheHerta-TestAccess'
$testConnection = Get-Content -LiteralPath (Join-Path $testAccessDir 'connection.json') -Raw | ConvertFrom-Json
$testSecureKey = (Get-Content -LiteralPath (Join-Path $testAccessDir 'deepseek-key.dpapi') -Raw).Trim() | ConvertTo-SecureString
# 仅在请求或应用安全存储输入时转换，不输出、记录或写入普通配置。
$testCredential = [System.Net.NetworkCredential]::new('', $testSecureKey)
# $testCredential.Password 仅传给授权测试请求/应用凭据保存入口。
```

不要把对象/Password直接输出，不把Key放在命令行参数、报告、截图、仓库或产物。该文件是凭据读取说明，不要求重置用户个人资料。测试仍使用隔离profile与临时项目，保持用户已清空的正常数据目录不被恢复。

## 地址和模型

用户提供OpenAI root为 `api.deepseek.com`，请求使用 `https://api.deepseek.com`。Anthropic原始输入为 `api.deepseek.com/Anthropic`；既往报告验证路径为小写 `https://api.deepseek.com/anthropic`（另一轮为带/v1形式）。URL路径大小写可能不同，不能盲目小写任意用户URL；施工模型须检查适配器端点拼接与实际响应，避免重复/v1或误把路径当根。优先使用已验证的小写服务路径进行对照，明确记录最终命中的端点，不声称用户原始大写路径已测。

优先 `deepseek-flash` 做最小文本/工具测试；`deepseek-v4-pro` 是用户授权候选，未验证可用，不默认跑双模型大矩阵。先低成本定位配置→绑定→验证→发送链路，重复失败有界停止并记录原因。只有问题需要时增加调用，不消耗额度做无关压测。
