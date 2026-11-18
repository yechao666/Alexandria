# 电力行业知识库重建记录

## 数据备份

重建前的活动数据已移动到：

```text
/Volumes/wd2025/devel/aiworker/alexandria-pre-power-rebuild-20261118
```

包含：

- 旧 SQLite
- uploads
- thumbnails
- backups
- DSH home/work
- git export

原始语料保留在：

```text
data/power-corpus/
data/power-standards/
data/power-standards-fulltext/
```

## 重建结果

活动数据库只保留两个知识库：

```text
电力行业资料库
  文档：206
  类型：CPNN 电力行业公开资料

电力行业标准库
  文档：497
  类型：真实标准 PDF
```

旧演示知识库已删除：

```text
产品知识库
工程手册
研究资料库
战略资料室
```

标准库未再录入：

- stdDetail 跳转页
- 在线预览 HTML
- 只含标准号/范围的条目页

只上传最终的 `standard-fulltext.pdf`。未拿到最终 PDF 的 13 本标准暂不录入。

## 编译

重建后 703 个文档任务全部进入 DSH 编译队列：

- 206 个电力资料
- 497 个标准 PDF

当前 DSH 严格模式：

```text
ALEXANDRIA_REQUIRE_DSH 默认开启
DSH 失败不回退规则编译器
```

队列仍在运行；知识页会随 DSH 编译逐步生成。

## 脚本

```bash
node scripts/rebuild-power-only.mjs
```

脚本特性：

- 删除现有知识库
- 只创建电力行业两个库
- 只上传最终 PDF
- 跳过没有最终 PDF 的标准
- 不导入条目跳转页
