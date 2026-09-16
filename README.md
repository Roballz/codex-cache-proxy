# codex-cache-proxy

一个面向 **TauriTavern / SillyTavern → Sub2API / CLIProxyAPI → Codex** 链路的本地轻量网关。

主要用途是为不带/不发送session_id的客户端注入固定的identity请求参数，以解决Sub2api/CPA因每次自动生成添加不同session_id导致的掉缓存情况。

该网关不保存你的 API Key；同时把 **Session / Cache Identity、Responses / Chat Completions 兼容、可见推理摘要和缓存诊断** 这些容易影响长对话缓存的变量集中管理。

> 网关只保证“它发给下一跳的请求”符合codex的session_id缓存策略，不解决 Codex 侧自身缓存不稳/降智的问题。

## 功能概览

- 保存多个上游并快速切换，支持 `Sub2API`、`CLIProxyAPI` 和 `Generic` 三种类型。
- API Key 只从 TT/ST 当前请求中透传，不写入网关配置文件。
- 创建多个会话档案，每个会话独立保存固定 Session ID、TT/ST 接口、身份模式和 Chat Completions 模式。
- 支持 `强制锁定`、`缺失时补齐`、`原样透传` 三种身份处理方式。
- 支持 `GET /v1/models`、`POST /v1/responses`、`POST /v1/chat/completions`。
- 为 Sub2API 提供实验性的 **Responses Bridge**，可把兼容的 Chat Completions 请求转换成 Responses-shaped body，同时仍保持 `/v1/chat/completions` 路径。
- 提供全局 **请求可见推理摘要** 开关，可在 Responses-shaped 请求缺少 `reasoning.summary` 时自动补 `"auto"`。
- 读取上游返回的 input / cached / reasoning token usage，并计算缓存命中率。
- 比较相邻请求的稳定前缀、首个变化消息及参数变化，方便排查缓存失效位置。
- 诊断只保留哈希、长度、身份状态和 usage 等信息，不保存完整剧情正文。
- 配置采用本地 JSON + 备份文件保存，Session ID 不会因为刷新网页或重启进程自动变化。

## 工作方式

```text
TauriTavern / SillyTavern
        │
        │ API Key + 请求
        ▼
codex-cache-proxy
        │
        ├─ 选择上游
        ├─ 应用当前会话的 Session / Cache Identity
        ├─ 可选 Responses Bridge
        ├─ 可选 reasoning.summary = "auto"
        └─ 记录缓存诊断
        │
        ▼
Sub2API / CLIProxyAPI / Generic
        │
        ▼
Codex / 上游模型
```

## 运行要求

- Node.js 22 或更高版本
- 默认监听 `127.0.0.1:8790`
- 项目目前没有第三方运行时依赖

### Termux 安装示例

```bash
pkg update
pkg install nodejs git
git clone https://github.com/Roballz/codex-cache-proxy.git
cd codex-cache-proxy
npm start
```

浏览器打开：

```text
http://127.0.0.1:8790/
```

以后更新：

```bash
cd codex-cache-proxy
git pull
```

然后重新启动：

```bash
npm start
```

## TT/ST 连接方式

假设原来的 Sub2API 地址是：

```text
https://sub2api.example.com/v1
```

先在网关管理页把它添加为上游，再把 TT/ST 中对应 API 的 Base URL 改成：

```text
http://127.0.0.1:8790/v1
```

API Key 仍然填写在 TT/ST 原来的 API Key 输入框中，网关没有 API Key 保存栏，也不会把 `Authorization` 写入 `data/settings.json`。

当前支持：

```text
GET  /v1/models
POST /v1/responses
POST /v1/chat/completions
```

除显式启用 Responses Bridge 和“请求可见推理摘要”外，网关不会主动重写普通请求的业务内容；复杂的 Codex 兼容转换仍交给 Sub2API / CLIProxyAPI。

# 使用手册

## 1. 上游

### 当前

选择这一项后，该上游会成为后续新请求使用的目标；已经开始的请求不会因为你之后切换上游而中途改变。

### 名称

只是管理页显示用的自定义名称，例如 `主 Sub2API`、`备用 CPA`，不会发送给模型。

### 类型

用于告诉网关上游属于哪种兼容类型，目前可选 `Sub2API`、`CLIProxyAPI`、`Generic`；不同类型主要影响 Session continuity header 的写法以及 Responses Bridge 是否可用。

### Base URL

填写上游 API 根地址，例如 `https://example.com/v1`；如果误填到 `/responses`、`/chat/completions` 或 `/models`，保存时会自动规范回 `/v1` 根路径。

### 添加 / 删除

“添加”创建一个新的上游配置，“删除”只删除本地配置，不会修改远端 Sub2API / CPA。

---

## 2. 会话锁定

会话档案用于把一个 RP / 对话长期绑定到稳定的 Session / Cache Identity，同时保存这套会话对应的接口与处理模式。

### 请求可见推理摘要

这是全局开关；开启后，如果最终发出的请求是 Responses shape、已经包含 `reasoning` 且没有指定 `summary` / `generate_summary`，网关会补：

```json
{
  "reasoning": {
    "summary": "auto"
  }
}
```

关闭时网关完全不修改 reasoning；如果客户端已经自己指定 summary，也会保留客户端原值。

这个开关不会凭空创建 `reasoning`，因此 TT/ST 没有请求 reasoning 时，网关也不会主动开启模型推理。

### 新建会话

创建新的会话档案，并生成新的固定 Session ID；新会话会继承当前会话的接口、身份模式和 Chat Completions 模式。

### 当前

选中的会话档案会用于后续请求；切换后需要点击“保存设置”才会持久化。

### 名称

会话的本地备注名，例如 `雪山篇`、`都市篇测试档`，只用于管理和诊断显示。

### 固定 Session ID

这是网关在需要固定身份时使用的稳定值；除非你手动修改或点击“重新生成 ID”，刷新网页、切换模型、切换上游或重启网关都不会自动改变它。

### 重新生成 ID

为当前会话生成一个全新的固定 Session ID；这相当于主动换一套新的会话 / 缓存身份，不建议在正在延续的长期 RP 中随意点击。

### TT/ST 接口

记录这个会话在 TT/ST 侧实际使用的是 `Responses` 还是 `Chat Completions`，并据此决定管理页是否显示 Chat Completions 专属选项。

> 这个选项不会远程修改 TT/ST 的接口；实际请求最终走 `/v1/responses` 还是 `/v1/chat/completions`，仍由 TT/ST 发给网关的 URL 决定，因此这里应与 TT/ST 当前配置保持一致。

### 身份模式

决定网关如何处理 `prompt_cache_key`、session header 等 Session / Cache Identity。

#### 强制锁定

始终使用当前会话档案的固定 Session ID；客户端已经带了不同身份时也会被覆盖，适合需要稳定 Cache Identity 的长期会话。

网关会设置：

```text
body.prompt_cache_key = 固定 Session ID
```

并按上游类型设置对应的 session continuity header。

它不会主动修改：

```text
previous_response_id
conversation
Responses item id
tool call_id
普通 input/messages 文本内容和顺序
```

#### 缺失时补齐

客户端没有身份时使用当前会话的固定 Session ID；如果客户端已经提供一个一致的身份则沿用客户端身份，如果多个身份字段互相冲突则拒绝请求而不是猜测使用哪一个。

#### 原样透传

完全不修改 Session / Cache Identity，适合做 A/B 对照或让客户端 / 上游自己管理会话身份。

### Chat Completions 模式

只有会话的 `TT/ST 接口` 选择 `Chat Completions` 时显示。

#### 交给上游自动管理

保持原生 Chat Completions body 和客户端 identity，不应用本会话的身份模式，由 Sub2API / CPA 等上游自行派生或管理 Chat Completions 的缓存 / 会话身份。

#### Responses Bridge（实验）

仅针对 `Sub2API` 上游；TT/ST 仍请求 `/v1/chat/completions`，但网关先把兼容的纯文本 Chat Completions body 转成 Responses-shaped `input`，再按当前会话的身份模式处理 identity。

主要转换包括：

```text
messages → input
system/developer → developer
assistant → message/output_text
user → user
max_tokens / max_completion_tokens → max_output_tokens
reasoning_effort → reasoning.effort
```

请求 URL 仍然是：

```text
/v1/chat/completions
```

这样 Sub2API 可以走它已有的 Responses-shaped Chat compatibility 分支，并继续负责把 Responses 回包转换成 Chat Completions 返回给 TT/ST。

当前 Bridge 只保守处理可安全转换的纯文本请求；如果请求包含 tools、function/tool 消息、多模态、`response_format` 等未支持结构，或者当前上游不是 Sub2API，会自动回退到“交给上游自动管理”，不会发送半转换请求。

---

## 3. 推荐配置示例

### TT/ST 原生 Responses

```text
TT/ST 接口：Responses
身份模式：强制锁定
请求可见推理摘要：按需开启
```

这种模式不需要 Responses Bridge。

### TT/ST 使用 Chat Completions，但希望获得 Responses-shaped 请求行为

```text
TT/ST 接口：Chat Completions
身份模式：强制锁定
Chat Completions 模式：Responses Bridge（实验）
请求可见推理摘要：按需开启
上游类型：Sub2API
```

### 对照上游原生 Chat Completions 行为

```text
TT/ST 接口：Chat Completions
Chat Completions 模式：交给上游自动管理
```

此时本会话保存的身份模式仍保留在档案中，但当前原生 CC 请求不会应用它。

---

## 4. 高级设置

### 诊断保留条数

控制当前进程内最多保留多少条最近诊断记录，可设置 `10-200`；诊断不会自动写入磁盘。

### 上游超时（秒）

单次上游请求允许等待的最长时间，可设置 `10-3600` 秒；超时后网关会中止上游请求并记录 timeout 状态。

### 允许的浏览器 Origin

允许浏览器 / WebView 直接访问网关的精确 Origin 白名单，每行一个，不支持用 `*` 代替精确来源。

默认包含一些常见本地 / Tauri Origin；如果遇到：

```text
origin_denied
```

把报错对应的精确 Origin 添加到这里即可。

### 保存设置

把当前页面中的上游、会话、推理摘要开关和高级设置写入 `data/settings.json`。

### 重新载入

放弃页面里尚未保存的修改，并重新从后端读取当前配置和诊断。

---

# 诊断说明

诊断用于观察“网关实际准备发送的请求”和“上游实际返回的 usage”，不是对 Codex 内部缓存实现的直接观测。

## 诊断字段速查

| 字段 | 含义 |
| --- | --- |
| 模型 / 状态 | 显示请求模型和这条请求最终是 completed、timeout、client_aborted、upstream_error 等状态。 |
| 时间 | 这条请求进入网关的时间。 |
| 上游 | 实际使用的上游名称和适配器类型。 |
| 路径 | TT/ST 实际请求的 `/v1/responses` 或 `/v1/chat/completions`。 |
| CC Bridge | 显示 Responses Bridge 是否启用；如果自动回退，也会显示回退原因。 |
| 身份模式 | 显示本次请求实际使用的身份处理模式和会话档案名称。 |
| 身份值 | 显示网关最终使用的固定 / 客户端身份值；上游自动管理时显示由上游派生。 |
| 客户端原有身份 | 表示 TT/ST 原始请求中是否已经存在可观察的 session/cache identity。 |
| 网关身份操作 | 用一句状态说明本次是新增并锁定、覆盖并锁定、沿用客户端、原样透传或交给上游。 |
| 是否覆盖客户端已有身份 | 表示网关是否把客户端原本提供的身份值替换成了别的值。 |
| 输入 tokens | 上游 usage 返回的输入 token 数；上游没有提供时显示“未返回”。 |
| 缓存 tokens | 上游 usage 返回的 cached token 数，并在可计算时显示 cached/input 的命中比例。 |
| 推理 tokens（模型内部推理） | 上游 usage 返回的 reasoning token 数；不等同于界面上可见推理摘要的文字长度。 |
| 前序相同消息 | 与同一诊断作用域上一条请求相比，从开头起有多少个 `input[]` / `messages[]` 项完全一致。 |
| 第一个变化消息 | 与上一条可比较请求相比，第一个内容发生变化的 `input[]` / `messages[]` 下标。 |
| 稳定前缀字节下限 | 根据完整消息和 1024-byte chunk 比较得到的可确认相同前缀字节数下限。 |
| 其他参数是否变化 | 表示除 `input/messages` 和 identity 字段外的其他请求参数哈希是否变化。 |

> “稳定前缀字节下限”只是网关侧 JSON 内容比较结果，不等于 OpenAI / Codex 内部的 token 边界或 cache breakpoint。

## 身份字段与消息哈希日志

点击每条诊断下方的“身份字段与消息哈希”可展开本次请求的 identity 详情、各 `input[]` / `messages[]` 项哈希、字节数以及是否与上一条请求相同。

诊断只保留最多前 80 个消息 / input 项的哈希明细，超过部分只记录省略数量，不保存对应正文。

## 刷新与清空

刷新按钮手动重新读取当前进程里的诊断记录；“清空”只清除内存中的诊断和比较快照，不会删除配置或会话档案。

## usage 缺失与 0 的区别

如果上游没有返回某个 usage 字段，管理页显示“未返回”；只有上游明确返回 `cached_tokens: 0` 时才显示为 0。

---

# 配置与隐私

运行后本地生成：

```text
data/settings.json
data/settings.json.bak
```

`data/` 已加入 `.gitignore`。

配置文件会保存：

```text
上游名称 / URL / 类型
当前上游
会话名称 / 固定 Session ID
每个会话的 TT/ST 接口 / 身份模式 / Chat Completions 模式
请求可见推理摘要开关
诊断保留条数
上游超时
允许的浏览器 Origin
```

配置文件不会保存：

```text
API Key
Authorization
完整请求正文
完整剧情文本
```

Authorization 只用于转发，以及在当前进程中生成不可逆的 HMAC 诊断分区；HMAC salt 也不会写入磁盘。

配置写入使用临时文件 + 原子替换，并保留上一版 `settings.json.bak`。

如果主配置损坏，程序不会静默生成新的 Session ID；它会停止启动并要求你检查 / 恢复配置，避免长期会话身份被无声替换。

# 环境变量

默认：

```text
HOST=127.0.0.1
PORT=8790
```

例如换端口：

```bash
PORT=8791 npm start
```

不建议把 `HOST` 改成 `0.0.0.0`；API Key 会经过这个进程，默认只监听本机回环地址更安全。

# 开发检查

```bash
npm test
npm run check
```
