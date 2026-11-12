import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db/index.ts';
import type { Env } from '../env.ts';
import type { Actor, PageRow } from '../types.ts';
import { hashPassword } from '../lib/password.ts';
import { newId, nowIso } from '../lib/ids.ts';
import { ensureDefaultOntology } from '../knowledge/ontology.ts';
import { createPage, addLink, attachSource } from '../knowledge/pages.ts';
import { saveClaims } from '../knowledge/claims.ts';
import { actorFor } from '../domain/access.ts';
import { ingestBuffer, ingestText, processJob } from '../ingest/pipeline.ts';
import { audit } from '../domain/audit.ts';

const DEMO_PASSWORD = 'alex-demo';

interface PersonSeed {
  id: string;
  email: string;
  name: string;
  title: string;
  color: string;
  admin?: boolean;
  wecom?: string;
}

const PERSONS: PersonSeed[] = [
  { id: 'usr_lin', email: 'lin@alex.dev', name: '林知远', title: '知识运营负责人', color: 'clay', admin: true, wecom: 'LinWei' },
  { id: 'usr_shen', email: 'shen@alex.dev', name: '沈书言', title: '知识策展人', color: 'jade', wecom: 'SuYan' },
  { id: 'usr_zhou', email: 'zhou@alex.dev', name: '周砚', title: '平台工程师', color: 'indigo', wecom: 'YeChao' },
  { id: 'usr_su', email: 'su@alex.dev', name: '苏禾', title: '产品经理', color: 'ochre', wecom: 'ChenHao' },
  { id: 'usr_chen', email: 'chen@alex.dev', name: '陈屿', title: '市场分析师', color: 'plum' },
  { id: 'usr_guest', email: 'guest@alex.dev', name: '访客', title: '只读成员', color: 'slate' },
  { id: 'usr_agent', email: 'agent@alex.dev', name: 'DSH 编译智能体', title: '服务账号', color: 'teal' },
];

const TEAMS = [
  { id: 'team_hq', name: '总部', slug: 'hq', parent: null, desc: '组织管理与战略', lead: 'usr_lin' },
  { id: 'team_eng', name: '研发中心', slug: 'engineering', parent: 'team_hq', desc: '平台、文档流水线与基础设施', lead: 'usr_zhou', wecom: '1' },
  { id: 'team_product', name: '产品设计部', slug: 'product', parent: 'team_hq', desc: '产品策略、用户研究与体验', lead: 'usr_su', wecom: '2' },
  { id: 'team_market', name: '市场部', slug: 'market', parent: 'team_hq', desc: '市场洞察与竞争分析', lead: 'usr_chen' },
  { id: 'team_knowledge', name: '知识运营组', slug: 'knowledge-ops', parent: 'team_eng', desc: '知识治理、编译质量与本体维护', lead: 'usr_shen' },
];

const LIBRARIES = [
  {
    id: 'lib_product',
    slug: 'product-wiki',
    name: '产品知识库',
    description: '产品方法、用户研究、需求评审与路线图；由产品设计部维护。',
    icon: 'compass',
    color: 'clay',
    visibility: 'internal',
    team: 'team_product',
    nodes: [
      { id: 'cat_p_method', name: '产品方法', slug: 'product-methods', kind: 'shelf', code: 'A', desc: '方法论与框架' },
      { id: 'cat_p_research', name: '用户研究', slug: 'user-research', kind: 'section', code: 'A.1', desc: '访谈、观察与洞察' },
      { id: 'cat_p_review', name: '需求与评审', slug: 'requirements', kind: 'section', code: 'A.2', desc: '需求质量与决策' },
      { id: 'cat_p_market', name: '竞品与市场', slug: 'competition', kind: 'section', code: 'B', desc: '竞争格局与定位' },
    ],
  },
  {
    id: 'lib_eng',
    slug: 'engineering-handbook',
    name: '工程手册',
    description: '架构决策、文档流水线、检索与运维；由研发中心维护。',
    icon: 'terminal',
    color: 'jade',
    visibility: 'internal',
    team: 'team_eng',
    nodes: [
      { id: 'cat_e_arch', name: '架构与决策', slug: 'architecture', kind: 'shelf', code: 'A', desc: 'ADR 与系统设计' },
      { id: 'cat_e_pipe', name: '文档流水线', slug: 'document-pipeline', kind: 'section', code: 'B', desc: '解析、OCR 与编译' },
      { id: 'cat_e_search', name: '检索与索引', slug: 'retrieval', kind: 'section', code: 'C', desc: 'FTS、图谱与查询' },
      { id: 'cat_e_ops', name: '运维手册', slug: 'operations', kind: 'section', code: 'D', desc: '部署、备份与故障处理' },
    ],
  },
  {
    id: 'lib_research',
    slug: 'research-lab',
    name: '研究资料库',
    description: '论文、知识管理理论与前沿实践；由知识运营组维护。',
    icon: 'flask',
    color: 'ochre',
    visibility: 'internal',
    team: 'team_knowledge',
    nodes: [
      { id: 'cat_r_papers', name: '论文与文献', slug: 'papers', kind: 'shelf', code: 'A', desc: '原始文献与阅读笔记' },
      { id: 'cat_r_theory', name: '知识理论', slug: 'knowledge-theory', kind: 'section', code: 'B', desc: 'Memex、本体与知识编译' },
    ],
  },
  {
    id: 'lib_strategy',
    slug: 'strategy-vault',
    name: '战略资料室',
    description: '年度战略、定价与董事会材料；仅总部与授权成员可见。',
    icon: 'lock',
    color: 'plum',
    visibility: 'private',
    team: 'team_hq',
    nodes: [
      { id: 'cat_s_year', name: '年度战略', slug: 'annual-strategy', kind: 'shelf', code: 'S', desc: '战略纲要与关键战役' },
      { id: 'cat_s_price', name: '商业化', slug: 'commercial', kind: 'section', code: 'S.1', desc: '定价与商业模式' },
    ],
  },
];

interface PageSeed {
  library: string;
  node: string;
  classKey: string;
  slug: string;
  title: string;
  summary: string;
  tldr: string;
  tags: string[];
  aliases?: string[];
  readWhen: string[];
  confidence: number;
  body: string;
  owner?: string;
  claims?: { text: string; subject: string; predicate: string; object: string; confidence?: number }[];
  properties?: Record<string, unknown>;
}

const PAGES: PageSeed[] = [
  {
    library: 'lib_product',
    node: 'cat_p_method',
    classKey: 'concept',
    slug: 'concepts/knowledge-compilation',
    title: '知识编译',
    summary: '在资料入库时把原文读懂、拆成原子知识页、抽取主张并维护交叉引用，而不是等提问时再检索原文片段。',
    tldr: '知识在入库时被编译一次，之后被持续引用、修订和交叉验证。',
    tags: ['知识管理', 'LLM Wiki', '编译', 'DKR'],
    aliases: ['Knowledge Compilation', '编译式知识库'],
    readWhen: ['设计知识库架构时', '讨论为什么不用查询期 RAG 时', '需要向团队解释知识沉淀机制时'],
    confidence: 0.92,
    owner: 'usr_shen',
    properties: { domain: '知识管理' },
    body: `## 定义
知识编译（Knowledge Compilation）是一种把原始资料在**入库时**转化为结构化、可链接知识页的做法。编译器会阅读来源，识别概念、主张与关系，更新已有的概念页，标记矛盾，并保留原始文件作为证据。

## 为什么要编译
传统查询式 RAG 每次提问都重新切块、检索、拼凑答案，知识不会累积。编译式知识库把理解成本前移一次：
- 概念有稳定的主页与定义，而不是散落在不同 chunk 里；
- 交叉引用是预先建立的，查询时可以沿图扩展；
- 矛盾在入库时就被保留和标记，而不是被生成模型静默抹平；
- 人工校对的成果会留在页面上，下次查询直接受益。

## 编译产物
- 文献页：一份来源的入口、结构与关键主张；
- 概念页：一个概念一页，包含定义、要点、来源与开放问题；
- 主张（claim）：可比较、可追溯的结构化陈述；
- 关联：来自正文的 \`[[wikilink]]\` 与本体声明的类型化边。

## 与图谱检索的关系
编译负责“把知识写出来”，检索负责“沿已写好的路径找到它”。两者共同替代查询期 RAG，而不是在其上再加一层向量库。

## 开放问题
- 自动编译的概念页需要多少人工校对才能达到可引用质量？
- 当来源之间冲突时，置信度应该如何传播？`,
    claims: [
      { text: '知识编译在资料入库时完成理解、拆页、抽取主张与建立交叉引用。', subject: '知识编译', predicate: '定义', object: '入库时把资料转化为结构化知识页的过程', confidence: 0.9 },
      { text: '编译式知识库把理解成本前移一次，使知识可以累积。', subject: '知识编译', predicate: '价值', object: '理解成本前移与知识累积', confidence: 0.8 },
    ],
  },
  {
    library: 'lib_product',
    node: 'cat_p_method',
    classKey: 'concept',
    slug: 'concepts/atomic-page',
    title: '原子知识页',
    summary: '一页只讲清一个概念或一个决策，有稳定 slug、明确边界和可追溯来源。',
    tldr: '原子化是可链接、可复用、可审计的前提。',
    tags: ['知识组织', '原子化', '页面'],
    aliases: ['Atomic Page'],
    readWhen: ['设计页面结构时', '判断一个主题该拆成几页时'],
    confidence: 0.85,
    owner: 'usr_shen',
    body: `## 定义
原子知识页是知识库中最小的可引用单元：一个概念、一个方法、一个决策或一个实体。它有稳定的 slug，一个清晰的标题，一段能独立成立的摘要，以及指向来源与相邻概念的链接。

## 判断标准
- **可独立引用**：脱离上下文也能说明它是什么；
- **边界清楚**：与相邻概念有明确的“不属于本页”的说明；
- **来源可追溯**：每条关键主张都能落到具体文献与章节；
- **可演化**：新来源可以追加，而不是整页推倒重写。

## 反例
把一份 40 页的产品手册直接作为一个页面，既无法被精准引用，也无法在局部修订时保持历史。正确做法是拆成 [[concepts/knowledge-compilation|知识编译]] 产出的概念页与文献页。

## 命名
标题使用领域内的稳定名词；slug 使用小写与连字符，中文标题保留中文 slug，保证可读性。`,
    claims: [{ text: '原子知识页是知识库中最小的可引用单元。', subject: '原子知识页', predicate: '定义', object: '最小可引用单元', confidence: 0.9 }],
  },
  {
    library: 'lib_product',
    node: 'cat_p_method',
    classKey: 'concept',
    slug: 'concepts/ontology',
    title: '本体论',
    summary: '用类型、属性与关系描述一个领域，让知识页不只是文章，而是可校验、可推理的结构化对象。',
    tldr: '本体给知识一具骨架：类型决定字段，关系决定图。',
    tags: ['本体', 'Ontology', '类型系统', '知识图谱'],
    aliases: ['Ontology', '本体模型'],
    readWhen: ['新增知识类型时', '设计权限与分类体系时', '需要让智能体按结构写入时'],
    confidence: 0.88,
    owner: 'usr_lin',
    properties: { domain: '知识管理' },
    body: `## 定义
本体论（Ontology）在这里指一套显式的领域模型：**类型（Class）**、**属性（Property）** 与 **关系（Relation）**。每个知识页都属于某个类型，携带该类型声明的字段，并可以通过类型化关系连接到其它页面。

## 三层结构
| 层 | 作用 | 例子 |
| --- | --- | --- |
| 类型 | 决定页面语义与字段 | 概念、文献、决策、方法 |
| 属性 | 结构化描述对象 | 决策时间、置信度、适用边界 |
| 关系 | 建立可遍历的边 | 源自、依赖、矛盾、取代 |

## 与传统标签的区别
标签是平面的，本体是带约束的图。标签只能回答“和什么有关”，本体还能回答“以什么方式相关”以及“这种关系是否合法”。

## 在本产品中的落点
- 每个知识库有独立的本体，可随领域演进；
- 页面写入时校验类型是否存在；
- 关系进入类型化图谱，检索时按关系类型加权扩展。`,
    claims: [
      { text: '本体由类型、属性与关系三层构成。', subject: '本体论', predicate: '定义', object: '类型、属性与关系构成的领域模型', confidence: 0.9 },
      { text: '标签是平面的，本体是带约束的图。', subject: '本体论', predicate: '对比', object: '标签平面、本体带约束', confidence: 0.8 },
    ],
  },
  {
    library: 'lib_product',
    node: 'cat_p_method',
    classKey: 'comparison',
    slug: 'comparisons/rag-vs-compiled',
    title: '查询期 RAG 与编译式知识库',
    summary: '两条路线的对照：一个在提问时重新发现知识，一个在入库时沉淀知识；本产品选择后者为主、词法与图谱为辅。',
    tldr: 'RAG 优化“检索片段”，编译优化“知识本身”。',
    tags: ['RAG', '知识编译', '架构选型'],
    readWhen: ['评估知识库方案时', '向决策层解释为什么不用向量数据库时'],
    confidence: 0.86,
    owner: 'usr_lin',
    body: `## 对照表
| 维度 | 查询期 RAG | 编译式知识库 |
| --- | --- | --- |
| 知识形成时间 | 每次提问时 | 资料入库时一次 |
| 产物 | 临时片段 | 稳定知识页 + 主张 + 图 |
| 交叉引用 | 临时拼接 | 预先维护 |
| 矛盾处理 | 常常被生成模型抹平 | 保留双方并标记 |
| 可审计性 | 弱，取决于本次检索 | 强，可追溯到来源与版本 |
| 主要成本 | 查询时反复推理 | 入库时编译与人工校对 |

## 本产品的选择
核心走编译路线，检索由三部分组成：
1. SQLite FTS5 词法匹配（中文按单字/双字切分）；
2. 预编译关联图的邻域扩展；
3. 元数据、时效、置信度与 read_when 重排。

不把 embedding 当作默认依赖，避免“为了检索而检索”。LLM 仅在需要自然语言合成时可选接入，而且只能引用已编译页面。

## 什么时候仍需要向量
当语料极大、查询表达与页面用词差异极大、且没有足够人工维护本体时，向量召回可以作为补充信号。但它不应取代知识编译。`,
    claims: [{ text: '本产品以知识编译为主，词法检索与图谱扩展为辅，不默认依赖向量检索。', subject: 'Alexandria 检索策略', predicate: '架构', object: '编译式知识库 + FTS5 + 图谱扩展', confidence: 0.9 }],
  },
  {
    library: 'lib_product',
    node: 'cat_p_review',
    classKey: 'howto',
    slug: 'howtos/requirement-review',
    title: '需求评审',
    summary: '在产品需求进入研发前，用固定清单检查价值、边界、验收标准与风险，并留下可追踪的决策记录。',
    tldr: '评审不是走过场，而是把“做什么、为什么、怎样算完成”固定下来。',
    tags: ['需求', '评审', '流程', '验收'],
    aliases: ['PRD 评审'],
    readWhen: ['准备发起需求评审时', '作为评审主持人时', '检查需求是否可进入开发时'],
    confidence: 0.82,
    owner: 'usr_su',
    properties: { prerequisites: 'PRD、目标用户、非目标、可验证验收标准' },
    body: `## 前置条件
- 需求文档包含背景、目标用户、范围与非目标；
- 至少有一个可验证的验收标准；
- 依赖方（设计、研发、数据）已提前阅读。

## 流程
1. **价值确认**：这个问题值得现在解决吗？不做的代价是什么？
2. **边界确认**：本期做什么、不做什么，哪些是后续版本。
3. **方案取舍**：至少一个备选方案与选择理由。
4. **验收标准**：可测量、可复现、可演示。
5. **风险与依赖**：上线风险、数据迁移、合规与回滚方案。
6. **决策记录**：形成 [[decisions/decision-log|决策记录]]，指定负责人和截止时间。

## 常见失败
- 只讨论方案，不确认问题；
- 验收标准是“体验好”“稳定”，无法验证；
- 评审后没有决议记录，下一次会议重新争论。

## 与知识库的关系
评审结论应写入知识页，而不是散落在聊天记录。下次相似需求可以直接引用历史 [[decisions/decision-log|决策记录]]。`,
  },
  {
    library: 'lib_product',
    node: 'cat_p_research',
    classKey: 'howto',
    slug: 'howtos/user-interview',
    title: '用户访谈',
    summary: '用半结构化访谈获取真实行为与动机，避免把用户的自述当成需求。',
    tldr: '问过去发生的事，不问未来会不会用。',
    tags: ['用户研究', '访谈', '洞察'],
    aliases: ['深度访谈'],
    readWhen: ['准备用户访谈提纲时', '分析访谈记录时'],
    confidence: 0.84,
    owner: 'usr_su',
    body: `## 抽样
按行为而非人口属性抽样：最近 30 天实际使用过、尝试后放弃、从未使用但符合目标画像的人各取若干。

## 提纲结构
1. 最近一次相关场景（时间、地点、触发事件）；
2. 实际动作与工具；
3. 卡点与替代方案；
4. 结果与代价；
5. 如果重来一次会怎么做。

## 提问禁忌
- “你会用这个功能吗？”——得到的是礼貌性预测；
- “你觉得这个设计好不好？”——得到的是审美判断；
- 连续追问“为什么”而不回到具体事件。

## 编码与沉淀
访谈结束后 24 小时内完成编码：场景、目标、障碍、现有替代、原话证据。将结论写入 [[concepts/jobs-to-be-done|JTBD]] 或洞察页，并链接到原始记录。`,
    claims: [{ text: '用户访谈应询问过去发生的行为，而不是预测未来是否会使用。', subject: '用户访谈', predicate: '原则', object: '问过去行为而非未来意愿', confidence: 0.85 }],
  },
  {
    library: 'lib_product',
    node: 'cat_p_research',
    classKey: 'concept',
    slug: 'concepts/jobs-to-be-done',
    title: 'Jobs to be Done',
    summary: '用户“雇佣”产品来完成某项进步；关注情境、动机与替代方案，而非用户画像标签。',
    tldr: '用户不是买产品，而是雇它完成一项任务。',
    tags: ['JTBD', '用户研究', '产品方法'],
    aliases: ['待办任务', 'Jobs-to-be-Done'],
    readWhen: ['定义产品价值主张时', '分析用户为什么流失时'],
    confidence: 0.8,
    owner: 'usr_su',
    body: `## 核心句式
当我【情境】，我想要【动机】，以便【预期结果】。

## 三个维度
- **功能任务**：要完成的具体事情；
- **情感任务**：希望被如何看待、如何感受；
- **社会任务**：在他人眼中的身份与关系。

## 与用户画像的区别
画像描述“谁”，JTBD 描述“在什么情境下想取得什么进步”。同一个用户在 different 情境下会有不同任务，因此 [[howtos/user-interview|用户访谈]] 必须回到具体事件。`,
  },
  {
    library: 'lib_product',
    node: 'cat_p_market',
    classKey: 'concept',
    slug: 'concepts/competitive-landscape',
    title: '竞争格局',
    summary: '不是列竞品功能表，而是识别用户在相同任务下的替代方案、切换成本与我们的差异位置。',
    tldr: '竞争发生在用户的任务里，不在功能清单里。',
    tags: ['竞品', '市场', '定位'],
    readWhen: ['制定产品定位时', '准备竞品分析汇报时'],
    confidence: 0.75,
    owner: 'usr_chen',
    body: `## 分析框架
1. 用户在完成同一 [[concepts/jobs-to-be-done|JTBD]] 时有哪些替代方案（含 Excel、人工流程）？
2. 各方案的切换成本、学习成本与信任成本；
3. 我们的差异是能力差异、体验差异还是商业模式差异；
4. 差异是否可被复制，复制需要多久。

## 输出
一页结论 + 一张二维定位图 + 三条可验证的假设。不要输出 50 页功能对比表。`,
  },
  {
    library: 'lib_product',
    node: 'cat_p_review',
    classKey: 'decision',
    slug: 'decisions/decision-log',
    title: '决策记录',
    summary: '把关键决策的背景、选项、理由与影响写成一页，供未来的人复用而不是重新争论。',
    tldr: '决策会过期，但决策的理由值得保留。',
    tags: ['决策', 'ADR', '治理'],
    readWhen: ['做架构或产品决策时', '复盘为什么选择某方案时'],
    confidence: 0.83,
    owner: 'usr_lin',
    body: `## 模板
- **背景**：为什么现在必须决定；
- **选项**：至少两个真实可选项；
- **决定**：选择了什么；
- **理由**：依据什么证据与约束；
- **影响**：谁会受影响，何时复查；
- **状态**：提议 / 已采纳 / 已废弃。

## 反模式
只写“决定采用 X”，不写为什么不选 Y；把决策写成会议纪要，没有明确负责人。`,
  },
  {
    library: 'lib_eng',
    node: 'cat_e_arch',
    classKey: 'concept',
    slug: 'concepts/dsh-runtime',
    title: 'DSH 运行时',
    summary: 'DeepSeek Harness 的会话、工具、技能与插件运行时；知识库把编译与查询能力暴露给 DSH 智能体。',
    tldr: 'DSH 负责执行智能体工作，Alexandria 负责知识的持久化与治理。',
    tags: ['DSH', 'Agent', '运行时'],
    aliases: ['DeepSeek Harness'],
    readWhen: ['接入智能体时', '设计工具与技能边界时'],
    confidence: 0.8,
    owner: 'usr_zhou',
    body: `## 职责边界
- DSH：会话、工具调用、子智能体、插件与技能；
- Alexandria：知识页、本体、权限、索引、编译任务；
- 二者通过 HTTP API 与 API Key 连接，智能体不需要理解数据库。

## 为什么不在 DSH 里做知识存储
知识需要版本、权限、审计与跨会话复用；这些属于服务端状态，不应该绑在单次会话或某个智能体的上下文中。

## 接入方式
智能体读取 \`/api/agent/manifest\`，用 \`search → read → upsert_page\` 的循环维护知识；技能文件 \`skills/alexandria/SKILL.md\` 描述工作流与质量约束。具体解析链路见 [[concepts/document-pipeline|文档解析流水线]]。`,
  },
  {
    library: 'lib_eng',
    node: 'cat_e_search',
    classKey: 'concept',
    slug: 'concepts/sqlite-fts5',
    title: 'SQLite FTS5',
    summary: '零外部依赖的全文索引；中文通过单字/双字预切分获得可用的词法召回。',
    tldr: '先把中文切成词元，再让 FTS5 做 BM25。',
    tags: ['SQLite', 'FTS5', '检索', '分词'],
    aliases: ['FTS5'],
    readWhen: ['实现搜索时', '排查中文检索召回时'],
    confidence: 0.87,
    owner: 'usr_zhou',
    body: `## 为什么选 FTS5
知识库需要可解释的检索与零运维。FTS5 内置于 SQLite，支持 BM25 排序，索引可随时从页面重建。

## 中文处理
unicode61 分词器不识别中文词边界。Alexandria 在写入索引前把中文切成**单字 + 双字**，查询时用同样的切分构造 OR 查询，再用覆盖度与标题命中重排。

## 注意事项
- FTS 表是派生数据，页面是事实源；
- 每次页面写入都要先删后插，保证不重复；
- 重建索引是幂等操作，可用于修复。`,
    claims: [{ text: 'Alexandria 在写入 FTS5 前把中文切成单字与双字，以解决中文分词问题。', subject: 'SQLite FTS5', predicate: '实现', object: '单字与双字预切分', confidence: 0.85 }],
  },
  {
    library: 'lib_eng',
    node: 'cat_e_pipe',
    classKey: 'concept',
    slug: 'concepts/document-pipeline',
    title: '文档解析流水线',
    summary: '统一接收 PDF、Word、PPT、Excel、TeX、RTF、WPS、图片等格式，抽取文本与结构，再由编译器生成知识页。',
    tldr: '格式适配器只负责“读出来”，编译器负责“想明白”。',
    tags: ['文档解析', 'OCR', 'PDF', 'WPS'],
    aliases: ['Ingestion Pipeline'],
    readWhen: ['接入新文件格式时', '排查解析质量问题'],
    confidence: 0.84,
    owner: 'usr_zhou',
    body: `## 处理阶段
1. **识别**：扩展名 + 魔数，避免伪装文件；
2. **抽取**：按格式路由到适配器，输出统一文本、章节、图片资产与元数据；
3. **增强**：图片 OCR、缩略图、内嵌图片文本；
4. **索引**：文献全文进 source_fts；
5. **编译**：生成文献页、概念页、主张与关联。

## 已支持
PDF（pypdf + 兜底流解析）、DOCX/PPTX/XLSX（ZIP + XML）、RTF（textutil + 内置解析）、TeX、HTML、Markdown、CSV/TSV、JSON、图片（Tesseract 中英 OCR）、ODT/EPUB、旧版 DOC/WPS（LibreOffice 或 OLE 兜底）。

## 质量边界
扫描版 PDF 若无文本层，需要页面渲染 OCR；旧版 WPS 的二进制结构复杂，兜底抽取可能不完整。失败会明确记录在文献状态与任务日志中，不静默丢失。`,
  },
  {
    library: 'lib_eng',
    node: 'cat_e_pipe',
    classKey: 'howto',
    slug: 'howtos/add-format-adapter',
    title: '新增文档格式适配器',
    summary: '在 extract/ 下实现一个返回统一 ExtractResult 的函数，并接入格式路由与测试。',
    tldr: '适配器只做一件事：把格式变成文本、章节与资产。',
    tags: ['扩展', '适配器', '测试'],
    readWhen: ['需要支持新的文件类型时'],
    confidence: 0.78,
    owner: 'usr_zhou',
    body: `## 步骤
1. 在 \`server/src/extract/\` 新建适配器，输入 Buffer 或文件路径；
2. 输出 \`ExtractResult\`：\`text\`、\`sections\`、\`assets\`、\`metadata\`、\`warnings\`；
3. 在 \`extract/index.ts\` 中加入扩展名与魔数路由；
4. 写测试：最小样本、空文件、损坏文件各一条；
5. 更新 [[concepts/document-pipeline|文档解析流水线]] 的支持列表。

## 约束
- 不在这里做 LLM 调用；
- 不把整份原文塞进日志；
- 解析失败要抛错并带可读原因，由任务系统记录。`,
  },
  {
    library: 'lib_eng',
    node: 'cat_e_arch',
    classKey: 'decision',
    slug: 'decisions/adr-0001-sqlite',
    title: 'ADR-0001：使用 SQLite 作为单一事实源',
    summary: '知识页、本体、权限、索引与审计都落在 SQLite；派生索引可重建，原始文件保留在磁盘。',
    tldr: '先保证可移植、可备份、零运维，再考虑分布式。',
    tags: ['ADR', 'SQLite', '架构'],
    aliases: ['ADR 0001'],
    readWhen: ['评估存储方案时', '迁移数据库前'],
    confidence: 0.9,
    owner: 'usr_zhou',
    properties: { decidedAt: '2026-02-01', status: '已采纳' },
    body: `## 背景
知识库需要事务、关联查询、全文索引与备份；团队规模在早期不构成分布式数据库的必要条件。

## 决定
- SQLite（WAL）作为单一事实源；
- 页面正文、本体、权限、审计同库；
- FTS5 作为派生索引，可重建；
- 原始文件存于 data/uploads，数据库只存路径与哈希。

## 后果
- 单机部署简单，备份即复制数据库与上传目录；
- 写并发有限，但知识编译是低频写；
- 未来可分库或迁移 PostgreSQL，接口层不暴露 SQLite 特性。索引细节见 [[concepts/sqlite-fts5|SQLite FTS5]]。`,
  },
  {
    library: 'lib_eng',
    node: 'cat_e_arch',
    classKey: 'concept',
    slug: 'concepts/typed-graph',
    title: '类型化图谱',
    summary: '页面之间的边带关系类型与来源，检索时按关系语义扩展，而不是把一切连接等同看待。',
    tldr: '关系有语义，才能参与排序。',
    tags: ['知识图谱', '关系', '本体'],
    readWhen: ['设计图谱结构时', '调整检索权重时'],
    confidence: 0.82,
    owner: 'usr_shen',
    body: `## 边的三类来源
1. 正文 \`[[wikilink]]\`：作者显式表达；
2. 本体声明：类型允许的关系，如“源自”“依赖”“取代”；
3. 编译推断：同一来源衍生的概念互为相关。

## 检索中的使用
直接命中之后，按边类型与权重做 1 跳扩展：\`derived-from\` 权重高，\`related-to\` 权重低；扩展结果只补充、不压过直接命中。

## 与本体论的关系
本体定义“允许什么关系”，图谱记录“实际存在什么关系”。`,
  },
  {
    library: 'lib_research',
    node: 'cat_r_theory',
    classKey: 'concept',
    slug: 'concepts/llm-wiki',
    title: 'LLM Wiki',
    summary: 'Karpathy 提出的 Dynamic Knowledge Repository 模式：LLM 在入库时维护一个持续演化的 Markdown wiki。',
    tldr: 'Wiki 是编译产物，RAG 只是即时检索。',
    tags: ['LLM Wiki', 'DKR', 'Memex'],
    aliases: ['Dynamic Knowledge Repository', 'DKR'],
    readWhen: ['研究知识库理念时', '设计智能体知识工作流时'],
    confidence: 0.9,
    owner: 'usr_shen',
    properties: { domain: '知识管理' },
    body: `## 核心论点
大多数 LLM + 文档工作流是 RAG：查询时取片段、重新生成、然后忘记。LLM Wiki 让模型在入库时阅读来源，更新实体页与概念页，标记矛盾，维护交叉引用；知识因此可以累积。

## 关键设计
- 页面是带类型 frontmatter 的 Markdown；
- 图边来自 \`sources\`、\`concepts\` 等字段与正文 wikilink；
- 引擎只负责索引、校验、图与 git，不内置 LLM；
- 工作流写在技能里，而不是硬编码在引擎里。

## 与本产品的关系
Alexandria 把这一模式产品化：多知识库、团队权限、本体类型、文档解析与审计。引擎同样不依赖 LLM 才能工作，LLM 只用于可选的答案合成。

## 参考
- Karpathy 的 LLM Wiki gist（2026）
- [llm-wiki](https://github.com/geronimo-iia/llm-wiki)：Rust 引擎、24 个 MCP 工具
- Vannevar Bush, *As We May Think* (1945)`,
  },
  {
    library: 'lib_research',
    node: 'cat_r_theory',
    classKey: 'concept',
    slug: 'concepts/memex',
    title: 'Memex',
    summary: 'Vannevar Bush 1945 年提出的个人知识机器：通过联想路径把文档连接起来，并可回溯路径。',
    tldr: '知识的价值不只在文档，更在文档之间的路径。',
    tags: ['Memex', '知识史', '联想'],
    aliases: ['Memory Extender'],
    readWhen: ['思考知识关联时', '向非技术同事解释图谱时'],
    confidence: 0.88,
    owner: 'usr_shen',
    body: `## 原始构想
Memex 是一张可存储个人书籍、记录与通信的桌子，用户可以通过“联想路径”（associative trails）在文档之间跳转，并把路径保存下来供以后复用。

## 对今天的启发
- 链接不是装饰，而是知识的一等公民；
- 路径可以被保存、分享与审计；
- 检索不只是关键词匹配，还包括沿路径的导航。

## 与 [[concepts/llm-wiki|LLM Wiki]] 的呼应
LLM Wiki 的交叉引用与知识图谱，本质上是在数字环境里实现 Memex 的联想路径；图谱检索则是沿路径行走的方式。`,
  },
  {
    library: 'lib_eng',
    node: 'cat_e_search',
    classKey: 'concept',
    slug: 'concepts/retrieval-by-graph',
    title: '图谱检索',
    summary: '从直接命中的知识页出发，沿类型化边做受控扩展，把相关但未直接匹配的知识带回结果。',
    tldr: '先命中，再沿知识路径走一步。',
    tags: ['检索', '图谱', '关联'],
    aliases: ['Graph Retrieval'],
    readWhen: ['优化检索召回时', '解释为什么相关结果没有关键词时'],
    confidence: 0.8,
    owner: 'usr_shen',
    body: `## 流程
1. FTS5 词法召回候选；
2. 按覆盖度、标题、置信度、时效与 read_when 重排；
3. 取前 6 个种子页面，沿边做 1 跳扩展；
4. 扩展结果降权合并，保留信号分解供解释。

## 为什么不是向量
向量解决“说法不同但语义相近”，图谱解决“知识之间本来就有关系”。在知识被编译成页面的前提下，后者更可解释、更便宜，也更适合企业权限边界。

## 可调参数
扩展跳数、关系类型权重、置信度门槛、每个种子最多带入的邻居数。`,
  },
  {
    library: 'lib_research',
    node: 'cat_r_papers',
    classKey: 'note',
    slug: 'notes/open-questions',
    title: '开放问题清单',
    summary: '当前尚不确定、需要实验或讨论的问题；每条都应能在未来被关闭。',
    tldr: '把不确定性写下来，才有机会消解它。',
    tags: ['开放问题', '研究'],
    readWhen: ['规划下一阶段时', '复盘未解决问题时'],
    confidence: 0.6,
    owner: 'usr_lin',
    body: `## 产品
- 自动编译的概念页，人工校对的最低成本路径是什么？
- 多知识库之间是否允许跨库链接？权限如何表达？

## 技术
- 扫描版 PDF 的多页 OCR 渲染方案；
- [[concepts/llm-wiki|LLM Wiki]] 的交叉引用如何与自动编译共存；
- 中文关键短语抽取是否需要引入领域词典；
- 矛盾检测如何减少“同义不同词”的误报。

## 组织
- 知识页的责任人如何轮值？
- 过期页面如何自动进入复核队列？`,
  },
  {
    library: 'lib_strategy',
    node: 'cat_s_year',
    classKey: 'decision',
    slug: 'decisions/2026-strategy',
    title: '2026 年度战略纲要',
    summary: '以知识编译与组织权限为差异化，先服务内部知识治理，再向外部客户输出。',
    tldr: '先把内部知识库做成样板，再产品化。',
    tags: ['战略', '2026', '商业化'],
    aliases: ['年度战略'],
    readWhen: ['制定季度目标时', '对外介绍公司方向时'],
    confidence: 0.85,
    owner: 'usr_lin',
    properties: { decidedAt: '2026-01-15', status: '已采纳' },
    body: `## 三条主线
1. **内部样板**：让研发、产品、市场三个团队在同一套知识治理规则下协作；
2. **智能体接入**：DSH 智能体通过 API 维护知识，人类负责验收；
3. **产品化**：把多库、本体、权限与文档流水线打包为可交付版本。

## 关键指标
- 知识页被引用率；
- 入库到可检索的时延；
- 矛盾主张的关闭率；
- 活跃团队数。

## 不做
- 不做通用聊天机器人；
- 不以 [[concepts/pricing|定价策略]] 作为唯一竞争壁垒；
- 不把向量检索当作唯一卖点；
- 不在早期做跨租户复杂计费。`,
  },
  {
    library: 'lib_strategy',
    node: 'cat_s_price',
    classKey: 'concept',
    slug: 'concepts/pricing',
    title: '定价策略',
    summary: '按组织席位与知识库数量分层，私有化部署单独报价；不按查询次数计费。',
    tldr: '为知识治理能力付费，而不是为 token 付费。',
    tags: ['定价', '商业化'],
    readWhen: ['设计报价时', '客户询问计费方式时'],
    confidence: 0.72,
    owner: 'usr_lin',
    properties: { domain: '商业化' },
    body: `## 分层
- **团队版**：5 个知识库、基础本体、社区支持；
- **组织版**：不限知识库、团队层级、审计与 SSO；
- **私有化**：按部署规模与支持等级报价。

## 原则
- 与 [[decisions/2026-strategy|2026 年度战略]] 一致：先内部样板，再产品化；
- 不按查询次数计费，避免抑制知识使用；
- 编译任务按资源配额而非 token 计费；
- 权限与审计是组织版的核心价值，不下放到团队版。`,
  },
];

const DEMO_DOCS = [
  {
    library: 'lib_eng',
    node: 'cat_e_pipe',
    title: '知识编译白皮书（2026）',
    filename: 'knowledge-compilation-whitepaper.md',
    content: `# 知识编译白皮书

## 摘要
企业知识库的核心矛盾不是“检索不到”，而是“知识没有被真正写下来”。本文提出以知识编译为中心的架构，把理解成本从查询时前移到入库时。

## 为什么放弃查询期 RAG
查询期 RAG 每次提问都重新切块与生成，答案无法累积，交叉引用无法维护，矛盾无法保留。知识编译在入库时完成阅读、拆页、抽取主张与建立关联，查询只做导航与合成。

## 知识编译的四个动作
1. 识别来源中的概念、实体与主张；
2. 把概念合并进已有原子知识页，保留来源锚点；
3. 建立类型化关联，并检测同一主语谓词下的矛盾；
4. 生成文献页作为可回溯入口。

## 本体与权限
每个知识库拥有独立本体：类型、属性与关系。权限在库、团队与个人三层授予，所有查询先做权限过滤，再进入检索与图谱扩展。

## 检索策略
系统使用 SQLite FTS5 做词法召回，中文按单字与双字切分；随后用预编译关联图做一跳扩展，并按标题覆盖、置信度、时效与 read_when 重排。向量检索不是默认依赖。

## 结论
知识库应当像图书馆：有分类、有编目、有馆藏边界，也有馆员持续维护。LLM 是馆员，不是每次来馆的读者。

## 参考
- Karpathy, LLM Wiki, 2026
- Bush, As We May Think, 1945
- BookStack 的 Shelf / Book / Chapter / Page 层级
- Outline 的 Collection 成员权限模型`,
  },
  {
    library: 'lib_product',
    node: 'cat_p_review',
    title: '需求评审规范 v2',
    filename: 'requirement-review-v2.md',
    content: `# 需求评审规范 v2

## 目的
在研发投入前确认需求价值、边界与验收标准，降低返工。

## 前置条件
- PRD 包含背景、用户、范围、非目标；
- 每个目标至少一个可验证指标；
- 依赖方提前 24 小时阅读。

## 评审流程
1. 产品经理用 10 分钟讲问题与证据，不讲方案细节；
2. 研发评估技术风险与工作量区间；
3. 设计确认关键交互与边界状态；
4. 数据确认指标可采集；
5. 主持人逐条确认验收标准；
6. 形成决策记录，指定负责人。

## 验收标准写法
错误：体验流畅、性能良好。
正确：在 4G 网络下首屏可交互时间小于 2 秒；上传 10MB PDF 后 30 秒内可在检索中命中。

## 评审后的追踪
每条行动项必须有负责人与截止日期；超期自动进入下一次评审议程。评审结论写入产品知识库，链接到相关需求与决策记录。

## 常见问题
- 把方案讨论当成需求评审；
- 评审结论只有口头共识；
- 验收标准在上线前才补。`,
  },
  {
    library: 'lib_research',
    node: 'cat_r_papers',
    title: '用户访谈编码手册',
    filename: 'interview-coding.tex',
    content: `\\documentclass{article}
\\title{用户访谈编码手册}
\\begin{document}
\\section{抽样}
按行为抽样，而不是按人口属性抽样。至少覆盖三类人：最近使用过、尝试后放弃、符合画像但从未使用。

\\section{访谈提纲}
从最近一次具体事件开始，询问时间、地点、触发因素、实际动作、使用的工具、卡点与替代方案。不要询问未来是否会使用。

\\section{编码}
访谈结束后二十四小时内完成编码。编码维度包括：场景、目标、障碍、现有替代、原话证据。每个洞察至少保留一条原话。

\\section{结论}
结论必须区分事实、解释与建议。事实来自原话与行为记录；解释标明置信度；建议给出可验证的下一步。

\\section{沉淀}
将结论写入知识库的洞察页，并链接到原始访谈记录与相关概念页。下一次研究可以从已有结论出发，而不是从零开始。

\\end{document}`,
  },
  {
    library: 'lib_strategy',
    node: 'cat_s_year',
    title: '2026 年 Q2 战略复盘',
    filename: 'q2-strategy-review.md',
    content: `# 2026 年 Q2 战略复盘

## 进展
- 内部知识库完成三个团队试点；
- 文档流水线支持 PDF、DOCX、PPTX、XLSX、TeX、RTF、图片与 WPS；
- DSH 智能体接入编译与查询 API。

## 偏差
- 概念页人工校对进度低于计划；
- 跨库检索尚未开放，权限模型需要补课。

## 下季度重点
1. 建立知识页责任人与复核队列；
2. 完成扫描版 PDF 的 OCR 渲染；
3. 开放受控的跨库引用；
4. 与市场部完成竞品知识库对标。

## 决策
暂不引入向量数据库；继续以编译式知识库与图谱检索为主，待真实查询日志证明召回不足后再评估。`,
  },
];

function addNodes(db: Db, libraryId: string, nodes: (typeof LIBRARIES)[number]['nodes']): void {
  for (const [index, node] of nodes.entries()) {
    db.prepare(
      `INSERT INTO catalog_nodes (id, library_id, parent_id, name, slug, kind, code, description, icon, sort_order, created_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, '', ?, ?)`,
    ).run(node.id, libraryId, node.name, node.slug, node.kind, node.code, node.desc, (index + 1) * 10, nowIso());
  }
}

function seedPage(db: Db, actor: Actor, seed: PageSeed): PageRow {
  const page = createPage(
    db,
    {
      libraryId: seed.library,
      nodeId: seed.node,
      classKey: seed.classKey,
      title: seed.title,
      slug: seed.slug,
      summary: seed.summary,
      tldr: seed.tldr,
      body: seed.body,
      status: 'active',
      confidence: seed.confidence,
      tags: seed.tags,
      aliases: seed.aliases ?? [],
      readWhen: seed.readWhen,
      ownerPersonId: seed.owner ?? 'usr_lin',
      metadata: { seeded: true },
      properties: seed.properties,
    },
    actor,
  );
  if (seed.claims?.length) {
    saveClaims(
      db,
      page.id,
      seed.claims.map((claim) => ({
        text: claim.text,
        subject: claim.subject,
        predicate: claim.predicate,
        object: claim.object,
        confidence: claim.confidence ?? 0.65,
        section: '人工整理',
      })),
    );
  }
  return page;
}

function createDemoImage(path: string): boolean {
  const script = `from PIL import Image, ImageDraw, ImageFont
import sys
img = Image.new('RGB', (1200, 630), (247, 243, 234))
d = ImageDraw.Draw(img)
font_path = '/System/Library/Fonts/Hiragino Sans GB.ttc'
try:
    title = ImageFont.truetype(font_path, 64)
    body = ImageFont.truetype(font_path, 30)
except Exception:
    title = ImageFont.load_default()
    body = ImageFont.load_default()
d.rectangle([40, 40, 1160, 590], outline=(155, 61, 44), width=3)
d.text((90, 110), '亚历山大知识库', font=title, fill=(30, 27, 22))
d.text((90, 220), '图像 OCR 与文档编译演示', font=body, fill=(70, 62, 50))
d.text((90, 300), '知识在入库时编译，查询时导航。', font=body, fill=(47, 106, 88))
d.text((90, 380), 'PDF · Word · PPT · Excel · TeX · RTF · WPS', font=body, fill=(70, 62, 50))
d.text((90, 460), 'Alexandria / 2026', font=body, fill=(155, 61, 44))
img.save(sys.argv[1])
`;
  try {
    execFileSync('python3', ['-c', script, path], { timeout: 30_000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function seedDatabase(db: Db, env: Env): void {
  const now = nowIso();
  const existing = db.prepare('SELECT COUNT(*) AS c FROM persons').get() as unknown as { c: number };
  if (Number(existing.c) > 0) return;

  const passwordHash = hashPassword(DEMO_PASSWORD);
  for (const person of PERSONS) {
    db.prepare(
      `INSERT INTO persons (id, email, name, title, avatar_color, is_admin, password_hash, wecom_userid, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
    ).run(person.id, person.email, person.name, person.title, person.color, person.admin ? 1 : 0, passwordHash, person.wecom ?? null, now);
  }

  for (const [index, team] of TEAMS.entries()) {
    db.prepare(
      `INSERT INTO teams (id, name, slug, parent_id, description, lead_person_id, wecom_dept_id, sort_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(team.id, team.name, team.slug, team.parent, team.desc, team.lead, team.wecom ?? null, (index + 1) * 10, now);
  }

  const memberships: [string, string, string][] = [
    ['team_hq', 'usr_lin', 'lead'],
    ['team_hq', 'usr_shen', 'member'],
    ['team_eng', 'usr_zhou', 'lead'],
    ['team_eng', 'usr_shen', 'member'],
    ['team_eng', 'usr_agent', 'member'],
    ['team_product', 'usr_su', 'lead'],
    ['team_product', 'usr_lin', 'member'],
    ['team_market', 'usr_chen', 'lead'],
    ['team_knowledge', 'usr_shen', 'lead'],
    ['team_knowledge', 'usr_lin', 'member'],
    ['team_knowledge', 'usr_agent', 'member'],
  ];
  for (const [team, person, role] of memberships) {
    db.prepare('INSERT INTO team_members (team_id, person_id, role, created_at) VALUES (?, ?, ?, ?)').run(team, person, role, now);
  }

  for (const library of LIBRARIES) {
    db.prepare(
      `INSERT INTO libraries (id, slug, name, description, icon, color, kind, visibility, owner_team_id, created_by, settings, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'wiki', ?, ?, 'usr_lin', '{}', ?, ?)`,
    ).run(library.id, library.slug, library.name, library.description, library.icon, library.color, library.visibility, library.team, now, now);
    addNodes(db, library.id, library.nodes);
    ensureDefaultOntology(db, library.id);
  }

  // 只读访客：显式授予产品知识库 viewer，用于演示“只读成员”边界。
  db.prepare(
    `INSERT INTO library_grants (id, library_id, subject_type, subject_id, role, created_by, created_at)
     VALUES (?, 'lib_product', 'person', 'usr_guest', 'viewer', 'usr_lin', ?)`,
  ).run(newId('grant'), now);

  // 战略库：仅授权总部与知识运营负责人；产品/工程库由团队关系自然授权。
  for (const personId of ['usr_lin', 'usr_shen']) {
    db.prepare(
      `INSERT INTO library_grants (id, library_id, subject_type, subject_id, role, created_by, created_at)
       VALUES (?, 'lib_strategy', 'person', ?, 'owner', 'usr_lin', ?)`,
    ).run(newId('grant'), personId, now);
  }
  db.prepare(
    `INSERT INTO library_grants (id, library_id, subject_type, subject_id, role, created_by, created_at)
     VALUES (?, 'lib_strategy', 'team', 'team_hq', 'viewer', 'usr_lin', ?)`,
  ).run(newId('grant'), now);

  const admin = db.prepare('SELECT * FROM persons WHERE id = ?').get('usr_lin') as unknown as Record<string, unknown>;
  const actor: Actor = actorFor(db, {
    id: String(admin.id),
    email: String(admin.email),
    name: String(admin.name),
    title: String(admin.title),
    avatarColor: String(admin.avatar_color),
    isAdmin: true,
  });

  for (const page of PAGES) seedPage(db, actor, page);

  // 显式类型化关系：让图有语义，而不只是 wikilink。
  const pairs: [string, string, string][] = [
    ['concepts/knowledge-compilation', 'concepts/ontology', 'depends-on'],
    ['concepts/knowledge-compilation', 'concepts/atomic-page', 'depends-on'],
    ['concepts/ontology', 'concepts/typed-graph', 'depends-on'],
    ['concepts/retrieval-by-graph', 'concepts/typed-graph', 'depends-on'],
    ['concepts/llm-wiki', 'concepts/memex', 'related-to'],
    ['concepts/llm-wiki', 'concepts/knowledge-compilation', 'related-to'],
    ['comparisons/rag-vs-compiled', 'concepts/knowledge-compilation', 'depends-on'],
    ['howtos/requirement-review', 'decisions/decision-log', 'depends-on'],
    ['concepts/document-pipeline', 'concepts/sqlite-fts5', 'related-to'],
  ];
  for (const [fromSlug, toSlug, relation] of pairs) {
    const from = db.prepare('SELECT * FROM pages WHERE slug = ?').get(fromSlug) as unknown as PageRow | undefined;
    const to = db.prepare('SELECT * FROM pages WHERE slug = ?').get(toSlug) as unknown as PageRow | undefined;
    if (from && to) addLink(db, from.library_id, from.id, to.id, relation, 'frontmatter', 1.4);
  }

  // 演示文献：走真实解析 + 编译流水线。
  mkdirSync(join(env.dataDir, 'seed'), { recursive: true });
  for (const doc of DEMO_DOCS) {
    try {
      ingestText(db, env, doc.library, doc.title, doc.content, {
        filename: doc.filename,
        nodeId: doc.node,
        actor,
        sync: true,
      });
    } catch (error) {
      console.warn('[seed] 文献入库失败', doc.title, (error as Error).message);
    }
  }

  // 为精选知识页补上真实来源锚点，展示“知识页 ← 文献”的可追溯结构。
  const bridges: [string, string, string][] = [
    ['concepts/knowledge-compilation', '知识编译白皮书（2026）', '核心来源'],
    ['howtos/requirement-review', '需求评审规范 v2', '流程来源'],
    ['concepts/user-interview', '用户访谈编码手册', '方法来源'],
    ['decisions/2026-strategy', '2026 年 Q2 战略复盘', '复盘来源'],
  ];
  for (const [pageSlug, sourceTitle, locator] of bridges) {
    const page = db.prepare('SELECT id FROM pages WHERE slug = ?').get(pageSlug) as unknown as { id: string } | undefined;
    const source = db.prepare('SELECT id, excerpt FROM sources WHERE title = ?').get(sourceTitle) as unknown as
      | { id: string; excerpt: string }
      | undefined;
    if (page && source) attachSource(db, page.id, source.id, 'derived-from', locator, source.excerpt);
  }

  // 演示评论与站内通知：让校对台/评论/通知在首次启动就有真实内容。
  const reviewPage = db.prepare("SELECT id, owner_person_id FROM pages WHERE slug = 'howtos/requirement-review'").get() as unknown as
    | { id: string; owner_person_id: string | null }
    | undefined;
  if (reviewPage) {
    const commentId = newId('cmt');
    const createdAt = nowIso();
    db.prepare(
      `INSERT INTO comments (id, library_id, page_id, parent_id, author_id, body, status, created_at, updated_at)
       VALUES (?, 'lib_product', ?, NULL, 'usr_shen', ?, 'open', ?, ?)`,
    ).run(commentId, reviewPage.id, '建议补充失败路径与回滚方案的验收标准，避免上线后才发现边界遗漏。', createdAt, createdAt);
    const target = reviewPage.owner_person_id ?? 'usr_su';
    db.prepare(
      `INSERT INTO notifications (id, person_id, actor_id, kind, title, body, link, library_id, page_id, read_at, created_at)
       VALUES (?, ?, 'usr_shen', 'comment', ?, ?, ?, 'lib_product', ?, NULL, ?)`,
    ).run(
      newId('ntf'),
      target,
      '《需求评审》有新评论',
      '沈书言：建议补充失败路径与回滚方案的验收标准。',
      `/#/page/${reviewPage.id}`,
      reviewPage.id,
      createdAt,
    );
  }

  // 图像 OCR 演示：Pillow 可用时生成一张含中文的图片，再走图片流水线。
  const imagePath = join(env.dataDir, 'seed', 'alexandria-ocr-demo.png');
  if (createDemoImage(imagePath)) {
    try {
      const result = ingestBuffer(db, env, 'lib_eng', {
        buffer: readFileSync(imagePath),
        filename: 'alexandria-ocr-demo.png',
        title: '知识库架构图（OCR 演示）',
        nodeId: 'cat_e_pipe',
        actor,
        defer: false,
      });
      if (result.jobId) processJob(db, env, result.jobId);
    } catch (error) {
      console.warn('[seed] 图片 OCR 演示失败', (error as Error).message);
    }
  }

  audit(db, { actor, action: 'org.seed', targetType: 'org', detail: { libraries: LIBRARIES.length, pages: PAGES.length } });

  // 补几条历史动作用于首页时间线。
  const actions = [
    ['page.create', 'page', 'concepts/knowledge-compilation', 'lib_product', '创建《知识编译》'],
    ['source.compiled', 'source', 'demo', 'lib_eng', '编译《知识编译白皮书（2026）》'],
    ['library.grant', 'library', 'lib_strategy', 'lib_strategy', '为沈书言授予战略资料室所有者权限'],
  ] as const;
  for (const [action, targetType, targetId, libraryId, name] of actions) {
    audit(db, {
      actor,
      action,
      targetType,
      targetId,
      libraryId,
      detail: { summary: name },
    });
  }
}


export const SEED_PASSWORD = DEMO_PASSWORD;
