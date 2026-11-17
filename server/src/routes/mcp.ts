import type { Router } from '../http/router.ts';
import { requireActor } from '../http/auth.ts';
import { errors } from '../http/respond.ts';
import { searchKnowledge, graphForLibrary } from '../knowledge/search.ts';
import { createPage, getPage, pageContext, updatePage } from '../knowledge/pages.ts';
import { pageAccess } from './helpers.ts';
import { requireLibrary } from '../domain/access.ts';
import { audit } from '../domain/audit.ts';

const TOOLS = [
  { name: 'search', description: 'Search compiled knowledge pages and sources', inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' }, libraryIds: { type: 'array', items: { type: 'string' } } }, required: ['query'] } },
  { name: 'read', description: 'Read a knowledge page with claims, sources and links', inputSchema: { type: 'object', properties: { pageId: { type: 'string' } }, required: ['pageId'] } },
  { name: 'graph', description: 'Read a typed knowledge graph neighborhood', inputSchema: { type: 'object', properties: { libraryId: { type: 'string' }, limit: { type: 'number' } }, required: ['libraryId'] } },
  { name: 'write_page', description: 'Create or update a typed knowledge page', inputSchema: { type: 'object', properties: { pageId: { type: 'string' }, libraryId: { type: 'string' }, title: { type: 'string' }, classKey: { type: 'string' }, summary: { type: 'string' }, body: { type: 'string' }, properties: { type: 'object' } }, required: ['title'] } },
  { name: 'lint', description: 'Return structural health of a library', inputSchema: { type: 'object', properties: { libraryId: { type: 'string' } }, required: ['libraryId'] } },
];

function result(content: unknown) {
  return { content: [{ type: 'text', text: typeof content === 'string' ? content : JSON.stringify(content, null, 2) }] };
}

export function registerMcpRoutes(router: Router): void {
  router.post('/mcp', async (rc) => {
    const actor = requireActor(rc);
    const body = await rc.body<{ id?: string | number; method?: string; params?: Record<string, unknown> }>();
    const id = body.id ?? null;
    const reply = (payload: Record<string, unknown>) => rc.json({ jsonrpc: '2.0', id, ...payload });
    try {
      if (body.method === 'initialize') {
        reply({ result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'alexandria', version: '0.1.0' } } });
        return;
      }
      if (body.method === 'tools/list') {
        reply({ result: { tools: TOOLS } });
        return;
      }
      if (body.method !== 'tools/call') throw errors.badRequest('unsupported MCP method');
      const name = String(body.params?.name ?? '');
      const args = (body.params?.arguments ?? {}) as Record<string, unknown>;
      if (name === 'search') {
        const hits = searchKnowledge(rc.app.db, actor, String(args.query ?? ''), { limit: Math.min(30, Number(args.limit ?? 12)), libraryIds: Array.isArray(args.libraryIds) ? args.libraryIds.map(String) : undefined });
        reply({ result: result(hits.map((hit) => ({ id: hit.id, title: hit.title, kind: hit.kind, libraryId: hit.libraryId, snippet: hit.snippet, score: hit.score }))) });
        return;
      }
      if (name === 'read') {
        const page = getPage(rc.app.db, String(args.pageId ?? ''));
        if (!page) throw errors.notFound('知识页不存在');
        pageAccess(rc, page.id, 'viewer');
        reply({ result: result({ page: { id: page.id, title: page.title, classKey: page.class_key, summary: page.summary, effectiveDate: page.effective_date }, context: pageContext(rc.app.db, page) }) });
        return;
      }
      if (name === 'graph') {
        reply({ result: result(graphForLibrary(rc.app.db, actor, String(args.libraryId ?? ''), { limit: Number(args.limit ?? 200) })) });
        return;
      }
      if (name === 'write_page') {
        const pageId = String(args.pageId ?? '');
        if (pageId) {
          pageAccess(rc, pageId, 'editor');
          const page = updatePage(rc.app.db, getPage(rc.app.db, pageId)!, { title: String(args.title ?? ''), classKey: args.classKey ? String(args.classKey) : undefined, summary: args.summary ? String(args.summary) : undefined, body: args.body ? String(args.body) : undefined, properties: args.properties && typeof args.properties === 'object' ? args.properties as Record<string, unknown> : undefined, note: 'MCP write_page' }, actor);
          audit(rc.app.db, { actor, action: 'mcp.page.update', targetType: 'page', targetId: page.id, libraryId: page.library_id, detail: { title: page.title } });
          reply({ result: result({ id: page.id, title: page.title, classKey: page.class_key, slug: page.slug }) });
          return;
        }
        const libraryId = String(args.libraryId ?? '');
        const { library } = requireLibrary(rc.app.db, actor, libraryId, 'editor');
        const page = createPage(rc.app.db, { libraryId: library.id, title: String(args.title), classKey: args.classKey ? String(args.classKey) : 'concept', summary: args.summary ? String(args.summary) : '', body: args.body ? String(args.body) : '', properties: args.properties && typeof args.properties === 'object' ? args.properties as Record<string, unknown> : undefined, createdBy: actor.person.id }, actor);
        audit(rc.app.db, { actor, action: 'mcp.page.create', targetType: 'page', targetId: page.id, libraryId: library.id, detail: { title: page.title } });
        reply({ result: result({ id: page.id, title: page.title, classKey: page.class_key, slug: page.slug }) });
        return;
      }
      if (name === 'lint') {
        const libraryId = String(args.libraryId ?? '');
        requireLibrary(rc.app.db, actor, libraryId, 'viewer');
        const counts = rc.app.db.prepare('SELECT class_key, count(*) c FROM pages WHERE library_id = ? GROUP BY class_key').all(libraryId);
        const orphans = rc.app.db.prepare('SELECT count(*) c FROM pages p WHERE p.library_id = ? AND p.class_key <> ? AND NOT EXISTS (SELECT 1 FROM links l WHERE l.from_page_id = p.id OR l.to_page_id = p.id)').get(libraryId, 'source') as unknown as { c: number };
        reply({ result: result({ counts, orphans: orphans.c }) });
        return;
      }
      throw errors.badRequest(`unknown tool: ${name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'MCP error';
      reply({ error: { code: -32602, message } });
    }
  });
}
