import type { Router } from '../http/router.ts';
import { requireActor } from '../http/auth.ts';
import { requireLibrary } from '../domain/access.ts';
import { audit } from '../domain/audit.ts';
import { errors } from '../http/respond.ts';
import { newId, nowIso, parseJson } from '../lib/ids.ts';

const TYPES = new Set(['string', 'text', 'number', 'boolean', 'date', 'url', 'enum']);

function propertyView(row: Record<string, unknown>): Record<string, unknown> {
  return { ...row, options: parseJson<string[]>(String(row.options ?? '[]'), []) };
}

export function registerOntologyRoutes(router: Router): void {
  router.get('/api/libraries/:id/properties', (rc) => {
    const actor = requireActor(rc);
    const { library } = requireLibrary(rc.app.db, actor, rc.params.id!);
    const rows = rc.app.db
      .prepare('SELECT * FROM ontology_properties WHERE library_id = ? ORDER BY class_key, sort_order')
      .all(library.id) as unknown as Record<string, unknown>[];
    rc.json({ properties: rows.map(propertyView) });
  });

  router.post('/api/libraries/:id/properties', async (rc) => {
    const actor = requireActor(rc);
    const { library } = requireLibrary(rc.app.db, actor, rc.params.id!, 'editor');
    const body = await rc.body<Record<string, unknown>>();
    const key = String(body.key ?? '').trim();
    const name = String(body.name ?? '').trim();
    const classKey = body.classKey ? String(body.classKey) : null;
    const type = String(body.type ?? 'string');
    if (!/^[a-z][a-zA-Z0-9_]{1,40}$/.test(key)) throw errors.badRequest('属性 key 需以小写字母开头，仅含字母、数字与下划线');
    if (!name) throw errors.badRequest('属性名称不能为空');
    if (!TYPES.has(type)) throw errors.badRequest('属性类型不合法');
    if (classKey) {
      const exists = rc.app.db
        .prepare('SELECT 1 FROM ontology_classes WHERE library_id = ? AND key = ?')
        .get(library.id, classKey);
      if (!exists) throw errors.badRequest('本体类型不存在');
    }
    const collision = rc.app.db
      .prepare('SELECT 1 FROM ontology_properties WHERE library_id = ? AND key = ? AND (class_key = ? OR (? IS NULL AND class_key IS NULL))')
      .get(library.id, key, classKey, classKey);
    if (collision) throw errors.conflict('该类型下已有同名属性');
    const id = newId('prop');
    rc.app.db
      .prepare(
        `INSERT INTO ontology_properties (id, library_id, class_key, key, name, type, description, required, options, sort_order, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        library.id,
        classKey,
        key,
        name,
        type,
        String(body.description ?? ''),
        body.required ? 1 : 0,
        JSON.stringify(Array.isArray(body.options) ? body.options.map(String) : []),
        Number(body.sortOrder ?? 100),
        nowIso(),
      );
    audit(rc.app.db, { actor, action: 'ontology.property.create', targetType: 'property', targetId: id, libraryId: library.id, detail: { key, classKey, type } });
    rc.json({ property: propertyView((rc.app.db.prepare('SELECT * FROM ontology_properties WHERE id = ?').get(id) as unknown as Record<string, unknown>)) }, 201);
  });

  router.patch('/api/properties/:id', async (rc) => {
    const actor = requireActor(rc);
    const property = rc.app.db.prepare('SELECT * FROM ontology_properties WHERE id = ?').get(rc.params.id!) as unknown as
      | Record<string, unknown>
      | undefined;
    if (!property) throw errors.notFound('属性不存在');
    const { library } = requireLibrary(rc.app.db, actor, String(property.library_id), 'editor');
    const body = await rc.body<Record<string, unknown>>();
    const fields: string[] = [];
    const values: (string | number | null)[] = [];
    const set = (column: string, value: string | number | null) => {
      fields.push(`${column} = ?`);
      values.push(value);
    };
    if (body.name !== undefined) set('name', String(body.name));
    if (body.description !== undefined) set('description', String(body.description));
    if (body.type !== undefined) {
      if (!TYPES.has(String(body.type))) throw errors.badRequest('属性类型不合法');
      set('type', String(body.type));
    }
    if (body.required !== undefined) set('required', body.required ? 1 : 0);
    if (body.options !== undefined) set('options', JSON.stringify(Array.isArray(body.options) ? body.options.map(String) : []));
    if (body.sortOrder !== undefined) set('sort_order', Number(body.sortOrder));
    values.push(String(property.id));
    rc.app.db.prepare(`UPDATE ontology_properties SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    audit(rc.app.db, { actor, action: 'ontology.property.update', targetType: 'property', targetId: String(property.id), libraryId: library.id });
    rc.json({ property: propertyView((rc.app.db.prepare('SELECT * FROM ontology_properties WHERE id = ?').get(String(property.id)) as unknown as Record<string, unknown>)) });
  });

  router.delete('/api/properties/:id', (rc) => {
    const actor = requireActor(rc);
    const property = rc.app.db.prepare('SELECT * FROM ontology_properties WHERE id = ?').get(rc.params.id!) as unknown as
      | Record<string, unknown>
      | undefined;
    if (!property) throw errors.notFound('属性不存在');
    const { library } = requireLibrary(rc.app.db, actor, String(property.library_id), 'editor');
    rc.app.db.prepare('DELETE FROM ontology_properties WHERE id = ?').run(String(property.id));
    audit(rc.app.db, { actor, action: 'ontology.property.delete', targetType: 'property', targetId: String(property.id), libraryId: library.id });
    rc.json({ ok: true });
  });
}
