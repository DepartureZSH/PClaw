# PClaw

PClaw 是一个 Windows 优先、跨平台的 AI 图片编辑桌面应用。它把常规图片调整、裁剪与 New API 的图像编辑模型放在同一个工作台中。

## 当前功能

- 原图与 AI 结果同屏对照，显示各自像素尺寸
- 本地导入 PNG / JPG / JPEG / WebP，结果可另存为 PNG
- 亮度、对比度、饱和度、旋转、翻转、裁剪、撤销与重做
- 从 New API 动态获取可用模型，并提供图像模型优先筛选
- 自动兼容 OpenAI Images multipart 与多模态 Chat JSON 两种图片编辑协议
- 提示词预设、自定义提示词与常见输出尺寸
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
```

产物生成在 `release/` 目录。推送到 `main` 或手动运行 Actions 会构建三平台包；推送 `v*` 标签时，会等待三个平台全部构建成功，再汇总安装包并创建一次 GitHub Release。

```bash
git tag v0.1.0
git push origin v0.1.0
```

默认构建产物没有商业代码签名证书。Windows 首次运行时可能出现 SmartScreen 提示；正式分发前可在仓库 Secrets 中配置代码签名证书与密码。

## New API 接口

PClaw 使用 OpenAI 兼容接口：

- `GET /v1/models`
- `POST /v1/images/edits`
- `GET /api/usage/token`（可选；部分部署不会开放令牌余额查询）

图像编辑模型是否可用、支持的尺寸以及计费方式由 New API 实例中的渠道配置决定。

## 安全说明

- Renderer 页面无法读取明文 API Key。
- API 请求由 Electron 主进程发送，避免浏览器 CORS 与页面侧密钥泄露。
- 请只编辑你拥有权利或获得授权的图片，并遵守模型提供方与服务实例的内容规则。
