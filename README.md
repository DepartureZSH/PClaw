# PClaw

PClaw 是一个面向 Windows 的 AI 图片编辑桌面应用。它把常规图片调整、裁剪与 New API 的图像编辑模型放在同一个工作台中。

## 当前功能

- 原图与 AI 结果同屏对照，显示各自像素尺寸
- 本地导入 PNG / JPG / JPEG / WebP，结果可另存为 PNG
- 亮度、对比度、饱和度、旋转、翻转、裁剪、撤销与重做；滑杆数值均可直接输入
- 从 New API 动态获取可用模型，并提供图像模型优先筛选
- 自动识别并支持 OpenAI multipart、Seedream JSON generations、Qwen DashScope JSON 与多模态 Chat JSON
- 可手动指定接口协议，避免模型名称映射特殊时调用错误端点
- 两个海马体证件照提示词预设、自定义提示词，以及 9:16 至 16:9 的七种输出比例
- 图片在工作台中始终等比例适配；导出宽度默认 1024 px，可用滑杆或数字输入调整并保持图片比例
- 按 New API 模型价格、当前人民币汇率与令牌消费日志计算本周人民币成本，支持 7 天统计图；按 token 与按次模型均统一加 10%
- 本地运行日志记录端点、模型、状态码与请求 ID，支持刷新、清空和导出
- API Key 在 Electron 主进程中通过操作系统安全存储加密
- GitHub Actions 仅构建 Windows 安装版与便携版，并在 `v*` 标签构建成功后发布到 Release

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
# Windows（建议在 Windows 或 GitHub Actions 中执行）
npm run package:win
```

产物生成在 `release/` 目录：`PClaw-Setup-*.exe` 是可选择安装目录的安装版，`PClaw-Portable-*.exe` 是无需安装的便携版。推送到 `main` 或手动运行 Actions 会构建 Windows 包；推送 `v*` 标签时会在构建成功后创建 GitHub Release。

```bash
git tag v0.1.0
git push origin v0.1.0
```

Windows 首次运行未签名的安装包时可能出现 SmartScreen 提示。

## New API 接口

PClaw 通过 New API 按模型使用不同接口：

- `GET /v1/models`
- OpenAI GPT Image / DALL-E：`POST /v1/images/edits`，`multipart/form-data`
- Seedream / SeedEdit：`POST /v1/images/generations`，JSON `image` 数组
- Qwen Image：`POST /v1/images/edits`，由 New API 将 DashScope JSON 转发给阿里云
- Gemini / Nano Banana：`POST /v1/chat/completions`，多模态 JSON
- `GET /api/pricing`：读取模型按 token 或按次价格与分组倍率
- `GET /api/log/token`：读取当前 API 令牌最近消费日志，并在本机按周汇总成本
- `GET /api/status`：读取实例当前美元兑人民币汇率与单位额度配置

成本统计不使用日志中的 `quota` 字段。按 token 计费时，PClaw 使用输入 token、输出 token、模型倍率、输出倍率与分组倍率计算美元基础成本；按次计费时使用模型固定美元价格与分组倍率。分组倍率优先取消费日志 `other.group_ratio` 中该次请求实际采用的值，价格表公开倍率仅作为回退。两种结果都会乘以 New API 当前人民币汇率和 `1.1`，最终以人民币显示。无法匹配模型价格、分组倍率或汇率的调用不会被静默估算。

“自动识别”会根据模型名选择协议；如果 New API 使用了自定义模型映射，可在界面中手动指定协议。图像编辑模型是否可用、支持的尺寸以及计费方式由 New API 实例中的渠道配置决定。

## 安全说明

- Renderer 页面无法读取明文 API Key。
- API 请求由 Electron 主进程发送，避免浏览器 CORS 与页面侧密钥泄露。
- 请只编辑你拥有权利或获得授权的图片，并遵守模型提供方与服务实例的内容规则。
