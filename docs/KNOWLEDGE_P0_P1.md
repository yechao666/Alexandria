# 知识语义层 P0/P1/P2 完成记录

## P0：实体与决策抽取

- `server/src/knowledge/dsh-engine.ts`
  - DSH 输出新增 `decisions[]`。
  - 决策页字段：决策、依据、备选方案、责任主体、生效日期、状态。
  - 决策属性按本体的枚举值映射（active → 已采纳，superseded → 已废弃）。
  - 决策页关联来源页、主张与相关概念。
- `server/src/knowledge/compiler.ts`
  - 规则编译新增组织/标准/设备实体抽取。
  - 政策类资料新增决策回退抽取（决定/规定/印发/批复）。
  - 自动推断生效日期。
- 电力行业资料库重编译：
  - 206 篇全部走规则重编译。
  - 617 个实体页。
  - 13 个决策页。
  - 部分高价值页面通过 DSH 抽取决策与实体。

## P1：Schema、消歧、矛盾与时效

- 页面必填属性校验：缺必填属性时拒绝写入。
- 实体消歧：规范化名称、别名、包含关系、二元组相似度兜底。
- `pages.effective_date` / `expires_at` / `superseded_at`。
- `contradictions` 表：claim、rival claim、severity、owner、status、effective_date。
- 冲突中心返回 contradiction id / severity / effective date。
- `PATCH /api/contradictions/:id` 支持 owner、severity、effective date 与状态。
- 决策页自动写入生效日期。

## P2：互操作

- `POST /mcp` JSON-RPC 2.0：
  - `initialize`
  - `tools/list`
  - `tools/call`：`search`、`read`、`graph`、`write_page`、`lint`
- Markdown + git 导出：`node scripts/wiki-git-sync.mjs`
- 块级引用：
  - Markdown 支持 `[[page#h-anchor]]`。
  - 解析到目标页后按 block 参数滚动到对应标题。
- 块级编辑器：
  - `GET /api/pages/:id/blocks`
  - `PATCH /api/pages/:id/blocks/:blockId`
  - 页面内“块编辑”弹窗只替换选中章节。
- 实时同步：
  - `GET /api/events` SSE。
  - 页面更新/块更新后向同库在线客户端推送 `page.updated`。
  - 页面打开时订阅；他人更新会提示并自动刷新。
- 并发保护：页面编辑携带 version，过期版本返回 409。
- 页面目录已使用标题锚点。

## 未完成

- 多人同时编辑的 CRDT/OT 合并与多人光标。
- SSE 目前是更新通知/自动刷新，不是字符级协同。

## 验证

```bash
npm test          # 100/100
npm run typecheck # 通过
```
