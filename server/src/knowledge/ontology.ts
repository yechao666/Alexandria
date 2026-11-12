import type { Db } from '../db/index.ts';
import { newId, nowIso } from '../lib/ids.ts';

interface ClassSeed {
  key: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  sort: number;
  schema: Record<string, unknown>;
}

const CLASSES: ClassSeed[] = [
  {
    key: 'source',
    name: '文献',
    description: '一份原始资料的编译入口，保留出处与结构，不复制全文。',
    icon: 'file-text',
    color: 'ochre',
    sort: 1,
    schema: {
      fields: [
        { key: 'filename', label: '原始文件', type: 'string' },
        { key: 'pageCount', label: '页数', type: 'number' },
        { key: 'wordCount', label: '字数', type: 'number' },
      ],
      edges: [{ key: 'mentions', label: '提及', target: 'concept' }],
    },
  },
  {
    key: 'concept',
    name: '概念',
    description: '经过编译、可复用的知识单元；一页只讲清一个概念。',
    icon: 'circle',
    color: 'jade',
    sort: 2,
    schema: {
      fields: [
        { key: 'definition', label: '定义', type: 'text' },
        { key: 'domain', label: '领域', type: 'string' },
      ],
      edges: [{ key: 'derived-from', label: '源自', target: 'source' }],
    },
  },
  {
    key: 'entity',
    name: '实体',
    description: '组织、人物、产品、系统等可被引用的对象。',
    icon: 'hexagon',
    color: 'clay',
    sort: 3,
    schema: {
      fields: [
        { key: 'entityType', label: '实体类型', type: 'enum', options: ['组织', '人物', '产品', '系统', '地点'] },
        { key: 'aliases', label: '别名', type: 'text' },
      ],
    },
  },
  {
    key: 'comparison',
    name: '比较',
    description: '多个对象在若干维度上的对照与取舍。',
    icon: 'columns',
    color: 'indigo',
    sort: 4,
    schema: { fields: [{ key: 'dimensions', label: '比较维度', type: 'text' }] },
  },
  {
    key: 'howto',
    name: '方法',
    description: '可执行的流程、步骤与检查清单。',
    icon: 'steps',
    color: 'teal',
    sort: 5,
    schema: { fields: [{ key: 'prerequisites', label: '前置条件', type: 'text' }] },
  },
  {
    key: 'decision',
    name: '决策',
    description: '一个被采纳的结论：背景、选项、理由与影响。',
    icon: 'gavel',
    color: 'plum',
    sort: 6,
    schema: {
      fields: [
        { key: 'decidedAt', label: '决策时间', type: 'date' },
        { key: 'status', label: '状态', type: 'enum', options: ['提议', '已采纳', '已废弃'] },
      ],
    },
  },
  {
    key: 'note',
    name: '笔记',
    description: '尚未完全结构化的观察、问题与草稿。',
    icon: 'pen',
    color: 'slate',
    sort: 7,
    schema: { fields: [] },
  },
];

const RELATIONS = [
  { key: 'mentions', name: '提及', source: null, target: null, inverse: '被提及', color: 'ink' },
  { key: 'derived-from', name: '源自', source: 'concept', target: 'source', inverse: '编译出', color: 'ochre' },
  { key: 'depends-on', name: '依赖', source: null, target: null, inverse: '被依赖', color: 'jade' },
  { key: 'related-to', name: '相关', source: null, target: null, inverse: '相关', color: 'indigo' },
  { key: 'contradicts', name: '矛盾', source: null, target: null, inverse: '矛盾', color: 'clay' },
  { key: 'supersedes', name: '取代', source: null, target: null, inverse: '被取代', color: 'plum' },
];

export function ensureDefaultOntology(db: Db, libraryId: string): void {
  const existing = db
    .prepare('SELECT COUNT(*) AS c FROM ontology_classes WHERE library_id = ?')
    .get(libraryId) as unknown as { c: number };
  const now = nowIso();
  if (Number(existing.c) === 0) {
  for (const klass of CLASSES) {
    db.prepare(
      `INSERT INTO ontology_classes (id, library_id, key, name, description, icon, color, schema_json, builtin, sort_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      newId('cls'),
      libraryId,
      klass.key,
      klass.name,
      klass.description,
      klass.icon,
      klass.color,
      JSON.stringify(klass.schema),
      klass.sort,
      now,
    );
  }
  }
  for (const relation of RELATIONS) {
    db.prepare(
      `INSERT OR IGNORE INTO ontology_relations (id, library_id, key, name, description, source_class, target_class, inverse_name, color, created_at)
       VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?)`,
    ).run(
      newId('rel'),
      libraryId,
      relation.key,
      relation.name,
      relation.source,
      relation.target,
      relation.inverse,
      relation.color,
      now,
    );
  }

  // 内置类型的属性来自 schema.fields；已有库也会补上缺失的属性定义。
  for (const klass of CLASSES) {
    const classExists = db
      .prepare('SELECT 1 FROM ontology_classes WHERE library_id = ? AND key = ?')
      .get(libraryId, klass.key);
    if (!classExists) continue;
    const fields = Array.isArray((klass.schema as { fields?: unknown }).fields)
      ? ((klass.schema as { fields: { key: string; label: string; type: string; options?: string[] }[] }).fields)
      : [];
    for (const [index, field] of fields.entries()) {
      const exists = db
        .prepare('SELECT 1 FROM ontology_properties WHERE library_id = ? AND class_key = ? AND key = ?')
        .get(libraryId, klass.key, field.key);
      if (exists) continue;
      db.prepare(
        `INSERT INTO ontology_properties (id, library_id, class_key, key, name, type, description, required, options, sort_order, created_at)
         VALUES (?, ?, ?, ?, ?, ?, '', 0, ?, ?, ?)`,
      ).run(
        newId('prop'),
        libraryId,
        klass.key,
        field.key,
        field.label,
        field.type,
        JSON.stringify(field.options ?? []),
        index * 10,
        now,
      );
    }
  }
}

export const DEFAULT_CLASS_KEYS = CLASSES.map((klass) => klass.key);
