import { extractDateOnly, parseIsoDateTimeToUnixSec } from './time.ts';
import type { ComposioGateway, SourceAdapter, SourceConnection, SourceItem, SyncWindow } from './types.ts';

export const todoistAdapter: SourceAdapter = {
  id: 'todoist',
  name: 'Todoist',
  toolkit: 'todoist',
  kind: 'task',
  timeMode: 'mixed',
  requiresScope: false,
  requiredTools: ['TODOIST_GET_ALL_TASKS'],

  async readSource(
    connection: SourceConnection,
    _window: SyncWindow,
    gateway: ComposioGateway,
    userId: string,
    timezone: string,
  ): Promise<SourceItem[]> {
    const items: SourceItem[] = [];
    let cursor: string | undefined;

    do {
      const args: Record<string, unknown> = {};
      if (cursor) {
        args['cursor'] = cursor;
      }

      const raw = await gateway.executeTool({
        userId,
        connectedAccountId: connection.connectedAccountId,
        toolSlug: 'TODOIST_GET_ALL_TASKS',
        arguments: args,
      });

      const payload = (raw['data'] && typeof raw['data'] === 'object' && !Array.isArray(raw['data']))
        ? (raw['data'] as Record<string, unknown>)
        : raw;

      const list = Array.isArray(payload['items'])
        ? (payload['items'] as Array<Record<string, unknown>>)
        : Array.isArray(payload['results'])
          ? (payload['results'] as Array<Record<string, unknown>>)
          : Array.isArray(raw)
            ? (raw as Array<Record<string, unknown>>)
            : [];

      for (const task of list) {
        if (task['is_completed'] === true || task['checked'] === true || task['completed'] === true) {
          continue;
        }
        const id = task['id'] !== undefined && task['id'] !== null ? String(task['id']) : '';
        if (!id) {
          continue;
        }
        const title = typeof task['content'] === 'string' && task['content'].trim()
          ? task['content'].trim()
          : 'Công việc Todoist';

        const due = task['due'] as Record<string, unknown> | undefined;
        if (!due || typeof due !== 'object') {
          continue;
        }

        if (typeof due['datetime'] === 'string' && due['datetime'].trim()) {
          const notifyAt = parseIsoDateTimeToUnixSec(due['datetime'], timezone);
          if (notifyAt !== null) {
            items.push({
              externalId: id,
              title,
              dateOnly: null,
              notifyAt,
            });
          }
        } else if (typeof due['date'] === 'string' && due['date'].trim()) {
          if (due['date'].includes('T')) {
            const notifyAt = parseIsoDateTimeToUnixSec(due['date'], timezone);
            if (notifyAt !== null) {
              items.push({ externalId: id, title, dateOnly: null, notifyAt });
              continue;
            }
          }
          const dateOnly = extractDateOnly(due['date']);
          if (dateOnly) {
            items.push({
              externalId: id,
              title,
              dateOnly,
              notifyAt: null,
            });
          }
        }
      }

      const nextCursor =
        typeof payload['next_cursor'] === 'string'
          ? payload['next_cursor']
          : typeof payload['nextCursor'] === 'string'
            ? payload['nextCursor']
            : '';
      cursor = nextCursor || undefined;
    } while (cursor);

    return items;
  },
};
