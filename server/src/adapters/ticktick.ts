import { extractDateOnly, parseIsoDateTimeToUnixSec } from './time.ts';
import type {
  ComposioGateway,
  ScopeOption,
  SourceAdapter,
  SourceConnection,
  SourceItem,
  SyncWindow,
} from './types.ts';

export const ticktickAdapter: SourceAdapter = {
  id: 'ticktick',
  name: 'TickTick',
  toolkit: 'ticktick',
  kind: 'task',
  timeMode: 'mixed',
  requiresScope: true,
  requiredTools: ['TICKTICK_GET_USER_PROJECT', 'TICKTICK_GET_PROJECT_WITH_DATA'],

  async listOptions(
    connection: SourceConnection,
    gateway: ComposioGateway,
    userId: string,
  ): Promise<ScopeOption[]> {
    const raw = await gateway.executeTool({
      userId,
      connectedAccountId: connection.connectedAccountId,
      toolSlug: 'TICKTICK_GET_USER_PROJECT',
      arguments: {},
    });

    const payload = (raw['data'] && typeof raw['data'] === 'object' && !Array.isArray(raw['data']))
      ? (raw['data'] as Record<string, unknown>)
      : raw;

    const list = Array.isArray(payload['projects'])
      ? (payload['projects'] as Array<Record<string, unknown>>)
      : Array.isArray(payload['items'])
        ? (payload['items'] as Array<Record<string, unknown>>)
        : Array.isArray(raw)
          ? (raw as Array<Record<string, unknown>>)
          : [];

    const options: ScopeOption[] = [];
    for (const proj of list) {
      const id = typeof proj['id'] === 'string' ? proj['id'] : '';
      const label = typeof proj['name'] === 'string' ? proj['name'] : '';
      if (id && label) {
        options.push({ id, label });
      }
    }
    return options;
  },

  async readSource(
    connection: SourceConnection,
    _window: SyncWindow,
    gateway: ComposioGateway,
    userId: string,
    timezone: string,
  ): Promise<SourceItem[]> {
    if (!connection.scopeId) {
      throw new Error('TickTick cần chọn project trước khi đồng bộ');
    }

    const raw = await gateway.executeTool({
      userId,
      connectedAccountId: connection.connectedAccountId,
      toolSlug: 'TICKTICK_GET_PROJECT_WITH_DATA',
      arguments: { projectId: connection.scopeId },
    });

    const payload = (raw['data'] && typeof raw['data'] === 'object' && !Array.isArray(raw['data']))
      ? (raw['data'] as Record<string, unknown>)
      : raw;

    const tasks = Array.isArray(payload['tasks'])
      ? (payload['tasks'] as Array<Record<string, unknown>>)
      : Array.isArray(payload['items'])
        ? (payload['items'] as Array<Record<string, unknown>>)
        : [];

    const items: SourceItem[] = [];
    for (const task of tasks) {
      if (task['status'] === 2 || task['status'] === 'completed' || task['completedTime']) {
        continue;
      }
      const id = typeof task['id'] === 'string' ? task['id'] : '';
      if (!id) {
        continue;
      }
      const title = typeof task['title'] === 'string' && task['title'].trim()
        ? task['title'].trim()
        : 'Việc TickTick';

      const dueRaw = task['dueDate'] ?? task['startDate'];
      if (typeof dueRaw !== 'string' || !dueRaw.trim()) {
        continue;
      }

      const dateOnly = extractDateOnly(dueRaw);
      const isAllDay = task['isAllDay'] === true || !dueRaw.includes('T');
      if (isAllDay) {
        if (dateOnly) {
          items.push({ externalId: id, title, dateOnly, notifyAt: null });
        }
        continue;
      }

      const notifyAt = parseIsoDateTimeToUnixSec(dueRaw, timezone);
      if (notifyAt !== null) {
        items.push({ externalId: id, title, dateOnly: null, notifyAt });
      }
    }

    return items;
  },
};
