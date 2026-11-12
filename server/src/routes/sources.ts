import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Router } from '../http/router.ts';
import type { RequestContext } from '../http/context.ts';
import { requireActor } from '../http/auth.ts';
import { requireLibrary } from '../domain/access.ts';
import { audit } from '../domain/audit.ts';
import { errors } from '../http/respond.ts';
import { nowIso, parseJson } from '../lib/ids.ts';
import { extOf } from '../extract/index.ts';
import { ingestBuffer, processJob, reprocessSource, sourceDownloadName } from '../ingest/pipeline.ts';
import { sendBinary } from '../http/static.ts';
import { canEdit, pageListDto } from './helpers.ts';
import type { SourceRow } from '../types.ts';

function sourceFor(rc: RequestContext, id: string) {
  const actor = requireActor(rc);
  const source = rc.app.db.prepare('SELECT * FROM sources WHERE id = ?').get(id) as unknown as SourceRow | undefined;
  if (!source) throw errors.notFound('文献不存在');
  const { library, role } = requireLibrary(rc.app.db, actor, source.library_id);
  return { actor, source, library, role };
}

function sourceView(rc: RequestContext, source: SourceRow): Record<string, unknown> {
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
    compiledPages: compiledPages.map((page) => pageListDto(rc.app.db, page)),
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
        source: sourceView(rc, result.source),
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
    const total = rc.app.db
      .prepare(`SELECT COUNT(*) AS c FROM sources WHERE ${conditions.join(' AND ')}`)
      .get(...params) as unknown as { c: number };
    const rows = rc.app.db
      .prepare(`SELECT * FROM sources WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as unknown as SourceRow[];
    rc.json({
      total: Number(total.c),
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
    const { source, role } = sourceFor(rc, rc.params.id!);
    rc.json({ source: sourceView(rc, source), canEdit: canEdit(role) });
  });

  router.get('/api/sources/:id/download', (rc) => {
    const { source } = sourceFor(rc, rc.params.id!);
    if (!existsSync(source.storage_path)) throw errors.notFound('原始文件已丢失');
    sendBinary(rc, readFileSync(source.storage_path), sourceDownloadName(source), source.mime || 'application/octet-stream');
  });

  router.get('/api/sources/:id/text', (rc) => {
    const { source } = sourceFor(rc, rc.params.id!);
    rc.json({ text: source.extracted_text, metadata: parseJson<Record<string, unknown>>(source.metadata, {}) });
  });

  router.get('/api/sources/:id/assets/:assetId', (rc) => {
    const { source } = sourceFor(rc, rc.params.id!);
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
    const { actor, source, library, role } = sourceFor(rc, rc.params.id!);
    if (!canEdit(role)) throw errors.forbidden('需要编辑权限');
    if (source.status === 'processing' || source.status === 'queued') {
      throw errors.conflict('该文献正在处理中');
    }
    const jobId = reprocessSource(rc.app.db, rc.app.env, source.id);
    audit(rc.app.db, { actor, action: 'source.reprocess', targetType: 'source', targetId: source.id, libraryId: library.id });
    rc.json({ jobId }, 202);
  });

  router.delete('/api/sources/:id', (rc) => {
    const { actor, source, library, role } = sourceFor(rc, rc.params.id!);
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
    rc.json({ job: { ...job, log: parseJson<string[]>(String(job.log ?? '[]'), []) } });
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

  // 允许管理员对历史文献补做 OCR（图片类）
  router.post('/api/sources/:id/ocr', (rc) => {
    const { source, role } = sourceFor(rc, rc.params.id!);
    if (!canEdit(role)) throw errors.forbidden('需要编辑权限');
    const asset = rc.app.db
      .prepare("SELECT * FROM source_assets WHERE source_id = ? AND kind = 'image' LIMIT 1")
      .get(source.id) as unknown as { storage_path: string; ocr_text: string } | undefined;
    if (!asset) throw errors.badRequest('该文献没有可 OCR 的图片');
    void writeFileSync;
    void nowIso;
    rc.json({ ok: true, note: 'OCR 在重编译时执行，请使用 reprocess' });
  });
}
