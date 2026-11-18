# 正则预抽取规则

## 位置

```text
管理 → 正则规则
```

公共规则只允许组织管理员维护；项目规则需要知识库编辑权限。

## 执行顺序

```text
文档解析 / OCR
  → 正则预抽取（公共 + 项目规则）
  → DSH 编译（严格模式，失败不回退）
  → 概念 / 实体 / 决策 / 方法 / 文献
```

正则匹配结果会：

1. 写入 `source.metadata.regex`；
2. 出现在文档详情「正则预抽取」；
3. 作为「必须优先采用」的结构化提示注入 DSH prompt。

## 内置公共规则（20 条）

- 邮箱
- 手机号
- 固定电话
- 身份证号
- 邮政编码
- 统一社会信用代码
- 银行卡号
- 合同编号
- 快递单号
- 发票号码
- URL
- IPv4
- 日期
- 标准编号
- 金额
- 百分比
- 车牌号
- 护照号
- 经纬度
- 合同金额

## 重叠抑制

同一文本片段只保留优先级更高的规则结果：

```text
18 位身份证号  → 不再同时被识别为银行卡号 / 统一社会信用代码 / 发票号
手机号        → 不再同时被识别为发票号码
```

发票号要求上下文（`发票号码` / `发票号` / `Invoice No`），合同编号要求字母前缀 + 连字符。

## API

```text
GET    /api/regex-rules?library=<slug>
POST   /api/regex-rules
PATCH  /api/regex-rules/:id
DELETE /api/regex-rules/:id
```

字段：

```json
{
  "name": "邮箱",
  "category": "联系方式",
  "pattern": "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}",
  "flags": "gi",
  "captureGroup": 0,
  "scope": "public",
  "libraryId": null,
  "enabled": true,
  "priority": 10
}
```

## DSH 强制模式

当 `ALEXANDRIA_REQUIRE_DSH` 不为 `0` 且本机 DSH 可用时：

- 新上传任务强制标记为 `dsh`；
- `reprocess` 也强制为 `dsh`；
- DSH 失败会直接失败，不再回退规则编译器。

开发/测试环境可用：

```bash
ALEXANDRIA_REQUIRE_DSH=0
```

恢复规则回退。
