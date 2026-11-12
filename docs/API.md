# Alexandria API 参考（v0.1）

- Base URL：`http://127.0.0.1:4520`
- 认证：
  - 浏览器：`POST /api/auth/login` 后使用 HttpOnly Cookie `alex_sess_cookie`；
  - 智能体：`Authorization: Bearer alex_ak_...`。
- 错误体：

```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "需要更高的知识库权限",
    "details": null,
    "requestId": "req_..."
  }
}
```

- 角色：`owner` / `editor` / `viewer`。
- 分页：`limit`（默认 50，最大 200/500）、`offset`。

---

## 认证

### GET `/api/auth/providers`

登录页探测可用的登录方式，返回 `wecom.enabled`、`mode`、`label`，不含 Secret。

### GET `/api/auth/wecom/start`

创建 OAuth state（10 分钟），302 跳转到企业微信授权地址；`returnTo` 只接受以 `/` 开头的站内路径。

### GET `/api/auth/wecom/callback`

接收 `code` / `state`，换取 access_token 与 userinfo，按 `persons.wecom_userid` 映射本地账号，写入会话 Cookie 并跳回 `returnTo`。未绑定账号跳转 `/#/login?error=wecom_unmapped`。


### POST `/api/auth/login`

```json
{ "email": "lin@alex.dev", "password": "alex-demo" }
```

响应包含 `person`、`teams`、`token`；同时设置 Cookie。

### POST `/api/auth/logout`

清除会话 Cookie。

### GET `/api/me`

返回当前人员、团队与认证方式。

### GET `/api/bootstrap`

首屏聚合：可见知识库（含角色、计数、目录）、最近页面、团队树、成员目录、统计、特性开关。

---

## 知识库

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/libraries` | 登录 | 可见库列表 |
| POST | `/api/libraries` | 管理员 / 团队负责人 | 新建库，自动写默认本体与目录 |
| GET | `/api/libraries/:idOrSlug` | viewer | 库详情：目录、类型、关系、授权、最近内容 |
| PATCH | `/api/libraries/:id` | owner | 修改名称、简介、可见性、颜色、设置 |
| DELETE | `/api/libraries/:id` | owner | 删除库及内容 |
| GET | `/api/libraries/:id/nodes` | viewer | 目录树 |
| POST | `/api/libraries/:id/nodes` | editor | 新建目录 |
| PATCH | `/api/nodes/:id` | editor | 修改目录 |
| DELETE | `/api/nodes/:id` | editor | 删除目录 |
| GET | `/api/libraries/:id/audit` | viewer | 最近审计 |
| GET | `/api/libraries/:id/export` | viewer | JSON 导出（页面、目录、类型） |
| GET | `/api/libraries/:id/role` | viewer | 当前用户角色 |
| GET | `/api/libraries/:id/health` | viewer | 计数、孤儿页、失败文献 |

### 授权

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/libraries/:id/grants` | editor | 授权列表 |
| POST | `/api/libraries/:id/grants` | owner | `{subjectType, subjectId, role}`；`subjectType` 为 `person` / `team` / `org` |
| DELETE | `/api/grants/:id` | owner | 移除授权 |

### 本体

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/libraries/:id/classes` | editor | 新建类型 |
| PATCH | `/api/classes/:id` | editor | 修改类型 |
| DELETE | `/api/classes/:id` | editor | 删除类型（内置/使用中不可删） |
| POST | `/api/libraries/:id/relations` | editor | 新建关系 |
| DELETE | `/api/relations/:id` | editor | 删除关系 |

---

## 知识页

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/libraries/:id/pages` | viewer | 列表；`node`、`class`、`status`、`q` |
| POST | `/api/libraries/:id/pages` | editor | 新建页面 |
| GET | `/api/pages/:idOrSlug` | viewer | 详情：页面、来源、主张、出/入链、版本、context |
| PATCH | `/api/pages/:id` | editor | 更新（标题、类型、正文、状态、置信度、标签等） |
| DELETE | `/api/pages/:id` | editor | 删除 |
| GET | `/api/pages/:id/revisions` | viewer | 版本历史 |
| GET | `/api/pages/:id/context` | viewer | 可注入智能体的上下文 |
| GET | `/api/pages/:id/related` | viewer | 出链 / 入链 |
| POST | `/api/pages/:id/claims` | editor | 人工补充主张 |
| POST | `/api/pages/:id/sources` | editor | 关联文献 |
| GET | `/api/resolve?library=&ref=` | viewer | 按 slug 或标题解析页面 |
| GET | `/api/pages/:id/neighbors` | viewer | 图谱邻域 |

### 创建页面示例

```json
{
  "title": "知识编译",
  "classKey": "concept",
  "summary": "在入库时把资料转化为知识页。",
  "body": "## 定义\n……\n\n## 关联\n[[concepts/ontology]]",
  "tags": ["知识管理", "LLM Wiki"],
  "aliases": ["Knowledge Compilation"],
  "readWhen": ["设计知识库架构时"],
  "confidence": 0.7,
  "status": "active",
  "nodeId": "cat_p_method"
}
```

---

## 文献与任务

### POST `/api/libraries/:id/sources`

原始二进制上传：

```bash
curl -X POST http://127.0.0.1:4520/api/libraries/lib_product/sources \
  -H "Authorization: Bearer $ALEX_API_KEY" \
  -H "content-type: application/octet-stream" \
  -H "x-filename: $(python3 -c 'import urllib.parse;print(urllib.parse.quote("report.pdf"))')" \
  -H "x-title: $(python3 -c 'import urllib.parse;print(urllib.parse.quote("季度报告"))')" \
  --data-binary @report.pdf
```

响应 `202`：

```json
{ "source": { "id": "src_...", "status": "queued" }, "jobId": "job_...", "duplicate": false }
```

同一库内相同 SHA-256 返回 `duplicate: true`。

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/libraries/:id/sources` | viewer | 文献列表 |
| GET | `/api/sources/:id` | viewer | 详情、资产、编译页面、任务 |
| GET | `/api/sources/:id/download` | viewer | 原始文件 |
| GET | `/api/sources/:id/text` | viewer | 抽取文本与元数据 |
| GET | `/api/sources/:id/assets/:assetId` | viewer | 图片 / 缩略图（`?thumb=1`） |
| POST | `/api/sources/:id/reprocess` | editor | 重新编译（异步） |
| DELETE | `/api/sources/:id` | editor | 删除文献与文件 |
| GET | `/api/jobs/:id` | viewer | 任务状态、阶段、日志、计数 |
| GET | `/api/libraries/:id/jobs` | viewer | 最近任务 |

任务状态：`queued` → `running`（`extract`/`normalize`/`compile`）→ `succeeded` / `failed`。

---

## 校对与矛盾裁决

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/review?library=&status=` | 登录 | 待校对队列与汇总 |
| GET | `/api/libraries/:id/review` | viewer | 单库队列 |
| GET | `/api/review/summary` | 登录 | 待校对 / 退回 / 矛盾计数 |
| GET | `/api/review/conflicts` | 登录 | 冲突主张列表 |
| POST | `/api/pages/:id/review` | editor | `{action: approve|request_changes|reopen|archive, note, confidence?}` |
| POST | `/api/claims/:id/resolve` | editor | `{resolution: keep|dismiss, note}` |

批准会写入 `status=active`、`review_status=approved`、审核人与时间；要求修改必须提供说明。矛盾裁决会保留双方记录，将另一侧标记为 `resolved`。

---

## 检索与图谱

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/search?q=&library=&class=&limit=` | 词法 + 图扩展检索，返回 `hits[].signals` |
| POST | `/api/query` | 知识合成：`{ q, libraryIds?, mode?: "compiled"|"llm"|"auto" }` |
| GET | `/api/graph?library=&class=` | 单库或聚合图 |
| GET | `/api/libraries/:id/graph` | 单库图 |
| GET | `/api/libraries/:id/facets` | 类型 / 状态 / 标签分布 |
| GET | `/api/tags` | 可见库标签云 |
| GET | `/api/recent` | 最近更新 |
| POST | `/api/rebuild-index` | 管理员重建 FTS |

`/api/search` 响应（节选）：

```json
{
  "query": "知识编译",
  "tookMs": 5,
  "strategy": "FTS5 词法检索 + 预编译关联图扩展 + 元数据/时效重排（无查询时向量化）",
  "hits": [
    {
      "kind": "page",
      "id": "pg_...",
      "title": "知识编译",
      "libraryName": "产品知识库",
      "score": 19.4,
      "signals": { "lexical": 12.1, "title": 1, "coverage": 1, "confidence": 0.9, "freshness": 0.99, "readWhen": 1 },
      "snippet": "……"
    }
  ]
}
```

`/api/query` 响应包含 `answer`、`mode`、`citations[]`、`gaps[]`、`signals`、`tookMs`。`mode` 为 `compiled` / `llm` / `empty`。

---

## 团队与账号

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/teams` | 登录 | 团队树（含成员） |
| POST | `/api/teams` | 管理员 | 新建团队 |
| PATCH | `/api/teams/:id` | 管理员 | 修改 |
| DELETE | `/api/teams/:id` | 管理员 | 删除（需先转移知识库） |
| GET | `/api/teams/:id/members` | 登录 | 成员 |
| POST | `/api/teams/:id/members` | 管理员 | 添加成员 / 设为负责人 |
| DELETE | `/api/teams/:id/members/:personId` | 管理员 | 移除成员 |
| GET | `/api/people` | 登录 | 成员目录 |
| POST | `/api/people` | 管理员 | 创建账号 |
| PATCH | `/api/people/:id` | 管理员 | 修改账号 |
| GET/POST | `/api/api-keys` | 登录 | 列出 / 创建自己的密钥 |
| DELETE | `/api/api-keys/:id` | 登录 | 吊销 |

### 企业微信

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/integrations/wecom` | 登录 | 配置与映射状态 |
| POST | `/api/integrations/wecom/config` | 管理员 | 保存 CorpID / AgentID / Secret |
| POST | `/api/integrations/wecom/sync` | 管理员 | 拉取通讯录；默认 dry-run，`{apply:true}` 执行绑定/建团队 |

---

## Agent API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/agent/manifest` | 工具清单、原则、认证说明 |
| GET | `/api/agent/overview` | 可见库与类型 |
| GET | `/api/agent/skill` | SKILL.md 原文 |
| GET | `/api/agent/export/:libraryId` | LLM Wiki 风格导出 |
| POST | `/api/agent/search` | `{query, libraryIds?, classKey?, limit?}` |
| POST | `/api/agent/ask` | `{query, libraryIds?, mode?}` |
| POST | `/api/agent/read` | `{pageId | slug, library?}` |
| POST | `/api/agent/graph` | `{libraryId, classKey?, limit?}` |
| POST | `/api/agent/compile` | `{sourceId}` |
| POST | `/api/agent/page` | 创建或更新页面 |
| POST | `/api/agent/lint` | 结构体检 |

只读密钥只能调用 `search/ask/read/graph/lint` 与 `GET` 接口；写入需要 `write` 密钥。

### Agent 页面写入示例

```bash
curl -s http://127.0.0.1:4520/api/agent/page \
  -H "Authorization: Bearer $ALEX_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "libraryId": "lib_product",
    "title": "知识编译",
    "classKey": "concept",
    "body": "## 定义\n……\n\n## 关联\n[[concepts/ontology]]",
    "tags": ["知识管理"],
    "confidence": 0.7
  }'
```

返回 `{ page, created }`。写入会立即更新 FTS 与图。
