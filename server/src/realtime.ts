import type { ServerResponse } from 'node:http';

interface Client {
  res: ServerResponse;
  actorId: string;
  libraryIds: Set<string> | null;
}

const clients = new Set<Client>();

export function subscribe(res: ServerResponse, actorId: string, libraryIds: string[] | null): () => void {
  const client: Client = { res, actorId, libraryIds: libraryIds ? new Set(libraryIds) : null };
  clients.add(client);
  const heartbeat = setInterval(() => {
    try { res.write(`: ping ${Date.now()}\n\n`); } catch { /* ignore */ }
  }, 25_000);
  heartbeat.unref?.();
  return () => {
    clearInterval(heartbeat);
    clients.delete(client);
  };
}

export function publish(event: { type: string; pageId?: string; libraryId?: string; actorId?: string; actorName?: string; data?: Record<string, unknown> }): void {
  const payload = `event: ${event.type}\ndata: ${JSON.stringify({ ...event, at: new Date().toISOString() })}\n\n`;
  for (const client of clients) {
    if (event.libraryId && client.libraryIds && !client.libraryIds.has(event.libraryId)) continue;
    try { client.res.write(payload); } catch { clients.delete(client); }
  }
}
