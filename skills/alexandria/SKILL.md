---
name: alexandria
description: >
  维护 Alexandria 知识库：检索已编译知识、把资料编译为原子知识页、修正矛盾与孤儿页、
  以带引用的方式回答企业问题。适用于需要持久知识、团队权限与来源追溯的场景。
type: skill
status: active
last_updated: "2026-11-12"
argument-hint: "[search|read|ingest|compile|review|lint] ..."
when_to_use: >
  当用户要求整理资料、维护知识库、回答需要引用企业知识的问题、
  或需要把一份文档沉淀为可复用知识页时使用。
tags: [knowledge-base, llm-wiki, ontology, dsh]
owner: knowledge-ops
compatibility: "alexandria >= 0.1.0"
---

# Alexandria 知识库技能

Alexandria 是一个 **LLM Wiki 式**企业知识库：知识在入库时被编译成带本体类型、主张与关联的原子页面；查询走词法 + 图谱 + 已编译页面，而不是查询期 RAG。

你（DSH）是**馆员**，不是读者：先检索已有知识，再决定更新还是新建；保留来源；不要静默覆盖矛盾。

## 0. 连接与认证

- Base URL：`$ALEXANDRIA_URL`（默认 `http://127.0.0.1:4520`）。
- 认证：`Authorization: Bearer $ALEX_API_KEY`。
- 工具清单：`GET /api/agent/manifest`；可见库：`GET /api/agent/overview`。
- 若没有密钥：请人工在 Web「团队与权限 → API 密钥」创建 `write` 密钥；不要索取用户密码。

约定：

- 只读任务用 `read` 密钥；需要写入时用 `write` 密钥。
- 不要把密钥写入页面正文、日志或提交记录。
- 页面正文用 Markdown；链接使用 `[[slug]]` 或 `[[slug|显示文本]]`。
- 一页只讲一个概念 / 一个决策 / 一种方法。

## 1. 回答一个问题（research / ask）

1. `POST /api/agent/search`，参数 `{ "query": "<问题关键词>", "limit": 8 }`。
2. 对最相关的 1–3 个页面调用 `POST /api/agent/read`（`pageId` 或 `slug`），读取 `context`、`claims`、`sources`、`links`。
3. 需要综合答案时调用 `POST /api/agent/ask`：

```json
{ "query": "为什么不用查询期 RAG？", "mode": "compiled" }
```

4. 输出要求：
   - 先给结论，再给要点；
   - 每个关键结论标注来源页面；
   - 如果 `gaps` 提到草稿、单一来源或无结果，明确说明不确定性；
   - 不要编造页面中不存在的数字、人物或结论。

## 2. 把资料编译成知识（ingest）

Alexandria 的上传与编译由服务端流水线完成，你通常只需要：

1. 确认目标知识库与目录：`GET /api/agent/overview`，必要时 `GET /api/libraries/:id`。
2. 请人工在 Web 上传文件（或由具备上传通道的系统调用 `POST /api/libraries/:id/sources`）。
3. 轮询 `GET /api/jobs/:id`，直到 `succeeded` / `failed`。
4. 检查编译结果：
   - `GET /api/libraries/:id/pages?limit=50` 找新页面；
   - `POST /api/agent/lint` 看孤儿页、断链、失败文献、草稿。
5. 对自动生成的概念页做校对：补充定义、边界、来源，必要时合并重复页或标记 `archived`。

### 编译后的质量检查清单

- [ ] 文献页有摘要、结构、至少 3 条关键主张？
- [ ] 概念页的标题是稳定名词，而不是一句话或章节编号？
- [ ] 每个关键主张能落到具体来源与章节？
- [ ] 与既有页面是否重复？若重复，合并而不是新建。
- [ ] 是否存在矛盾？保留双方并把页面标为 `draft`。
- [ ] 标签是否稳定、可复用？避免一次性长短语。

## 3. 创建或更新页面（upsert）

先检索，再写入：

```text
search("概念名") → read(最相关页面) → 决定 update / create
```

### 新建

```bash
curl -s $ALEXANDRIA_URL/api/agent/page \
  -H "Authorization: Bearer $ALEX_API_KEY" \
  -H "content-type: application/json" \
  -d '{
    "libraryId": "lib_product",
    "title": "知识编译",
    "classKey": "concept",
    "summary": "在入库时把资料转化为原子知识页。",
    "tldr": "知识在入库时编译一次。",
    "body": "## 定义\n……\n\n## 要点\n- ……\n\n## 来源\n- [[sources/知识编译白皮书-2026]]",
    "tags": ["知识管理", "LLM Wiki"],
    "aliases": ["Knowledge Compilation"],
    "readWhen": ["设计知识库架构时"],
    "confidence": 0.6,
    "status": "draft"
  }'
```

### 更新（累加契约）

- 先 `read` 当前页面，保留已有的 `tags` / `aliases` / `sources` / `claims`；
- 新内容追加到正文，不删除旧来源；
- 若新来源与旧结论冲突：保留双方，降低置信度，`status: draft`；
- 更新后如有必要，补一条人工主张说明裁决结果。

## 4. 审核与修复（review / lint）

1. `POST /api/agent/lint`，按优先级处理：
   - `failedSources`：查看错误，必要时请人工重新上传或安装转换器；
   - `brokenLinks`：修正 slug 或创建缺失页面；
   - `orphans`：补充来源/关联，或归档；
   - `drafts`：逐页校对，补来源，提升置信度。
2. 使用 `POST /api/agent/graph` 查看邻域，避免制造孤立页。
3. 页面改动会进入 `page_revisions`；重要修改在正文或主张里说明理由。

## 5. 写作规范

- **标题**：领域内稳定名词，2–30 字；不要用“关于…的说明”这类空标题。
- **摘要**：一句话说清适用范围；**tldr**：一句话结论。
- **正文结构**：`## 定义`、`## 要点`、`## 边界 / 反例`、`## 来源`。
- **主张**：尽量使用可比较的句式（“X 是/包括/依赖/取代…”）；保留来源与章节。
- **链接**：只链同库页面；跨库内容用文字说明或请人工建立跨库策略。
- **置信度**：单来源 0.5–0.6；多来源交叉验证 0.7–0.9；未经验证的推断 ≤0.5 且标 `draft`。
- **状态**：新编译页默认 `draft`；人工校对后可 `active`；过期内容 `stale`；被替代 `archived` 并写 `superseded_by`。

## 6. 不要做

- 不要把整篇原文复制到概念页；文献页只做结构与主张摘要。
- 不要用向量检索结果替代页面证据。
- 不要在未读现有页面的情况下覆盖同名页面。
- 不要把私有库内容带到无权限的会话或页面。
- 不要泄露 API Key、密码或企业微信 Secret。
- 不要编造引用；没有来源就标注“待验证”。

## 7. 常用调用速查

| 目的 | 调用 |
| --- | --- |
| 找知识 | `POST /api/agent/search` |
| 直接问答 | `POST /api/agent/ask` |
| 读页面与上下文 | `POST /api/agent/read` |
| 写页面 | `POST /api/agent/page` |
| 重新编译 | `POST /api/agent/compile` |
| 图谱邻域 | `POST /api/agent/graph` |
| 体检 | `POST /api/agent/lint` |
| 导出 wiki | `GET /api/agent/export/:libraryId` |
| 工具清单 | `GET /api/agent/manifest` |

## 8. 结束条件

一次知识工作完成的标志：

- 相关页面已创建或更新，且有来源与关联；
- `lint` 没有新增断链/孤儿页；
- 矛盾已保留并标记，或已人工裁决；
- 回答带引用，且明确说明不确定性。
