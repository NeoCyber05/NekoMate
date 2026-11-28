import { extractDateOnly, parseMicrosoftDateTime } from './time.ts';
import type {
  ComposioGateway,
  ScopeOption,
  SourceAdapter,
  SourceConnection,
  SourceItem,
  SyncWindow,
} from './types.ts';

export const microsoftTodoAdapter: SourceAdapter = {
  id: 'microsoft_todo',
  name: 'Microsoft To Do',
  toolkit: 'outlook',
  kind: 'task',
  timeMode: 'mixed',
  requiresScope: true,
  sharedAuthGroup: 'outlook',
  requiredTools: ['OUTLOOK_LIST_TO_DO_LISTS', 'OUTLOOK_LIST_TODO_TASKS'],

  async verifyConnection(
    connectedAccountId: string,
    gateway: ComposioGateway,
    userId: string,
  ): Promise<void> {
    await gateway.executeTool({
      userId,
      connectedAccountId,
      toolSlug: 'OUTLOOK_LIST_TO_DO_LISTS',
      arguments: {},
    });
  },

  async listOptions(
    connection: SourceConnection,
    gateway: ComposioGateway,
    userId: string,
  ): Promise<ScopeOption[]> {
    const raw = await gateway.executeTool({
      userId,
      connectedAccountId: connection.connectedAccountId,
      toolSlug: 'OUTLOOK_LIST_TO_DO_LISTS',
      arguments: {},
    });

    const payload = (raw['data'] && typeof raw['data'] === 'object' && !Array.isArray(raw['data']))
      ? (raw['data'] as Record<string, unknown>)
      : raw;

    const list = Array.isArray(payload['value'])
      ? (payload['value'] as Array<Record<string, unknown>>)
      : Array.isArray(payload['items'])
        ? (payload['items'] as Array<Record<string, unknown>>)
        : [];

    const options: ScopeOption[] = [];
    for (const row of list) {
      const id = typeof row['id'] === 'string' ? row['id'] : '';
      const label = typeof row['displayName'] === 'string'
        ? row['displayName']
        : typeof row['name'] === 'string'
          ? row['name']
          : '';
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
      throw new Error('Microsoft To Do cần chọn danh sách công việc');
    }
    const items: SourceItem[] = [];
    let nextToken: string | undefined;

    do {
      const args: Record<string, unknown> = {
        todoTaskListId: connection.scopeId,
      };
      if (nextToken) {
        args['skipToken'] = nextToken;
      }

      const raw = await gateway.executeTool({
        userId,
        connectedAccountId: connection.connectedAccountId,
        toolSlug: 'OUTLOOK_LIST_TODO_TASKS',
        arguments: args,
      });

      const payload = (raw['data'] && typeof raw['data'] === 'object' && !Array.isArray(raw['data']))
        ? (raw['data'] as Record<string, unknown>)
        : raw;

      const list = Array.isArray(payload['value'])
        ? (payload['value'] as Array<Record<string, unknown>>)
        : Array.isArray(payload['items'])
          ? (payload['items'] as Array<Record<string, unknown>>)
          : [];

      for (const task of list) {
        if (task['status'] === 'completed') {
          continue;
        }
        const id = typeof task['id'] === 'string' ? task['id'] : '';
        if (!id) {
          continue;
        }
        const title = typeof task['title'] === 'string' && task['title'].trim()
          ? task['title'].trim()
          : 'Việc Microsoft To Do';

        const dueObj = task['dueDateTime'] as Record<string, unknown> | undefined;
        const dateOnly = extractDateOnly(dueObj?.['dateTime']);

        let notifyAt: number | null = null;
        if (task['isReminderOn'] === true && task['reminderDateTime']) {
          notifyAt = parseMicrosoftDateTime(task['reminderDateTime'], timezone);
        }

        items.push({ externalId: id, title, dateOnly: notifyAt === null ? dateOnly : null, notifyAt });
      }

      const nextLink = payload['@odata.nextLink'] ?? payload['nextLink'];
      nextToken = typeof nextLink === 'string' && nextLink ? nextLink : undefined;
    } while (nextToken);

    return items;
  },
};
