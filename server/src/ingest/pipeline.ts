import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { Db } from '../db/index.ts';
import type { Env } from '../env.ts';
import type { Actor, SourceRow } from '../types.ts';
import { newId, nowIso, parseJson, sha256, slugify, truncate } from '../lib/ids.ts';
import { extractBuffer, extOf, mimeFor } from '../extract/index.ts';
import { cleanText } from '../extract/text-util.ts';
import { makeThumbnail, ocrImage } from '../extract/image.ts';
import { wordCount } from '../knowledge/terms.ts';
import { compileSource } from '../knowledge/compiler.ts';
import { indexSource } from '../knowledge/pages.ts';
import { audit } from '../domain/audit.ts';
import { errors } from '../http/respond.ts';
import { ensureDefaultOntology } from '../knowledge/ontology.ts';

export interface IngestInput {
  buffer: Buffer;
  filename: string;
  title?: string;
  nodeId?: string | null;
  actor?: Actor | null;
  defer?: boolean;
}

export interface IngestResult {
  source: SourceRow;
  jobId: string;
  duplicate: boolean;
}

function safeFilename(filename: string): string {
  return (filename.split(/[/\\]/).pop() ?? 'file')
    .replace(/[\u0000-\u001f<>:"|?*]/g, '_')
    .slice(0, 180) || 'file';
}

function jobLog(db: Db, jobId: string, line: string): void {
  const row = db.prepare('SELECT log FROM ingest_jobs WHERE id = ?').get(jobId) as unknown as { log: string } | undefined;
  const entries = parseJson<string[]>(row?.log, []);
  entries.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
  db.prepare('UPDATE ingest_jobs SET log = ? WHERE id = ?').run(JSON.stringify(entries.slice(-80)), jobId);
}

function setJob(
  db: Db,
  jobId: string,
  patch: Partial<{
    status: string;
    stage: string;
    progress: number;
    pages_created: number;
    pages_updated: number;
    conflicts: number;
    error: string | null;
    started_at: string | null;
    finished_at: string | null;
  }>,
): void {
  const fields: string[] = [];
  const values: (string | number | null)[] = [];
  for (const [key, value] of Object.entries(patch)) {
    fields.push(`${key} = ?`);
    values.push(value ?? null);
  }
  if (!fields.length) return;
  values.push(jobId);
  db.prepare(`UPDATE ingest_jobs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function ingestBuffer(db: Db, env: Env, libraryId: string, input: IngestInput): IngestResult {
  const filename = safeFilename(input.filename);
  const ext = extOf(filename);
  if (!ext) throw errors.badRequest('文件缺少扩展名，无法判断格式');
  if (input.buffer.length === 0) throw errors.badRequest('文件为空');
  if (input.buffer.length > env.maxUploadBytes) {
    throw errors.payloadTooLarge(`文件超过 ${Math.round(env.maxUploadBytes / 1024 / 1024)}MB 上限`);
  }

  const hash = sha256(input.buffer);
  const duplicate = db
    .prepare('SELECT * FROM sources WHERE library_id = ? AND sha256 = ?')
    .get(libraryId, hash) as unknown as SourceRow | undefined;
  if (duplicate) {
    const job = db
      .prepare('SELECT id FROM ingest_jobs WHERE source_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(duplicate.id) as unknown as { id: string } | undefined;
    return { source: duplicate, jobId: job?.id ?? '', duplicate: true };
  }

  const sourceId = newId('src');
  const dir = join(env.uploadsDir, libraryId, sourceId);
  mkdirSync(dir, { recursive: true });
  const storagePath = join(dir, filename);
  writeFileSync(storagePath, input.buffer);

  const title = (input.title?.trim() || filename.replace(/\.[^.]+$/, '')).slice(0, 200);
  const now = nowIso();
  db.prepare(
    `INSERT INTO sources (id, library_id, node_id, title, filename, ext, mime, size, sha256, kind, storage_path,
       status, language, page_count, word_count, excerpt, extracted_text, metadata, uploaded_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'zh', 0, 0, '', '', '{}', ?, ?, ?)`,
  ).run(
    sourceId,
    libraryId,
    input.nodeId ?? null,
    title,
    filename,
    ext,
    mimeFor(filename),
    input.buffer.length,
    hash,
    ext,
    storagePath,
    input.actor?.person.id ?? null,
    now,
    now,
  );

  const jobId = newId('job');
  db.prepare(
    `INSERT INTO ingest_jobs (id, library_id, source_id, status, stage, progress, compiler, log, created_at)
     VALUES (?, ?, ?, 'queued', 'queued', 0, 'rule', '[]', ?)`,
  ).run(jobId, libraryId, sourceId, now);

  audit(db, {
    actor: input.actor,
    action: 'source.upload',
    targetType: 'source',
    targetId: sourceId,
    libraryId,
    detail: { filename, size: input.buffer.length, jobId },
  });

  if (input.defer !== false) setImmediate(() => processJob(db, env, jobId));
  const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(sourceId) as unknown as SourceRow;
  return { source, jobId, duplicate: false };
}

export function processJob(db: Db, env: Env, jobId: string): void {
  const job = db.prepare('SELECT * FROM ingest_jobs WHERE id = ?').get(jobId) as unknown as
    | { id: string; library_id: string; source_id: string; status: string }
    | undefined;
  if (!job || !job.source_id) return;
  if (job.status === 'running' || job.status === 'succeeded') return;
  const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(job.source_id) as unknown as SourceRow | undefined;
  if (!source) {
    setJob(db, jobId, { status: 'failed', error: '文献记录不存在', finished_at: nowIso() });
    return;
  }

  setJob(db, jobId, { status: 'running', stage: 'extract', progress: 8, started_at: nowIso() });
  db.prepare("UPDATE sources SET status = 'processing', updated_at = ? WHERE id = ?").run(nowIso(), source.id);
  jobLog(db, jobId, `开始解析 ${source.filename}`);

  try {
    ensureDefaultOntology(db, source.library_id);
    const buffer = readFileSync(source.storage_path);
    const extracted = extractBuffer(buffer, source.filename, source.storage_path);
    setJob(db, jobId, { stage: 'normalize', progress: 32 });
    jobLog(db, jobId, `解析完成：${extracted.kind}，${extracted.sections.length} 节，${extracted.warnings.length} 个提示`);

    let extractedText = cleanText(extracted.text);
    const assetIds: string[] = [];
    const assetDir = join(env.uploadsDir, source.library_id, source.id, 'assets');
    mkdirSync(assetDir, { recursive: true });

    const persistAsset = (asset: { filename: string; mime: string; kind: string; data: Buffer; width?: number; height?: number; ocrText?: string }) => {
      const assetId = newId('ast');
      const name = safeFilename(asset.filename) || `${assetId}.bin`;
      const path = join(assetDir, name);
      writeFileSync(path, asset.data);
      let thumb: string | null = null;
      if (asset.kind === 'image') {
        thumb = join(env.thumbnailsDir, `${assetId}.jpg`);
        mkdirSync(env.thumbnailsDir, { recursive: true });
        if (!makeThumbnail(path, thumb)) thumb = null;
      }
      db.prepare(
        `INSERT INTO source_assets (id, source_id, kind, filename, mime, storage_path, thumbnail_path, sha256, width, height, ocr_text, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        assetId,
        source.id,
        asset.kind,
        name,
        asset.mime,
        path,
        thumb,
        sha256(asset.data),
        asset.width ?? null,
        asset.height ?? null,
        asset.ocrText ?? '',
        JSON.stringify({ original: asset.filename }),
        nowIso(),
      );
      assetIds.push(assetId);
      return assetId;
    };

    if (source.kind === 'image' || extracted.kind === 'image') {
      const thumb = join(env.thumbnailsDir, `${source.id}.jpg`);
      mkdirSync(env.thumbnailsDir, { recursive: true });
      const ok = makeThumbnail(source.storage_path, thumb, 1200);
      persistAsset({
        filename: source.filename,
        mime: source.mime || mimeFor(source.filename),
        kind: 'image',
        data: buffer,
        width: Number(extracted.metadata.width ?? 0) || undefined,
        height: Number(extracted.metadata.height ?? 0) || undefined,
        ocrText: extractedText,
      });
      if (!ok) jobLog(db, jobId, '缩略图生成失败，但原图已保存');
    }

    let ocrAppend = '';
    for (const [index, asset] of extracted.assets.entries()) {
      if (index >= 8) break;
      let ocrText = asset.ocrText ?? '';
      if (asset.kind === 'image' && !ocrText) {
        const ocr = ocrImage(asset.data);
        ocrText = ocr.text;
        if (ocr.warning) jobLog(db, jobId, ocr.warning);
      }
      const assetId = persistAsset({ ...asset, ocrText });
      if (ocrText.trim()) {
        const alreadyIntegrated = extractedText.includes(ocrText.trim().slice(0, 80));
        if (!alreadyIntegrated) ocrAppend += `\n\n## 图片文字（${asset.filename}）\n${ocrText}`;
        void assetId;
      }
    }
    if (ocrAppend) {
      extractedText = cleanText(`${extractedText}${ocrAppend}`);
      jobLog(db, jobId, `识别到 ${extracted.assets.length} 个内嵌图片，OCR 文本已并入知识`);
    }

    const excerpt = truncate(extractedText, 240);
    const sectionsMeta = extracted.sections.map((section) => ({
      title: section.title,
      level: section.level,
      page: section.page ?? null,
      chars: section.text.length,
    }));
    const metadata = {
      ...extracted.metadata,
      sections: sectionsMeta,
      warnings: extracted.warnings,
      extractedBy: extracted.kind,
      assetCount: assetIds.length,
    };
    db.prepare(
      `UPDATE sources SET kind = ?, status = 'ready', page_count = ?, word_count = ?, excerpt = ?, extracted_text = ?,
         metadata = ?, mime = ?, updated_at = ? WHERE id = ?`,
    ).run(
      extracted.kind,
      extracted.pageCount,
      wordCount(extractedText),
      excerpt,
      extractedText,
      JSON.stringify(metadata),
      source.mime || mimeFor(source.filename),
      nowIso(),
      source.id,
    );

    const refreshed = db.prepare('SELECT * FROM sources WHERE id = ?').get(source.id) as unknown as SourceRow;
    indexSource(db, refreshed);

    setJob(db, jobId, { stage: 'compile', progress: 58 });
    jobLog(db, jobId, '开始知识编译：抽取概念、主张与关联');
    const report = compileSource(db, refreshed, { ...extracted, text: extractedText }, { actor: null, maxConcepts: 10 });

    setJob(db, jobId, {
      status: 'succeeded',
      stage: 'done',
      progress: 100,
      pages_created: report.pagesCreated,
      pages_updated: report.pagesUpdated,
      conflicts: report.conflicts,
      finished_at: nowIso(),
    });
    for (const line of report.log) jobLog(db, jobId, line);
    db.prepare(
      `UPDATE sources SET metadata = ?, updated_at = ? WHERE id = ?`,
    ).run(
      JSON.stringify({
        ...metadata,
        compiled: {
          sourcePageId: report.sourcePageId,
          conceptIds: report.conceptIds,
          pagesCreated: report.pagesCreated,
          pagesUpdated: report.pagesUpdated,
          conflicts: report.conflicts,
          compiledAt: nowIso(),
        },
      }),
      nowIso(),
      source.id,
    );
    audit(db, {
      action: 'source.compiled',
      targetType: 'source',
      targetId: source.id,
      libraryId: source.library_id,
      detail: { pagesCreated: report.pagesCreated, pagesUpdated: report.pagesUpdated, conflicts: report.conflicts },
    });
  } catch (error) {
    const message = (error as Error).message || String(error);
    setJob(db, jobId, { status: 'failed', stage: 'failed', error: message, finished_at: nowIso() });
    db.prepare("UPDATE sources SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(message, nowIso(), source.id);
    jobLog(db, jobId, `失败：${message}`);
    console.error(`[ingest] ${source.filename}:`, error);
  }
}

export function reprocessSource(db: Db, env: Env, sourceId: string): string {
  const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(sourceId) as unknown as SourceRow | undefined;
  if (!source) throw errors.notFound('文献不存在');
  const jobId = newId('job');
  db.prepare(
    `INSERT INTO ingest_jobs (id, library_id, source_id, status, stage, progress, compiler, log, created_at)
     VALUES (?, ?, ?, 'queued', 'queued', 0, 'rule', '[]', ?)`,
  ).run(jobId, source.library_id, source.id, nowIso());
  db.prepare("UPDATE sources SET status = 'queued', error = NULL WHERE id = ?").run(source.id);
  setImmediate(() => processJob(db, env, jobId));
  return jobId;
}

export function ingestText(
  db: Db,
  env: Env,
  libraryId: string,
  title: string,
  text: string,
  options: { filename?: string; nodeId?: string | null; actor?: Actor | null; sync?: boolean } = {},
): IngestResult {
  const filename = options.filename ?? `${slugify(title, 'note')}.md`;
  const result = ingestBuffer(db, env, libraryId, {
    buffer: Buffer.from(text, 'utf8'),
    filename,
    title,
    nodeId: options.nodeId ?? null,
    actor: options.actor ?? null,
    defer: !options.sync,
  });
  if (options.sync && result.jobId) processJob(db, env, result.jobId);
  return result;
}

export function sourceDownloadName(source: SourceRow): string {
  return source.filename || `${source.title}${extname(source.storage_path) || ''}`;
}
