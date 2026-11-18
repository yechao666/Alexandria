# 标准全文入库

## 为什么之前只有一级页面

之前的 510 条标准只录入了：

- 标准号、名称、状态
- 发布/实施日期
- 适用范围
- 起草单位
- 官方条目链接

这些是**标准条目**，不是标准正文。

## 现在的全文链路

```text
hbba 标准详情
  → /attachment/onlineRead/{pk}
  → 解析 Page.size（总页数）
  → /hbba_onlineRead_page/{pk}/{page}.png
  → Pillow 合成 PDF
  → POST /api/sources/:id/fulltext
  → 替换原 source 文件为 standard-fulltext.pdf
  → 可选重新编译
```

- 源文件现在可能是 `standard-fulltext.pdf`（真实标准页面合成的 PDF）。
- 文档预览可以直接翻页阅读。
- 重新编译时，PDF 图片页会走 OCR，生成：
  - 概念
  - 决策（应/不应/宜/不宜/必须/不得条款）
  - 方法（适用范围与实施要点）
  - 实体
  - 文献

## 已完成

- 已实现全文替换接口：`POST /api/sources/:id/fulltext`。
- 已实现整本标准下载、PDF 合成和上传脚本：
  - `scripts/fetch-standard-fulltext.mjs`
  - `scripts/fetch-all-standards-fulltext.mjs`
- 已对部分标准完成真实全文替换和重新编译；当前已完成约 86 本标准 PDF（持续批处理中）。
- 文档详情页现在可以显示：概念 / 决策 / 实体 / 方法 / 文献 五类知识。

## 未完成

- 510 条标准的全量全文下载仍在批处理中；部分标准页数较多（单本 100–223 页）。
- 已生成全量标准“适用范围”方法页，保证条目视图至少有方法/实体/文献/概念等类型。
- 4 本合 PDF 失败的标准需要单独重试。
- 全量 OCR 重编译成本高，当前优先保证真实 PDF 可读，再逐步重编译重点标准。

## 验证样本

`DL/T 3065—2026 涉电力领域市场主体商务信用评价规范`：

- 文件：`standard-fulltext.pdf`
- 知识页 9 个
- 类型：概念 1 / 决策 1 / 实体 5 / 方法 1 / 文献 1
