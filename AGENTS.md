# AGENTS.md — Alexandria 仓库协作约定

本文件面向在此仓库工作的 AI 智能体与开发者。

## 项目

Alexandria 是一个本地优先的企业知识库：

- 服务端：Node 26 + TypeScript（直接运行，无构建）+ `node:sqlite`；
- 前端：原生 ES Modules，无构建步骤；
- 测试：Node 内置 `node:test`；
- 数据：`data/alexandria.db` + `data/uploads/`。

## 命令

```bash
node server/src/main.ts                 # 启动（自动建库；空库会 seed）
node server/src/seed/run-seed.ts --force # 重建演示数据
npm test                                # 全量测试
npm run typecheck                       # tsc（需要 node_modules 中的 TypeScript）
```

开发环境复用 `../aiwo/node_modules`：

```bash
ln -s ../aiwo/node_modules node_modules
```

Python 文档夹具使用捆绑解释器：

```bash
export DSH_PYTHON=/Users/yechao/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3
```

## 代码边界

- `server/src/extract/*`：只负责格式 → 文本/章节/资产，不调用 LLM。
- `server/src/knowledge/*`：分词、FTS、编译器、主张、图、查询。
- `server/src/routes/*`：HTTP 契约；权限检查必须在路由入口完成。
- `web/*`：视图与交互；不要在前端实现权限判断（只做展示层禁用）。
- 数据库变更：修改 `schema.sql`，并考虑已有库的迁移；当前 v1 基线。
- 新增文件格式：实现 `ExtractResult`，接入 `extract/index.ts` 路由，补测试。

## 约定

1. **权限**：任何读取/写入先走 `requireLibrary`；私有库无权限返回 404。
2. **索引**：页面写入必须更新 `page_fts` 与 `links`；FTS 是派生数据，可在 `rebuildIndexes` 重建。
3. **编译**：自动生成的页面为 `draft`；矛盾保留双方，不静默覆盖。
4. **错误**：面向用户的中文 message；任务失败必须写 `sources.error` 与 `ingest_jobs.error`。
5. **测试**：行为变更必须加测试；不要依赖网络或真实企业微信。
6. **密钥**：不要提交 `.env`、数据库、上传文件；演示密码仅用于 seed。
7. **文档**：更新 API/设计时同步 `docs/` 与 `README.md`。
8. **中文**：产品文案、注释与文档以中文为主；代码标识符用英文。

## 关键文件

| 文件 | 作用 |
| --- | --- |
| `server/src/db/schema.sql` | 数据模型与 FTS5 |
| `server/src/knowledge/compiler.ts` | 入库编译 |
| `server/src/knowledge/search.ts` | 检索、知识合成、图 |
| `server/src/ingest/pipeline.ts` | 上传、解析、OCR、任务 |
| `server/src/http/auth.ts` | 会话、API Key、权限入口 |
| `server/src/seed/seed.ts` | 演示组织与知识内容 |
| `web/app.js` | 路由与页面装配 |
| `web/views/*` | 页面 |
| `skills/alexandria/SKILL.md` | DSH 工作流 |

## 验证

```bash
npm run typecheck
DSH_PYTHON=... npm test
```

如果需要 UI 验证，可用本机 Chrome headless 截屏（参见历史命令），但不要提交截图之外的大文件。
