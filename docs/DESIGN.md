# Alexandria 设计方案

> 状态：v0.1 可运行基线  
> 目标：把企业资料编译成可引用、可治理、可被智能体维护的知识，而不是在查询时反复检索片段。

---

## 1. 目标与非目标

### 1.1 目标

- **知识编译**：资料入库时完成解析、概念抽取、主张抽取、关联构建与矛盾标记。
- **本体组织**：每个知识库有独立类型系统、属性与关系；页面是结构化知识对象。
- **图书馆式组织**：分库、目录、文献与知识页分离；权限可继承、可审计。
- **非 RAG 检索**：默认使用词法 + 图谱 + 元数据；不依赖查询期向量切块。
- **文档能力**：覆盖 Word / PDF / PPT / Excel / TeX / 图片 / RTF / WPS / Markdown 等。
- **团队与权限**：账号、组织架构、团队、库级授权；企业微信 Mock OAuth 与通讯录同步已接入。
- **智能体原生**：DSH 通过 API + 技能维护知识；引擎不内嵌提示词。
- **本地优先**：Node + SQLite + 文件系统，零外部服务可运行。

### 1.2 非目标（v0.1）

- 不做通用即时通讯 / 文档协同编辑；
- 不做多租户计费与跨组织联邦；
- 不把自动编译结果当作高置信事实，草稿必须可识别；
- 不在默认路径引入向量数据库或外部 LLM 依赖；
- 不承诺旧版二进制 WPS 的完整还原。

---

## 2. 设计原则

1. **知识先于检索**：页面是事实源；FTS 与图是派生索引，可重建。
2. **入库时理解，查询时导航**：理解成本前移一次；查询尽量做定位与合成。
3. **保留不确定性**：矛盾保留双方，标记 `conflicted`；草稿标记 `draft`；置信度可追踪。
4. **权限先于结果**：先计算可见库集合，再进入检索；私有库隐藏存在性。
5. **引擎与智能体分离**：确定性代码负责存储/索引/权限；LLM 负责可选的编译增强与答案合成。
6. **失败要显式**：格式不支持、解析降级、编译失败都进入文献状态与任务日志。
7. **可回溯**：原始文件、来源锚点、页面版本、审计事件齐全。

---

## 3. 总体架构

```text
┌──────────────────────────── Web SPA ────────────────────────────┐
│ 登录 / 总览 / 图书馆 / 阅读器 / 检索 / 上传 / 图谱 / 权限 / 智能体 │
└──────────────────────────────┬──────────────────────────────────┘
                               │ Cookie Session / Bearer API Key
┌──────────────────────────────▼──────────────────────────────────┐
│                        HTTP Server（node:http）                  │
│  Router → Context → Auth/RBAC → Route Handler → JSON/Static      │
├──────────────────────────────────────────────────────────────────┤
│ Domain                                                           │
│  Access（团队/授权/可见性）   Audit   Libraries   Pages   Sources │
│  Ontology   Compiler   Claims   Search   Graph   Agent API       │
├──────────────────────────────────────────────────────────────────┤
│ Extract                                                          │
│  PDF · DOCX · PPTX · XLSX · TeX · RTF · WPS/OLE · Image/OCR · …  │
├──────────────────────────────────────────────────────────────────┤
│ Persistence                                                      │
│  SQLite（WAL）：业务表 + FTS5 派生索引                            │
│  文件系统：data/uploads/<library>/<source>/…                     │
└──────────────────────────────────────────────────────────────────┘
```

请求路径：

- 浏览器：`Cookie: alex_sess_cookie`（HttpOnly），JSON API。
- 智能体：`Authorization: Bearer alex_ak_...`，范围 `read` / `write`。
- 上传：原始二进制 body + `x-filename` / `x-title` / `x-node-id` 头，避免 multipart 依赖。

---

## 4. 数据模型

### 4.1 组织与账号

| 表 | 关键字段 | 说明 |
| --- | --- | --- |
| `persons` | id, email, name, is_admin, password_hash, wecom_userid | 账号；PBKDF2 密码 |
| `teams` | id, parent_id, name, lead_person_id, wecom_dept_id | 组织架构树 |
| `team_members` | team_id, person_id, role | `lead` / `member` |
| `sessions` | token_hash, person_id, expires_at | Cookie 会话 |
| `api_keys` | key_hash, scope, revoked_at | 智能体密钥 |

### 4.2 知识库与目录

| 表 | 关键字段 | 说明 |
| --- | --- | --- |
| `libraries` | slug, visibility, owner_team_id, settings | 分库 |
| `library_grants` | subject_type/subject_id/role | 个人 / 团队 / 组织授权 |
| `catalog_nodes` | parent_id, kind, code, sort_order | 目录树：书架 / 分类 / 主题 |
| `ontology_classes` | key, name, schema_json | 本体类型 |
| `ontology_relations` | key, source_class, target_class, inverse_name | 关系声明 |

### 4.3 文献与知识页

| 表 | 关键字段 | 说明 |
| --- | --- | --- |
| `sources` | sha256, kind, status, extracted_text, metadata | 原始馆藏；同库哈希去重 |
| `source_assets` | kind, storage_path, thumbnail_path, ocr_text | 内嵌图片 / 附件 |
| `ingest_jobs` | stage, progress, log, pages_created, conflicts | 异步编译任务 |
| `pages` | class_key, slug, body, status, review_status, confidence, tags, aliases, read_when | 原子知识页；含校对状态 |
| `page_sources` | relationship, locator, quote | 页面到来源的锚点 |
| `claims` | subject, predicate, object, confidence, status | 结构化主张 |
| `links` | relation, origin, weight | 类型化图边 |
| `page_revisions` | version, snapshot, editor_id | 页面历史 |
| `ontology_properties` | class_key, key, type, options, required | 本体属性定义 |
| `page_properties` | key, value | 页面属性值 |
| `audit_events` | action, target, actor, detail | 审计 |

### 4.4 派生索引

`page_fts` 与 `source_fts` 是 FTS5 虚拟表；写入时删除旧行再插入，重建索引是幂等操作。页面正文 / 标题 / 标签 / 别名 / `read_when` 都进入索引；`terms` 列保存预切分的中文词元。

---

## 5. 本体设计

### 5.1 内置类型

| key | 名称 | 用途 |
| --- | --- | --- |
| `source` | 文献 | 一份原始资料的编译入口 |
| `concept` | 概念 | 一页一个概念 |
| `entity` | 实体 | 组织、人物、产品、系统 |
| `comparison` | 比较 | 多对象多维对照 |
| `howto` | 方法 | 流程、步骤、清单 |
| `decision` | 决策 | 背景、选项、理由、影响 |
| `note` | 笔记 | 未完全结构化的观察 |

### 5.2 关系

`mentions`（提及）、`derived-from`（源自）、`depends-on`（依赖）、`related-to`（相关）、`contradicts`（矛盾）、`supersedes`（取代）。关系有方向、inverse 名称与颜色；图扩展按关系权重处理。

### 5.3 页面字段

- 标识：`slug`（库内唯一）、`title`、`class_key`；
- 摘要：`summary`、`tldr`；
- 认知：`status`（draft/active/stale/archived）、`confidence` 0–1；
- 检索：`tags`、`aliases`、`read_when`；
- 溯源：`page_sources`、`claims`；
- 治理：`owner_person_id`、`version`、`created_by/updated_by`。

---

## 6. 入库流水线

```text
上传
 → 计算 SHA-256（同库去重）
 → 保存原始文件（不可变）
 → 创建 source + ingest_job（queued）
 → 异步 processJob
      → extract（格式适配）
      → normalize（文本、章节、资产、OCR）
      → update source（ready / failed，元数据与警告）
      → index source（FTS5）
      → compile（文献页、概念页、主张、关联、矛盾）
      → 完成任务（进度、日志、计数）
```

### 6.1 格式适配

| 格式 | 主路径 | 降级 / 备注 |
| --- | --- | --- |
| PDF | 调用 Python `pypdf` 逐页抽取；无文本层时抽取页面图片 OCR | Flate 流 `Tj/TJ` 兜底；纯矢量无图仍提示需外部渲染 |
| DOCX | ZIP + `word/document.xml` | 标题样式、表格、内嵌图片 |
| DOC | LibreOffice → `textutil` | OLE 文本兜底 |
| PPTX | ZIP + `ppt/slides/*.xml` | 每页一节，图片资产 |
| XLSX | ZIP + sharedStrings + worksheet | 多表转 Markdown 表格，500 行截断 |
| TeX | 解析 `\section` / `\abstract` | 清理命令与引用 |
| RTF | `textutil` | 内置控制字 + `\uN` 解析 |
| WPS | 检测 PK → DOCX；OLE → LibreOffice/兜底 | 记录质量警告 |
| 图片 | Tesseract `chi_sim+eng` | `sips` 读尺寸、生成缩略图 |
| Markdown / HTML | 标题与正文 | 支持 `[[wikilink]]` |
| CSV / JSON | 表格化 | 大表截断 |
| ODT / EPUB | ZIP + XML/XHTML | — |

### 6.2 OCR 与资产

- 图片来源：OCR 文本作为文献正文；原图与缩略图写入 `source_assets`。
- Office 内嵌图片：最多 8–10 张，逐张 OCR，识别文本以「图片文字」章节并入文献正文。
- 资产落盘在 `data/uploads/<library>/<source>/assets/`；缩略图在 `data/thumbnails/`。

### 6.3 编译

规则编译器（当前默认）：

1. 创建/更新文献页：摘要、文档结构、关键主张、相关概念、溯源信息。
2. 候选概念：章节标题、定义句主语、关键短语；按“标题 + 定义 + 长度 + 层级”打分。
3. 合并策略：
   - 已有同名/别名页面 → 追加「来自《来源》的补充」，合并标签、提升置信度、追加主张；
   - 不存在 → 新建概念页（`status: draft`，`confidence: 0.5`）。
4. 关联：概念 → 文献 `derived-from`；文献 → 概念 `mentions`；同来源概念互链 `related-to`。
5. 主张：定义/包含/组成/分类/能力/要求等句式；带来源与章节锚点。
6. 矛盾：同一主语 + 同一谓词 + 宾语不同 → 双方 `conflicted`，页面回退为 `draft`，保留双方。
7. 索引：写 FTS；解析正文 `[[slug]]` 建边。

LLM 编译增强（预留接口）：可替换候选抽取与页面撰写；必须保留来源锚点与人工验收，失败时回退到规则编译器。

---

## 7. 检索与知识合成

### 7.1 检索

```text
queryTokens
  → FTS5 MATCH（OR 词元；BM25）
  → 重排：标题覆盖 ×8 + 正文覆盖 ×6 + 置信度 + 时效 + read_when ×2
  → 前 6 个种子一跳图扩展（按边权重降权）
  → 合并结果，返回 signals 分解
```

中文处理：

- 写入：CJK 连续串输出单字 + 双字（+ 短串整体），拉丁词与数字单独分词；
- 查询：同样切分，去掉被长词覆盖的单字噪声；
- 重排时用原始文本计算覆盖度，避免只看词元命中。

为什么不用查询期向量：

- 权限与可解释性优先；知识已编译为原子页；
- 向量只是“说法不同”的补充信号，不应成为默认依赖；
- 若未来引入，只作为补充召回，并保留词法/图信号。

### 7.2 知识合成

- 取 Top 页面，逐页抽取含查询词元的干净句子（去掉 markdown/表格/标题）；
- 去重后组成带 `〔页面标题〕` 引用的答案；
- 返回 `citations`、`gaps`（草稿/单一来源/无结果）、`signals`；
- 可选 LLM：只接收已选中的知识页，要求逐段引用；失败或未配置时回退到编译式答案。

---

## 8. 校对与矛盾裁决

### 8.1 状态

- `review_status`：`unreviewed`（待首次校对）/ `changes_requested`（已退回）/ `approved`（已校对）。
- `status`：`draft` / `active` / `stale` / `archived`。
- 自动编译的概念页：`draft + unreviewed`；人工创建的有效页：`active + approved`；文献页：`active + approved`。

### 8.2 动作

| 动作 | 结果 | 记录 |
| --- | --- | --- |
| 批准 | `active + approved` | 审核人、时间、说明 |
| 要求修改 | `draft + changes_requested` | 必填说明 |
| 撤回校对 | `draft + unreviewed` | 说明 |
| 归档 | `archived + approved` | 说明 |
| 矛盾裁决 | 采用/驳回；另一侧 `resolved` | 审计 |

### 8.3 队列

`GET /api/review` 聚合所有可见库中 `review_status <> approved` 或 `status = draft` 的页面，附带矛盾数、来源数与原因；前端「校对台」支持按知识库、状态过滤。

---

## 9. 权限模型

| 主体 | 解析方式 | 结果 |
| --- | --- | --- |
| 组织管理员 | `persons.is_admin` | 所有库 owner |
| 团队负责人 | 库 `owner_team_id` + `team_members.role='lead'` | owner |
| 团队成员 | 库 `owner_team_id` | editor |
| 个人授权 | `library_grants(subject_type='person')` | 指定角色 |
| 团队授权 | `library_grants(subject_type='team')` | 指定角色 |
| 组织授权 | `library_grants(subject_type='org')` | 指定角色 |
| 可见性 | `private` / `internal` / `public` | 私有仅授权；组织内/公开给 viewer |

规则：

- 角色取最大值（owner > editor > viewer）；
- 无任何角色 → `404`（隐藏存在性）；
- 写操作要求 `editor+`；
- 只读 API Key 不能写；`POST /api/query`、`/api/agent/search|ask|read|graph|lint` 是只读语义；
- 所有查询先在可见库集合内执行 SQL；
- 审计记录写入、授权、删除、编译等关键动作。

---

## 10. 企业微信

### 10.1 设计

```text
WeCom OAuth / 通讯录
  → identity provider（corp_id / agent_id / secret）
  → auth_identities（subject → person）
  → teams.wecom_dept_id / persons.wecom_userid
  → 登录会话 / 团队同步 / 机器人通知
```

### 10.2 当前实现

- Mock OAuth 登录：`GET /api/auth/wecom/start` → Mock 授权页 → `GET /api/auth/wecom/callback` → 按 `wecom_userid` 映射 `persons` → 建立会话；
- 登录页自动探测 `/api/auth/providers`，显示「企业微信登录（Mock）」；
- `wecom_auth_states` 保存 state 与 returnTo（10 分钟有效）；
- 管理员配置 CorpID / AgentID / Secret / Base URL / Authorize Base / Public URL（Secret 不回显）；
- `GET /api/integrations/wecom` 返回映射与回调地址；
- `POST /api/integrations/wecom/sync` 调 QYAPI 拉取部门与成员，生成 dry-run 计划；`{ apply: true }` 执行绑定/建团队；
- 本地默认连接 [wecom-mock](../wecom-mock)，生产切换 `ALEXANDRIA_WECOM_MODE=wecom`。

### 10.3 待接入

- 企业微信机器人消息 → 知识库入口（检索/编译结果通知）；
- 通讯录增量同步、离职停用与冲突处理；
- 真实组织字段（职位、上级、部门负责人）的细粒度映射；
- 多组织/多 CorpID 隔离。

---

## 11. API 设计

- 统一响应：成功直接返回资源；错误 `{ error: { code, message, details, requestId } }`。
- 认证：Cookie 会话或 Bearer API Key。
- 分页：`limit` / `offset`。
- 上传：原始二进制 + 头；返回 `source` 与 `jobId`。
- Agent：见 [API.md](API.md)。

---

## 12. 前端

- 原生 ES Modules，无构建步骤；`web/index.html` + `app.js` + `assets/*` + `views/*`。
- Hash 路由：`#/`、`#/library/:slug`、`#/page/:slug`、`#/search`、`#/upload`、`#/graph`、`#/admin`、`#/agent`、`#/resolve/...`。
- 设计语言：纸张米色、墨色、陶红、玉绿；宋体标题 + 系统无衬线正文；图书馆/档案馆气质。
- 关键交互：目录过滤、页面编辑、拖拽上传 + 任务进度、检索信号分解、图谱力导向、授权管理。
- 可访问性：键盘 `⌘K` 聚焦搜索、语义按钮、错误 toast。

---

## 13. 安全与运维

- 密码 PBKDF2-SHA256（120k 迭代），会话 token 哈希存储；
- Cookie HttpOnly + SameSite=Lax；API Key 只存哈希；
- 响应头：`x-content-type-options`、`x-frame-options`、`referrer-policy`；
- 上传大小限制（默认 80MB）、文件名清理、路径限定在数据目录；
- SQL 全部参数化；上传路径不直接暴露；
- 备份：复制 `data/*.db` + `data/uploads`；FTS 可重建；
- 审计与任务日志用于追溯。

---

## 14. 关键决策（ADR）

### ADR-0001：SQLite 作为单一事实源

- 背景：早期团队规模、零运维、可移植优先；
- 决定：业务表 + FTS5 同库；原始文件在文件系统；
- 后果：单机写并发有限；未来可迁移 PostgreSQL，接口层不暴露 SQLite 特性。

### ADR-0002：入库时编译而不是查询期 RAG

- 背景：企业知识需要累积、可解释、可审计；
- 决定：编译生成原子页 + 主张 + 图；检索走词法 + 图；
- 后果：入库成本更高；需要人工校对队列；查询不依赖外部模型。

### ADR-0003：引擎不内嵌 LLM

- 背景：模型/供应商快速变化，权限与存储应稳定；
- 决定：确定性代码负责一切存储/索引/权限；LLM 通过 Agent API / 可选合成层接入；
- 后果：无 LLM 也能完整运行；LLM 增强需要单独评测。

### ADR-0004：私有库返回 404

- 背景：企业知识库的库名本身可能敏感；
- 决定：无权限访问隐藏存在性；
- 后果：调试时需区分“不存在”和“无权限”，可在审计/管理端查看。

---

## 15. 已知限制与后续

1. 扫描 PDF 已支持抽取页面内嵌图片做 OCR；无可抽取图片的纯矢量 PDF 仍需外部渲染器（如 PyMuPDF/poppler）。
2. 旧版 WPS/DOC 依赖外部转换器；兜底质量有限。
3. 自动编译概念页为草稿，需要校对工作流。
4. 跨库 wikilink 不解析；智能体可跨库检索。
5. 属性表单、可视化本体编辑器、评论、通知、实时协同未实现。
6. 检索质量缺少标注集；下一步建立引用准确率/矛盾关闭率指标。

---

## 16. 验收口径（v0.1）

- 能登录并看到按权限过滤的知识库；
- 能上传 PDF/DOCX/PPTX/XLSX/TEX/RTF/图片/Markdown 中的至少 6 类并完成编译；
- 能检索到新知识页，并能看到信号分解；
- 能给出带引用的“知识合成”答案；
- 私有库对无权限成员 404，搜索不泄漏；
- 智能体 API Key 可检索、可写入（读写密钥），只读密钥写操作 403；
- 页面有版本、来源、主张、关联与图谱；
- `npm test` 全部通过。
