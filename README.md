# PClaw

PClaw 是一个 Windows 优先、跨平台的 AI 图片编辑桌面应用。它把常规图片调整、裁剪与 New API 的图像编辑模型放在同一个工作台中。

## 当前功能

- 原图与 AI 结果同屏对照，显示各自像素尺寸
- 本地导入 PNG / JPG / JPEG / WebP，结果可另存为 PNG
- 亮度、对比度、饱和度、旋转、翻转、裁剪、撤销与重做；滑杆数值均可直接输入
- 从 New API 动态获取可用模型，并提供图像模型优先筛选
- 自动识别并支持 OpenAI multipart、Seedream JSON generations、Qwen DashScope JSON 与多模态 Chat JSON
- 可手动指定接口协议，避免模型名称映射特殊时调用错误端点
- 两个海马体证件照提示词预设、自定义提示词，以及 9:16 至 16:9 的七种输出比例
- 图片在工作台中始终等比例适配；导出宽度默认 1024 px，可用滑杆或数字输入调整并保持图片比例
- 使用 New API 令牌接口显示已用量、总额度与剩余量
- 本地运行日志记录端点、模型、状态码与请求 ID，支持刷新、清空和导出
- API Key 在 Electron 主进程中通过操作系统安全存储加密
- GitHub Actions 构建 Windows 安装包与便携版，同时构建 macOS / Linux 产物

## 本地开发

需要 Node.js 22 或更新版本。

```bash
npm install
npm run dev
```

首次启动后点击右上角设置，填写：

- API 地址：默认 `https://chatbot.cn.unreachablecity.club`
- API Key：在 New API 控制台创建的 `sk-...` 令牌

## 构建

```bash
# 当前平台
npm run package

# Windows（建议在 Windows 或 GitHub Actions 中执行）
npm run package:win

# macOS 通用版（Intel 与 Apple Silicon）
npm run package:mac
```

产物生成在 `release/` 目录。推送到 `main` 或手动运行 Actions 会构建三平台包；推送 `v*` 标签时，会等待三个平台全部构建成功，再汇总安装包并创建一次 GitHub Release。

```bash
git tag v0.1.0
git push origin v0.1.0
```

Windows 首次运行时可能出现 SmartScreen 提示。macOS 正式分发需要 Apple Developer Program 的 Developer ID 签名与公证；在仓库 Actions Secrets 中配置以下值后，发布流程会自动完成签名、公证和凭证装订：

- `MAC_CSC_LINK`：Developer ID Application `.p12` 证书的 Base64 内容
- `MAC_CSC_KEY_PASSWORD`：证书密码
- `APPLE_ID`：Apple ID 邮箱
- `APPLE_APP_SPECIFIC_PASSWORD`：Apple ID 专用密码
- `APPLE_TEAM_ID`：开发者团队 ID

如果这些凭据尚未配置，Actions 会生成通过完整性校验的临时签名通用版，但 Gatekeeper 不会信任临时签名。首次打开前，将应用复制到“应用程序”后执行：

```bash
xattr -cr /Applications/PClaw.app
open /Applications/PClaw.app
```

## New API 接口

PClaw 通过 New API 按模型使用不同接口：

- `GET /v1/models`
- OpenAI GPT Image / DALL-E：`POST /v1/images/edits`，`multipart/form-data`
- Seedream / SeedEdit：`POST /v1/images/generations`，JSON `image` 数组
- Qwen Image：`POST /v1/images/edits`，由 New API 将 DashScope JSON 转发给阿里云
- Gemini / Nano Banana：`POST /v1/chat/completions`，多模态 JSON
- `GET /api/usage/token/`（可选；显示当前 API 令牌的使用量、总额度与剩余额度）

“自动识别”会根据模型名选择协议；如果 New API 使用了自定义模型映射，可在界面中手动指定协议。图像编辑模型是否可用、支持的尺寸以及计费方式由 New API 实例中的渠道配置决定。

## 安全说明

- Renderer 页面无法读取明文 API Key。
- API 请求由 Electron 主进程发送，避免浏览器 CORS 与页面侧密钥泄露。
- 请只编辑你拥有权利或获得授权的图片，并遵守模型提供方与服务实例的内容规则。
