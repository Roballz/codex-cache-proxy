# codex-cache-proxy

一个面向 TauriTavern / SillyTavern → Sub2API / CLIProxyAPI → Codex 链路的本地轻量网关。

目标不是重做 Sub2API 或 CPA，而是把最容易影响排查的变量单独固定下来：

- 保存多个上游并快速切换；
- API Key **不写入网关配置**，只转发客户端当前请求里的 `Authorization`；
- 手动创建并锁定稳定的 Session/Cache Identity；
- 支持 `lock`、`fill`、`passthrough` 三种身份模式；
- 支持 Responses / Chat Completions 流式转发；
- 为 Sub2API 提供实验性的 Responses-shaped Chat Bridge；
- 观察上游返回的 `cached_tokens`，并比较相邻请求的稳定前缀；
- 诊断默认仅存在内存，不保存完整剧情正文。

> 这个工具能保证“网关发给下一跳的身份值稳定”，但不能保证 Codex 一定命中缓存，也不能直接观察 Sub2API/CPA 最终发给 Codex 的内部请求。它的用途是固定变量、做对照测试。

## 运行要求

- Node.js 22 或更高版本
- 默认只监听 `127.0.0.1:8790`

Termux 示例：

```bash
pkg update
pkg install nodejs git
git clone https://github.com/Roballz/codex-cache-proxy.git
cd codex-cache-proxy
npm start
```

如果仓库是 private，请使用你自己的 GitHub 登录方式克隆。

浏览器打开：

```text
http://127.0.0.1:8790/
```

## TauriTavern / SillyTavern 设置

假设你的原始 Sub2API 地址是：

```text
https://sub2api.example.com/v1
```

先在网关管理页把它添加为上游，然后把 TT/ST 的 API 地址改成：

```text
http://127.0.0.1:8790/v1
```

API Key 仍然填写在 TT/ST 原来的 API Key 输入框中。网关不会提供 API Key 保存栏，也不会把 Authorization 写入 `data/settings.json`。

当前支持：

```text
GET  /v1/models
POST /v1/responses
POST /v1/chat/completions
```

除显式启用 Responses Bridge 外，Responses / Chat Completions 的 JSON 内容默认不做格式转换，复杂的 Codex 兼容转换继续交给 Sub2API/CPA。

## 身份模式

### 强制锁定（Lock）

推荐用于当前缓存排查。

选择一个会话档案后，所有生成请求统一使用该档案的固定值。即使客户端带了不同的 session/cache identity，也会被当前档案覆盖。

网关会设置：

```text
body.prompt_cache_key = 固定 Session ID
```

并按照上游类型发送对应的 session continuity header。

它**不会**修改：

- `previous_response_id`
- `conversation`
- tool `call_id`
- Responses item id
- 普通转发模式下 `input/messages` 的文字和顺序

### 缺失时补齐（Fill）

客户端没有身份时才使用当前档案；如果客户端已经带了多个互相冲突的身份值，请求会被拒绝，而不是偷偷选一个。

### 原样透传（Passthrough）

不修改身份相关字段，适合做 A/B 对照。

## Chat Completions 模式

### 原生 CC · 上游自动管理

Chat Completions body 和客户端 identity 原样交给上游。适合对照 Sub2API 自己的 `compat_cc_*` 缓存行为。

### 原生 CC · 跟随全局身份模式

保留原始 `messages`，但按照上面的全局身份模式处理 session/cache identity。

### Responses Bridge（实验）

仅对 `Sub2API` 上游启用。

TT/ST 仍请求：

```text
POST /v1/chat/completions
```

但网关会把兼容的纯文本 Chat Completions body 转成 Responses-shaped body：

```text
messages → input
system/developer → developer
assistant → message/output_text
user → user
max_tokens/max_completion_tokens → max_output_tokens
reasoning_effort → reasoning.effort
```

URL 仍然保持 `/v1/chat/completions`，目的是触发 Sub2API 已有的 Responses-shaped Chat compatibility 分支，让 Sub2API 负责把 Codex Responses 回包继续转换成 Chat Completions 回给 TT/ST。

Bridge 会继续使用“Responses / 全局身份模式”，因此可与固定 Session ID 一起测试。

首版故意只支持保守的纯文本场景。如果请求包含 tools、function/tool 消息、多模态或其他无法安全映射的结构，会自动回退“原生 CC · 上游自动管理”，不会半转换后继续发送。诊断卡片中的 `CC Bridge` 会明确显示“已启用”或“已回退”。

## 会话档案

管理页可以创建多个 RP 会话，例如：

```text
雪山篇-主存档
都市篇-测试
角色A-长期档
```

每个档案都有独立固定 ID。刷新网页、切换模型、切换上游、重启 Termux 都不会自动改变该 ID。

只有你主动点击“重新生成 ID”或手动修改后保存，值才会变化。

如果配置损坏，程序不会静默生成新的 Session ID；它会停止启动并要求你检查 `data/settings.json` / `data/settings.json.bak`。

## 多上游

支持三种标记：

- `Sub2API`
- `CLIProxyAPI`
- `Generic`

这些类型目前主要用于决定 session continuity header 的写法。上游地址只保存 URL，不保存认证信息。

一次请求开始后，会使用当时选中的上游完成整个请求；管理页之后的切换只影响后续请求。

## 缓存诊断

管理页会显示：

- 当前身份模式和固定 ID；
- CC Bridge 是否启用或回退；
- 是否覆盖了客户端身份；
- 当前请求与上一请求有多少条消息完全一致；
- 第一条变化消息的位置；
- 变化消息内部至少有多少字节前缀一致（1024-byte chunk 粒度）；
- 非 `input/messages` 参数是否变化；
- 上游返回的 input tokens；
- 上游返回的 cached tokens；
- 实际 cache hit rate。

注意：

```text
“稳定前缀字节”只是网关侧内容比较，不等于 OpenAI 内部 token/cache breakpoint。
```

如果上游没有返回缓存 usage，UI 会显示“未返回”，不会伪装成 `0 cached tokens`。

诊断中不会保存完整 prompt 文本。Authorization 只用于进程内的不可逆 HMAC 分区，HMAC salt 也不会落盘。

## 配置与隐私

运行后本地生成：

```text
data/settings.json
data/settings.json.bak
```

`data/` 已加入 `.gitignore`。

配置文件包含：

- 上游名称 / URL / 类型；
- 当前上游；
- 会话名称 / 固定 ID；
- identity / Chat Completions 模式；
- timeout / diagnostics 数量；
- 允许的浏览器 Origin。

配置文件不会包含：

- API Key；
- Authorization；
- 完整请求正文；
- 完整剧情文本。

配置写入采用临时文件 + 原子替换，并保留上一版 `.bak`。

## 浏览器 Origin

如果 TT/ST 是浏览器/WebView 前端并直接请求网关，浏览器可能发送 `Origin`。

默认包含一些本地/Tauri 常见 Origin；如果看到：

```text
origin_denied
```

请在管理页“允许的浏览器 Origin”中加入错误对应的**精确 Origin**，不要使用 `*`。

## 环境变量

默认：

```text
HOST=127.0.0.1
PORT=8790
```

例如：

```bash
PORT=8791 npm start
```

不建议把 `HOST` 改成 `0.0.0.0`。API Key 会经过这个进程，默认只监听回环地址更安全。

## 开发检查

```bash
npm test
npm run check
```

项目目前没有第三方运行时依赖。
