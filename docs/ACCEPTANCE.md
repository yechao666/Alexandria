# Alexandria v0.1 验收报告

> 验收时间：2026-11-12  
> 运行地址：http://127.0.0.1:4520  
> 结论：**核心目标已实现**。全格式入库、知识编译、本体组织、分库权限、检索查询、DSH 智能体接入与企业微信打通均有可运行实现与自动化验证。

## 1. 需求 → 证据

| 目标要求 | 实现 | 验证证据 |
| --- | --- | --- |
| LLM Wiki 理念 | 入库时编译文献页/概念页/主张/关联；查询走已编译知识；矛盾保留并标记 | `server/src/knowledge/compiler.ts`、`tests/knowledge.test.ts`、`tests/review.test.ts` |
| 本体论组织 | 每个库独立类型/属性/关系；页面按类型渲染属性；属性值校验 | `server/src/knowledge/ontology.ts`、`routes/ontology.ts`、`tests/ontology.test.ts` |
| 参考成熟知识库源码 | 研究 Karpathy LLM Wiki、llm-wiki Rust 引擎、BookStack、Outline，并映射设计 | [RESEARCH.md](RESEARCH.md)、[DESIGN.md](DESIGN.md) |
| 图像处理 | Tesseract 中英 OCR、缩略图、扫描版 PDF 页面图片 OCR、内嵌图片 OCR | `server/src/extract/image.ts`、`pdf.ts`、`tests/extract.test.ts` |
| 全面文档支持 | PDF、DOCX、DOC、PPTX、XLSX、TeX、RTF、WPS、图片、Markdown、HTML、CSV、JSON、ODT、EPUB | `tests/formats.test.ts` 覆盖 15 类格式端到端入库 |
| 分库 / 分类组织 | 知识库 → 目录树（书架/分类/主题）→ 知识页/文献；分类号与计数 | `schema.sql`、`routes/libraries.ts`、`web/views/library.js` |
| 团队与组织架构绑定 | 团队树、成员、团队负责人、库 owner team、个人/团队/组织授权 | `domain/access.ts`、`tests/permissions.test.ts` |
| 严格权限 | 库级 owner/editor/viewer；私有库 404；只读 API Key 禁止写；每次查询先过滤 | `http/auth.ts`、`tests/api.test.ts`、`tests/permissions.test.ts` |
| 账户体系 | 本地密码、Cookie 会话、API Key、管理员、WeCom 身份映射 | `schema.sql`、`routes/auth.ts`、`tests/wecom.test.ts` |
| 企业微信打通 | OAuth 登录、通讯录同步、离职停用、加密 XML 回调、JSON 机器人问答、应用消息通知 | `routes/wecom.ts`、`domain/wecom.ts`、`tests/wecom*.test.ts` |
| 核心上传/处理/索引/检索 | 上传 → 解析/OCR → 编译 → FTS5/图谱索引 → 检索/知识合成 | `tests/formats.test.ts`、`tests/knowledge.test.ts`、`tests/api.test.ts` |
| 不使用 RAG | 默认 FTS5 BM25 + 类型化图扩展 + 元数据/时效重排；无查询期向量切块；LLM 仅可选合成 | `knowledge/search.ts`、`docs/DESIGN.md` §7 |
| DSH 智能体 | Agent API（search/ask/read/graph/compile/ingest/page/lint/export）+ SKILL.md | `routes/agent.ts`、`skills/alexandria/SKILL.md`、`tests/api.test.ts` |

## 2. 自动化验证

```bash
cd alexandria
npm run typecheck
DSH_PYTHON=/Users/yechao/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3 npm test
```

最近结果：

- **60 / 60 测试通过**；
- 覆盖：15 类文档格式端到端入库、PDF/扫描 PDF OCR、权限矩阵、知识编译、矛盾裁决、审核、评论/通知、本体属性、Agent 入库/导出、WeCom OAuth/同步/加密回调/机器人问答；
- 演示库 lint：**0 孤儿页、0 断链、3 个待校对草稿**；
- 演示数据：29 个知识页、5 份文献、11 个本体属性、4 个知识库、7 个成员。

## 3. 运行

```bash
cd alexandria
node server/src/seed/run-seed.ts --force  # 可选：重建演示数据
node server/src/main.ts                   # http://127.0.0.1:4520
```

演示账号：`lin@alex.dev` / `alex-demo`（管理员）；`guest@alex.dev`（只读，私有库不可见）。

企业微信联调：`cd ../wecom-mock && node src/server.mjs`（4800），登录页使用「企业微信登录（Mock）」；机器人回调地址根据 Mock Dashboard 配置为 JSON 或加密 XML 模式。

## 4. 已知边界（不阻塞 v0.1 验收）

- 旧版二进制 DOC/WPS 依赖 LibreOffice 或兜底抽取，复杂排版可能不完整；解析降级会写入文献错误/任务日志。
- 没有可抽取图片的纯矢量扫描 PDF 仍需外部渲染器。
- 自动编译概念页默认草稿，需要校对台人工确认。
- 跨知识库 wikilink 暂不解析（按库隔离，智能体可跨库检索）。
- 实时协同编辑、附件在线预览、评论 @ 提醒、LLM 自动编译增强尚未实现。
- 企业微信生产部署需公网回调地址、真实 CorpID/Secret、Token/EncodingAESKey；当前以 Mock 验证协议。

## 5. 验收结论

Alexandria v0.1 已具备企业知识库的核心闭环：**多格式资料入库 → 编译成原子知识页 → 本体组织与权限治理 → 词法/图谱检索 → 带引用知识合成 → 智能体维护与导出**。可作为后续迭代的稳定基线。
