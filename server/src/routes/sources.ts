import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Router } from '../http/router.ts';
import type { RequestContext } from '../http/context.ts';
import { requireActor } from '../http/auth.ts';
import { requireLibrary, visibleLibraries, effectivePageRole, effectiveSourceRole, resourceGrants } from '../domain/access.ts';
import { audit } from '../domain/audit.ts';
import { errors } from '../http/respond.ts';
import { newId, nowIso, parseJson } from '../lib/ids.ts';
import { extOf } from '../extract/index.ts';
import { ingestBuffer, processJob, reprocessSource, sourceDownloadName } from '../ingest/pipeline.ts';
import { sendBinary } from '../http/static.ts';
import { canEdit, pageListDto, sourceAccess } from './helpers.ts';
import type { SourceRow } from '../types.ts';

function sourceView(rc: RequestContext, source: SourceRow, actor?: import('../types.ts').Actor): Record<string, unknown> {
  const assets = rc.app.db
    .prepare('SELECT id, kind, filename, mime, width, height, ocr_text, thumbnail_path FROM source_assets WHERE source_id = ?')
    .all(source.id) as unknown as Record<string, unknown>[];
  const compiledPages = rc.app.db
    .prepare(
      `SELECT p.* FROM pages p JOIN page_sources ps ON ps.page_id = p.id
        WHERE ps.source_id = ? ORDER BY p.class_key, p.title`,
    )
    .all(source.id) as unknown as import('../types.ts').PageRow[];
  const job = rc.app.db
    .prepare('SELECT * FROM ingest_jobs WHERE source_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(source.id) as unknown as Record<string, unknown> | undefined;
  return {
    id: source.id,
    libraryId: source.library_id,
    nodeId: source.node_id,
    title: source.title,
    filename: source.filename,
    ext: source.ext,
    mime: source.mime,
    size: source.size,
    kind: source.kind,
    status: source.status,
    visibility: source.visibility,
    canManageAccess: Boolean(actor && (actor.person.isAdmin || effectiveSourceRole(rc.app.db, actor, source) === 'owner')),
    pageCount: source.page_count,
    wordCount: source.word_count,
    excerpt: source.excerpt,
    sha256: source.sha256,
    metadata: parseJson<Record<string, unknown>>(source.metadata, {}),
    uploadedBy: source.uploaded_by,
    error: source.error,
    createdAt: source.created_at,
    updatedAt: source.updated_at,
    assets: assets.map((asset) => ({
      ...asset,
      url: `/api/sources/${source.id}/assets/${asset.id}`,
      thumbnailUrl: asset.thumbnail_path ? `/api/sources/${source.id}/assets/${asset.id}?thumb=1` : null,
    })),
    compiledPages: compiledPages.filter((page) => !actor || Boolean(effectivePageRole(rc.app.db, actor, page))).map((page) => pageListDto(rc.app.db, page)),
    job: job
      ? {
          ...job,
          log: parseJson<string[]>(String(job.log ?? '[]'), []),
        }
      : null,
  };
}

export function registerSourceRoutes(router: Router): void {
  router.post('/api/libraries/:id/sources', async (rc) => {
    const actor = requireActor(rc);
    const { library } = requireLibrary(rc.app.db, actor, rc.params.id!, 'editor');
    const rawName = rc.header('x-filename') || rc.query('filename');
    let filename = rawName;
    try {
      filename = decodeURIComponent(rawName);
    } catch {
      /* 保持原值 */
    }
    if (!filename) throw errors.badRequest('缺少文件名（x-filename 头或 filename 查询参数）');
    if (!extOf(filename)) throw errors.badRequest('文件缺少扩展名');
    let title = rc.header('x-title') || rc.query('title');
    try {
      title = decodeURIComponent(title);
    } catch {
      /* 保持原值 */
    }
    const nodeId = rc.header('x-node-id') || rc.query('nodeId') || null;
    if (nodeId) {
      const node = rc.app.db
        .prepare('SELECT 1 FROM catalog_nodes WHERE id = ? AND library_id = ?')
        .get(nodeId, library.id);
      if (!node) throw errors.badRequest('目录不存在');
    }
    const buffer = await rc.rawBody(rc.app.env.maxUploadBytes);
    if (!buffer.length) throw errors.badRequest('上传内容为空');
    const result = ingestBuffer(rc.app.db, rc.app.env, library.id, {
      buffer,
      filename: basename(filename),
      title: title || undefined,
      nodeId,
      actor,
    });
    rc.json(
      {
        source: sourceView(rc, result.source, actor),
        jobId: result.jobId,
        duplicate: result.duplicate,
      },
      result.duplicate ? 200 : 202,
    );
  });

  router.get('/api/libraries/:id/sources', (rc) => {
    const actor = requireActor(rc);
    const { library } = requireLibrary(rc.app.db, actor, rc.params.id!);
    const limit = Math.max(1, Math.min(200, rc.queryInt('limit', 50)));
    const offset = Math.max(0, rc.queryInt('offset', 0));
    const conditions = ['library_id = ?'];
    const params: (string | number)[] = [library.id];
    if (rc.query('node')) {
      conditions.push('node_id = ?');
      params.push(rc.query('node'));
    }
    if (rc.query('status')) {
      conditions.push('status = ?');
      params.push(rc.query('status'));
    }
    if (rc.query('kind')) {
      conditions.push('kind = ?');
      params.push(rc.query('kind'));
    }
    if (rc.query('q')) {
      conditions.push('(title LIKE ? OR filename LIKE ? OR extracted_text LIKE ?)');
      const q = `%${rc.query('q')}%`;
      params.push(q, q, q);
    }
    const allRows = rc.app.db
      .prepare(`SELECT * FROM sources WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`)
      .all(...params) as unknown as SourceRow[];
    const visible = allRows.filter((source) => Boolean(effectiveSourceRole(rc.app.db, actor, source)));
    const rows = visible.slice(offset, offset + limit);
    rc.json({
      total: visible.length,
      sources: rows.map((source) => ({
        id: source.id,
        title: source.title,
        filename: source.filename,
        ext: source.ext,
        kind: source.kind,
        status: source.status,
        size: source.size,
        pageCount: source.page_count,
        wordCount: source.word_count,
        excerpt: source.excerpt,
        nodeId: source.node_id,
        error: source.error,
        createdAt: source.created_at,
        updatedAt: source.updated_at,
      })),
    });
  });

  router.get('/api/sources/:id', (rc) => {
    const { actor, source, role } = sourceAccess(rc, rc.params.id!);
    rc.json({ source: sourceView(rc, source, actor), canEdit: canEdit(role) });
  });

  router.get('/api/sources/:id/download', (rc) => {
    const { source } = sourceAccess(rc, rc.params.id!);
    if (!existsSync(source.storage_path)) throw errors.notFound('原始文件已丢失');
    sendBinary(rc, readFileSync(source.storage_path), sourceDownloadName(source), source.mime || 'application/octet-stream');
  });

  router.get('/api/sources/:id/text', (rc) => {
    const { source } = sourceAccess(rc, rc.params.id!);
    rc.json({ text: source.extracted_text, metadata: parseJson<Record<string, unknown>>(source.metadata, {}) });
  });

  router.get('/api/sources/:id/assets/:assetId', (rc) => {
    const { source } = sourceAccess(rc, rc.params.id!);
    const asset = rc.app.db
      .prepare('SELECT * FROM source_assets WHERE id = ? AND source_id = ?')
      .get(rc.params.assetId!, source.id) as unknown as
      | { id: string; storage_path: string; thumbnail_path: string | null; mime: string; filename: string }
      | undefined;
    if (!asset) throw errors.notFound('附件不存在');
    const thumb = rc.query('thumb') === '1' && asset.thumbnail_path;
    const path = thumb ? asset.thumbnail_path! : asset.storage_path;
    if (!existsSync(path)) throw errors.notFound('文件已丢失');
    sendBinary(rc, readFileSync(path), asset.filename, thumb ? 'image/jpeg' : asset.mime || 'application/octet-stream');
  });

  router.post('/api/sources/:id/reprocess', (rc) => {
    const { actor, source, library, role } = sourceAccess(rc, rc.params.id!);
    if (!canEdit(role)) throw errors.forbidden('需要编辑权限');
    if (source.status === 'processing' || source.status === 'queued') {
      throw errors.conflict('该文献正在处理中');
    }
    const jobId = reprocessSource(rc.app.db, rc.app.env, source.id);
    audit(rc.app.db, { actor, action: 'source.reprocess', targetType: 'source', targetId: source.id, libraryId: library.id });
    rc.json({ jobId }, 202);
  });

  router.delete('/api/sources/:id', (rc) => {
    const { actor, source, library, role } = sourceAccess(rc, rc.params.id!);
    if (!canEdit(role)) throw errors.forbidden('需要编辑权限');
    rc.app.db.prepare('DELETE FROM sources WHERE id = ?').run(source.id);
    try {
      rmSync(dirname(source.storage_path), { recursive: true, force: true });
    } catch {
      /* 忽略文件清理错误 */
    }
    audit(rc.app.db, { actor, action: 'source.delete', targetType: 'source', targetId: source.id, libraryId: library.id, detail: { title: source.title } });
    rc.json({ ok: true });
  });

  router.get('/api/jobs/:id', (rc) => {
    const actor = requireActor(rc);
    const job = rc.app.db.prepare('SELECT * FROM ingest_jobs WHERE id = ?').get(rc.params.id!) as unknown as
      | Record<string, unknown>
      | undefined;
    if (!job) throw errors.notFound('任务不存在');
    requireLibrary(rc.app.db, actor, String(job.library_id));
    const events = rc.app.db.prepare('SELECT * FROM job_events WHERE job_id = ? ORDER BY created_at ASC').all(String(job.id)) as unknown as Record<string, unknown>[];
    const source = job.source_id ? rc.app.db.prepare('SELECT id, title FROM sources WHERE id = ?').get(String(job.source_id)) : undefined;
    rc.json({ job: { ...job, log: parseJson<string[]>(String(job.log ?? '[]'), []), events, source } });
  });

  router.post('/api/jobs/:id/run', (rc) => {
    const actor = requireActor(rc);
    const job = rc.app.db.prepare('SELECT * FROM ingest_jobs WHERE id = ?').get(rc.params.id!) as unknown as
      | { id: string; library_id: string; status: string }
      | undefined;
    if (!job) throw errors.notFound('任务不存在');
    const { role } = requireLibrary(rc.app.db, actor, job.library_id);
    if (!canEdit(role)) throw errors.forbidden('需要编辑权限');
    processJob(rc.app.db, rc.app.env, job.id);
    rc.json({ ok: true });
  });

  router.get('/api/libraries/:id/jobs', (rc) => {
    const actor = requireActor(rc);
    const { library } = requireLibrary(rc.app.db, actor, rc.params.id!);
    const jobs = rc.app.db
      .prepare('SELECT * FROM ingest_jobs WHERE library_id = ? ORDER BY created_at DESC LIMIT 30')
      .all(library.id) as unknown as Record<string, unknown>[];
    rc.json({
      jobs: jobs.map((job) => ({ ...job, log: parseJson<string[]>(String(job.log ?? '[]'), []) })),
    });
  });

  router.get('/api/tasks', (rc) => {
    const actor = requireActor(rc);
    const libraries = visibleLibraries(rc.app.db, actor);
    const ids = libraries.map((library) => library.id);
    if (!ids.length) {
      rc.json({ tasks: [] });
      return;
    }
    const status = rc.query('status');
    const limit = Math.max(1, Math.min(100, rc.queryInt('limit', 40)));
    const ph = ids.map(() => '?').join(',');
    const conditions = [`j.library_id IN (${ph})`];
    const params: (string | number)[] = [...ids];
    if (status) {
      conditions.push('j.status = ?');
      params.push(status);
    }
    const rows = rc.app.db
      .prepare(
        `SELECT j.*, l.name AS library_name, l.slug AS library_slug, s.title AS source_title, s.filename AS source_filename
           FROM ingest_jobs j LEFT JOIN libraries l ON l.id = j.library_id LEFT JOIN sources s ON s.id = j.source_id
          WHERE ${conditions.join(' AND ')} ORDER BY j.created_at DESC LIMIT ?`,
      )
      .all(...params, limit) as unknown as Record<string, unknown>[];
    rc.json({
      tasks: rows.map((job) => ({
        ...job,
        log: parseJson<string[]>(String(job.log ?? '[]'), []),
        events: rc.app.db.prepare('SELECT * FROM job_events WHERE job_id = ? ORDER BY created_at ASC').all(String(job.id)),
      })),
    });
  });

  router.post('/api/jobs/:id/cancel', (rc) => {
    const actor = requireActor(rc);
    const job = rc.app.db.prepare('SELECT * FROM ingest_jobs WHERE id = ?').get(rc.params.id!) as unknown as
      | { id: string; library_id: string; status: string; source_id: string | null }
      | undefined;
    if (!job) throw errors.notFound('任务不存在');
    const { role } = requireLibrary(rc.app.db, actor, job.library_id);
    if (!canEdit(role)) throw errors.forbidden('需要编辑权限');
    if (job.status !== 'queued') throw errors.conflict('只有排队中的任务可以取消');
    rc.app.db.prepare("UPDATE ingest_jobs SET status = 'cancelled', stage = 'cancelled', finished_at = ? WHERE id = ?").run(nowIso(), job.id);
    if (job.source_id) rc.app.db.prepare("UPDATE sources SET status = 'failed', error = '任务已取消', updated_at = ? WHERE id = ?").run(nowIso(), job.source_id);
    rc.json({ ok: true });
  });

  // 允许管理员对历史文献补做 OCR（图片类）
  router.post('/api/sources/:id/ocr', (rc) => {
    const { source, role } = sourceAccess(rc, rc.params.id!);
    if (!canEdit(role)) throw errors.forbidden('需要编辑权限');
    const asset = rc.app.db
      .prepare("SELECT * FROM source_assets WHERE source_id = ? AND kind = 'image' LIMIT 1")
      .get(source.id) as unknown as { storage_path: string; ocr_text: string } | undefined;
    if (!asset) throw errors.badRequest('该文献没有可 OCR 的图片');
    void writeFileSync;
    void nowIso;
    rc.json({ ok: true, note: 'OCR 在重编译时执行，请使用 reprocess' });
  });
  router.get('/api/sources/:id/access', (rc) => {
    const { actor, source, role } = sourceAccess(rc, rc.params.id!, 'viewer');
    if (!actor.person.isAdmin && role !== 'owner') throw errors.forbidden('需要文献所有者权限');
    rc.json({ sourceId: source.id, visibility: source.visibility, canManage: true, grants: resourceGrants(rc.app.db, 'source', source.id) });
  });

  router.patch('/api/sources/:id/access', async (rc) => {
    const { actor, source, library, role } = sourceAccess(rc, rc.params.id!, 'viewer');
    if (!actor.person.isAdmin && role !== 'owner') throw errors.forbidden('需要文献所有者权限');
    const body = await rc.body<{ visibility?: string; grants?: { subjectType?: string; subjectId?: string; role?: string }[] }>();
    const visibility = ['inherit', 'restricted', 'private'].includes(String(body.visibility)) ? String(body.visibility) : source.visibility;
    const valid = [];
    for (const grant of Array.isArray(body.grants) ? body.grants : []) {
      const subjectType = String(grant.subjectType ?? '');
      const subjectId = String(grant.subjectId ?? '').trim();
      const grantRole = String(grant.role ?? 'viewer');
      if (!['person', 'team'].includes(subjectType) || !subjectId || !['viewer', 'editor'].includes(grantRole)) continue;
      const exists = subjectType === 'person'
        ? rc.app.db.prepare("SELECT 1 FROM persons WHERE id = ? AND status = 'active'").get(subjectId)
        : rc.app.db.prepare('SELECT 1 FROM teams WHERE id = ?').get(subjectId);
      if (exists) valid.push({ subjectType, subjectId, role: grantRole });
    }
    rc.app.db.prepare('UPDATE sources SET visibility = ?, updated_at = ? WHERE id = ?').run(visibility, nowIso(), source.id);
    rc.app.db.prepare("DELETE FROM resource_grants WHERE resource_type = 'source' AND resource_id = ?").run(source.id);
    const insert = rc.app.db.prepare(
      'INSERT INTO resource_grants (id, resource_type, resource_id, subject_type, subject_id, role, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const grant of valid) insert.run(newId('rgrant'), 'source', source.id, grant.subjectType, grant.subjectId, grant.role, actor.person.id, nowIso());
    audit(rc.app.db, { actor, action: 'source.access.update', targetType: 'source', targetId: source.id, libraryId: library.id, detail: { visibility, grants: valid.length } });
    rc.json({ ok: true, visibility, grants: resourceGrants(rc.app.db, 'source', source.id) });
  });

}
