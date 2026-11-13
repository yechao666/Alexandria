# Alexandria 企业控制台 UI

## 设计基线

Alexandria 的 Web 控制台对齐同工作区的 **AIWO / Mnemos / Hive / Haos** 控制台，使用同一套 “Aurora Console” 视觉语言：

- 深空黑底 + 极光紫/青渐变，而不是纸张、暖色、衬线字。
- 1px 发丝描边、玻璃浮层、紧凑的信息密度。
- 左侧组织/知识库导航 + 顶栏全局检索/状态/操作。
- 以 KPI、表格、任务/待办、权限状态为主，而不是编辑式大标题。
- 数据优先：页面标题、正文、列表都使用系统无衬线字体，减少装饰性留白。

参考来源：

- `aiwo/web/src/styles/tokens.css`、`components.css`：Aurora Console tokens 与卡片/按钮组件。
- `mnemos/web/src/styles/tokens.css`：同一套深色控制台 tokens。
- `hive/web/src/styles/tokens.css`：同源视觉基线。

## 布局

```text
┌──────────────┬────────────────────────────────────────────┐
│ 品牌 / 工作区 │ 面包屑   实时  PRODUCTION   全局检索  通知 操作 │
│              ├────────────────────────────────────────────┤
│ 工作台        │ 页面标题 / 说明 / 主操作                     │
│ 知识库        │ KPI 卡片                                     │
│ 管理          │ 主内容（表格 / 文档 / 图谱） + 右栏信息       │
│              │                                            │
│ 用户 / 安全   │                                            │
└──────────────┴────────────────────────────────────────────┘
```

## 关键 tokens

| Token | 值 | 用途 |
| --- | --- | --- |
| `--bg` | `#06070b` | 应用背景 |
| `--paper` | `#0a0c12` | 面板表面 |
| `--paper-2` | `#0d1017` | 次级表面/输入框 |
| `--ink` | `#eef1f8` | 主文本 |
| `--muted` | `#8d94a8` | 次级文本 |
| `--line` | `rgba(255,255,255,.078)` | 发丝描边 |
| `--clay` | `#8b7cff` | 主品牌/主按钮 |
| `--jade` | `#34d399` | 成功/运行 |
| `--ochre` | `#fbbf24` | 警告/待处理 |
| `--teal` | `#38d4f0` | 信息/链接强调 |
| `--radius` | `12px` | 面板/卡片圆角 |
| `--sidebar` | `258px` | 导航宽度 |

主按钮使用 `linear-gradient(135deg, #8b7cff, #6f7dff 48%, #46c8f5)`，深色文字以保证对比度；危险操作使用红色 tint，不改变全局主题。

## 页面规范

- **登录**：左侧 Aurora 品牌叙事（简短、非文学化）+ 右侧登录卡片；支持 SSO/企微入口与演示账号。
- **知识总览**：KPI（知识资产/资料/待校对/成员）+ 知识库表格 + 最近更新 + 待办/构成/组织。
- **知识库**：紧凑标题、统计、目录、知识页卡片/表格；页内 tab 使用下划线高亮。
- **知识页**：正文 + 右侧元数据 rail（层级/访问/校对/来源/评论/主张/关联）。
- **校对台**：筛选条、批量操作、冲突中心、报表。
- **管理控制台**：左侧二级导航、团队卡片、权限矩阵、运行状态、安全审计、校对报表。
- **任务中心**：队列 KPI + 任务表格/步骤抽屉。

## 可用性

- 最小点击宽度 28px；主操作 34px。
- 颜色不是唯一状态信号：状态同时有文本/图标。
- 移动端：侧栏折叠为菜单，KPI 两列，文档 rail 下移。
- 支持 `prefers-reduced-motion` 时关闭过渡（保留基本反馈）。

## 截图

- [登录](screenshots/29-login-enterprise.png)
- [知识总览](screenshots/30-home-enterprise.png)
- [知识库文件页](screenshots/34-library-docs-enterprise.png)
- [文件与关联知识](screenshots/35-drive-selected-enterprise.png)
- [文件预览](screenshots/36-file-preview-enterprise.png)
- [图片预览](screenshots/37-file-preview-image-enterprise.png)
- [知识页](screenshots/31-page-enterprise.png)
- [管理控制台](screenshots/31-admin-enterprise.png)
- [知识校对](screenshots/31-review-enterprise.png)
- [导入资料](screenshots/33-upload-enterprise.png)
- [处理任务](screenshots/33-tasks-enterprise.png)
- [知识图谱](screenshots/33-graph-enterprise.png)
- [文档中心](screenshots/34-documents-enterprise.png)
- [文档详情](screenshots/34-source-enterprise.png)
