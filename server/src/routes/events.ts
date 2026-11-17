import type { Router } from '../http/router.ts';
import { requireActor } from '../http/auth.ts';
import { visibleLibraries } from '../domain/access.ts';
import { subscribe } from '../realtime.ts';

export function registerEventRoutes(router: Router): void {
  router.get('/api/events', (rc) => {
    const actor = requireActor(rc);
    rc.res.statusCode = 200;
    rc.res.setHeader('content-type', 'text/event-stream; charset=utf-8');
    rc.res.setHeader('cache-control', 'no-store');
    rc.res.setHeader('connection', 'keep-alive');
    rc.res.setHeader('x-accel-buffering', 'no');
    rc.res.flushHeaders?.();
    rc.res.write(`event: hello\ndata: ${JSON.stringify({ actorId: actor.person.id })}\n\n`);
    const libraries = visibleLibraries(rc.app.db, actor).map((library) => library.id);
    const unsubscribe = subscribe(rc.res, actor.person.id, libraries);
    rc.res.on('close', unsubscribe);
  });
}
