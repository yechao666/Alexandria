# 参考研究：LLM Wiki、图书馆式知识组织与本体论

> 本文记录 Alexandria 设计所依据的外部资料、源码观察与取舍。外部资料只作为参考，不代替本产品的产品决策。

## 1. Karpathy 的 LLM Wiki / Dynamic Knowledge Repository

来源：[Karpathy 的 LLM Wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)；[社区研究综述](https://raw.githubusercontent.com/akitaonrails/ai-memory/v1.10.1/docs/research-karpathy-llm-wiki.md)。

核心论点：

> 多数 LLM + 文档工作流是 RAG：上传文件，查询时检索片段，生成答案。每次提问都重新发现知识，没有积累。LLM Wiki 让模型在**入库时**阅读来源，更新实体页与概念页，标记矛盾，维护交叉引用。

关键设计：

1. **wiki 是编译产物**：Markdown 文件 + typed frontmatter；知识持续累积。
2. **RAG 是即时检索**：wiki 是持久层，RAG 只在需要时作为补充。
3. **交叉引用是预先建立的**：页面之间的链接、来源与概念字段构成图。
4. **LLM 负责阅读与整理**：书签、更新交叉引用、标记矛盾这些“记账工作”由 LLM 完成，人类负责策展与验收。
5. **模式而非应用**：Karpathy 明确这是 idea file，不是特定实现；具体代码由使用者的智能体构建。

对 Alexandria 的影响：

- 编译器在入库时生成“文献页 + 概念页 + 主张 + 关联”，而不是只存原文；
- 矛盾保留双方并标记，而不是让生成模型静默覆盖；
- 页面有 `status` / `confidence` / `read_when` / `sources` / `claims` 等字段；
- 查询以“已编译知识”为主，LLM 合成是可选层。

## 2. llm-wiki：Rust 引擎与 typed graph

来源：[geronimo-iia/llm-wiki](https://github.com/geronimo-iia/llm-wiki)（本地已 clone 并阅读 `README.md`、`docs/overview.md`、`schemas/concept.json`、`src/*`）。

观察到的设计：

- **引擎不做 LLM 调用**：只负责文件、git、全文索引、类型系统与图；工作流写在 skills。这是 Alexandria 把“解析/索引/权限”和“LLM 合成”分开的直接依据。
- **页面 = Markdown + YAML frontmatter**：`title`、`type`、`status`、`last_updated`、`tags`、`aliases`、`read_when`、`tldr`、`sources`、`concepts`、`confidence`、`claims`。
- **JSON Schema + `x-wiki-types` + `x-graph-edges`**：类型声明字段与图边；引擎按 schema 校验页面，按边声明构建类型化图。
- **全文检索用 Tantivy（BM25）**，不是向量；图由 frontmatter 边与正文 `[[wikilink]]` 构建。
- **冲突与追溯**：sources 边指向来源；claims 带 `source` 与 `section`；`superseded_by` 表示被替代。
- **多个空间（spaces）**：一个引擎可注册多个 wiki；每个 wiki 独立 schema/index。
- **工具面**：`wiki_search`、`wiki_content_read`、`wiki_graph`、`wiki_suggest`、`wiki_ingest`、`wiki_lint`、`wiki_stats`、`wiki_export` 等。
- **技能独立**：[llm-wiki-skills](https://github.com/geronimo-iia/llm-wiki-skills) 的 `ingest` 工作流：扫描 inbox → 读来源 → 搜索已有页面判断更新/新建 → 分析概念/主张/矛盾 → 生成计划 → 写入 → 校验/索引 → 移动 raw → 记录结果。

Alexandria 的映射：

| llm-wiki | Alexandria |
| --- | --- |
| wiki space | 知识库（library） |
| schema type | 本体类型（ontology class），每库独立 |
| frontmatter | 页面字段 + `page_properties` |
| sources/concepts 边 | `links` + `page_sources` + 类型化关系 |
| Tantivy BM25 | SQLite FTS5 + 中文预切分 + 重排 |
| MCP tools | REST `/api/agent/*` + SKILL.md |
| git 历史 | `page_revisions` + `audit_events` |
| inbox/raw/wiki | 上传 → 原始文件 → 编译后的知识页 |

## 3. BookStack：图书馆式层级

来源：[BookStack 文档](https://www.bookstackapp.com/docs/)；[BookStack API 结构说明](https://raw.githubusercontent.com/api-evangelist/bookstack/refs/heads/main/apis.yml)。

BookStack 的内容层级：

```
Shelf（书架）
 └── Book（书）
      └── Chapter（章）
           └── Page（页）
```

权限按角色与内容实体授予；页面可以有标签、附件、交叉链接；支持导出与审计。

对 Alexandria 的影响：

- 采用“分库 + 库内目录树”的图书馆隐喻，而不是把所有页面堆在一个扁平空间；
- 目录节点有 `kind`（shelf / section / category）与分类号 `code`，可承载中图法式的编号；
- 文献（source）与知识页（page）都是馆藏对象，但文献保留原始文件，知识页是可引用的编译产物；
- 权限在库级 + 目录继承，而不是每个页面单独配置（降低管理成本；页面级私有可作为后续能力）。

差异：BookStack 以“书/章”作为内容容器；Alexandria 以**本体类型**表达语义，以**目录**表达馆藏位置，两者正交。同一概念可以属于“产品方法”目录，同时类型是“概念”。

## 4. Outline：Collection 成员权限与严格隐藏

来源：[Outline 仓库](https://github.com/outline/outline)；[Collection 权限修复提交](https://github.com/outline/outline/commit/4311aac4ff9a420b79fbfe18d24112bdf0106cb6)；[私有 Collection 越权安全公告](https://github.com/outline/outline/security/advisories/GHSA-h6ff-rw9x-5mq2)。

观察到的设计：

- 文档属于 **Collection**；Collection 有 `private` / 公开可见性；
- `CollectionMembership.permission` 区分 `Read` / `ReadWrite` / `Admin`；
- 无权限访问私有 Collection 时返回 404（隐藏存在性），而不是 403；
- 文档有父子层级；发布到 Collection 时需校验目标 Collection 的创建权限（安全公告正是这个点的回归）；
- 工作区成员 / 群组 / 个人三层授权。

对 Alexandria 的影响：

- 权限模型采用 `owner / editor / viewer`，在库、团队、个人、组织四个主体上解析；
- **先权限过滤，再检索**：搜索的 SQL 只在可见库集合内执行；
- 私有库对无权限成员返回 404；
- 写入校验不仅看文档父级，还看目标库的写权限（Alexandria 的 `requireLibrary(..., 'editor')` 是每次写入的硬门槛）。

## 5. 本体论：类型、属性、关系

参考方向：

- [Anytype](https://anytype.io/)：Object / Type / Property / Relation，类型定义字段，Relation 是双向链接；
- [Palantir Foundry Ontology](https://www.palantir.com/docs/foundry/ontology/overview/)：Object Type、Property、Link Type，面向业务对象；
- [Capacities](https://capacities.io/) / [Tana](https://tana.inc/)：以 typed node 与属性组织个人知识。

对 Alexandria 的影响：

- 每个知识库独立的本体：`ontology_classes`、`ontology_properties`（预留）、`ontology_relations`；
- 页面必须属于一个存在的类型；类型声明字段（JSON）与可用的边；
- 关系有方向、语义与 inverse 名称；图扩展按关系类型加权；
- 类型不是标签：标签是平面的，本体是有约束的图。

当前实现的简化：

- 属性目前以 `page_properties` 与页面元数据承载，尚未做表单级必填校验；
- 关系 schema 的 source/target 类型约束已存储，但写入路径尚未全部强制；
- 自定义类型通过 API 创建，前端提供类型列表，但暂未做可视化本体编辑器。

## 6. 非 RAG 的知识检索

参考：

- SQLite FTS5 文档（BM25、tokenizer、外部内容表）；
- 中文检索实践：unicode61 不识别中文词边界，需要预切分（单字/双字）或自定义 tokenizer；
- 图检索 / 联想路径：Vannevar Bush, *As We May Think* (1945) 的 Memex；
- GraphRAG 等图增强检索的启发：图不是替代词法，而是补充“已存在的关系”。

Alexandria 的检索链路：

```
query
  → queryTokens（CJK 单字/双字 + 拉丁词）
  → FTS5 MATCH（OR 词元，bm25 排序）
  → 覆盖度 / 标题 / 置信度 / 时效 / read_when 重排
  → 前 6 个种子沿 links 一跳扩展
  → 合并、降权、返回信号分解
  → 知识合成（可选 LLM）：只读已编译页面，输出引用与缺口
```

为什么默认不用向量：

- 企业知识库的权限边界与可解释性优先；向量召回难以解释“为什么这条结果相关”；
- 知识被编译成原子页后，词法 + 图已经能覆盖大部分“概念/决策/方法”查询；
- 向量模型引入外部依赖、成本与漂移；应由查询日志证明不足后再引入，并作为补充信号。

## 7. 文档解析与 OCR

- PDF：`pypdf`（文本层）；扫描件需要页面渲染 OCR（当前为已知边界）；
- Office Open XML：DOCX/PPTX/XLSX 本质是 ZIP + XML，直接解析可保留标题、表格与幻灯片结构；
- RTF：macOS `textutil` 优先，内置 RTF 控制字解析兜底；
- WPS：新版本多为 OOXML 兼容格式；旧版为 OLE 复合文档，LibreOffice 优先，OLE 文本兜底；
- 图片：Tesseract `chi_sim+eng`，`sips` 生成缩略图与读取尺寸；
- TeX：解析章节命令、摘要，清理命令与引用，保留正文与公式内容。

这些取舍的共同原则：**先保证不丢文件、不静默失败**；质量降级必须写入任务日志与文献元数据。

## 8. 结论与差异化

Alexandria 不是“又一个 RAG 聊天界面”，而是：

1. **知识编译产品化**：多库、团队权限、本体、审计、文档流水线；
2. **图书馆隐喻**：分库、目录、文献与知识页分离；
3. **智能体原生**：Agent API + SKILL.md，而不是把提示词写进引擎；
4. **可解释检索**：信号分解、来源锚点、矛盾标记、版本历史；
5. **本地优先**：SQLite + 文件系统，零外部服务即可运行。

后续需要补足：扫描 PDF OCR、评论/校对队列、WeCom 完整接入、跨库受控引用、可视化本体编辑器。
