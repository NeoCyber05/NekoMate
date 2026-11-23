import { extractDateOnly } from './time.ts';
import type {
  ComposioGateway,
  ScopeOption,
  SourceAdapter,
  SourceConnection,
  SourceItem,
  SyncWindow,
} from './types.ts';

export const googleTasksAdapter: SourceAdapter = {
  id: 'google_tasks',
  name: 'Google Tasks',
  toolkit: 'googletasks',
  kind: 'task',
  timeMode: 'date_only',
  requiresScope: true,
  requiredTools: ['GOOGLETASKS_LIST_TASK_LISTS', 'GOOGLETASKS_LIST_TASKS'],

  async listOptions(
    connection: SourceConnection,
    gateway: ComposioGateway,
    userId: string,
  ): Promise<ScopeOption[]> {
    const raw = await gateway.executeTool({
      userId,
      connectedAccountId: connection.connectedAccountId,
      toolSlug: 'GOOGLETASKS_LIST_TASK_LISTS',
      arguments: {},
    });

    const payload = (raw['data'] && typeof raw['data'] === 'object' && !Array.isArray(raw['data']))
      ? (raw['data'] as Record<string, unknown>)
      : raw;

    const list = Array.isArray(payload['items'])
      ? (payload['items'] as Array<Record<string, unknown>>)
      : [];

    const options: ScopeOption[] = [];
    for (const row of list) {
      const id = typeof row['id'] === 'string' ? row['id'] : '';
      const label = typeof row['title'] === 'string' ? row['title'] : '';
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
  ): Promise<SourceItem[]> {
    if (!connection.scopeId) {
      throw new Error('Google Tasks cần chọn danh sách công việc');
    }
    const items: SourceItem[] = [];
    let pageToken: string | undefined;

    do {
      const args: Record<string, unknown> = {
        tasklist: connection.scopeId,
        showCompleted: false,
        showDeleted: false,
        showHidden: false,
      };
      if (pageToken) {
        args['pageToken'] = pageToken;
      }

      const raw = await gateway.executeTool({
        userId,
        connectedAccountId: connection.connectedAccountId,
        toolSlug: 'GOOGLETASKS_LIST_TASKS',
        arguments: args,
      });

      const payload = (raw['data'] && typeof raw['data'] === 'object' && !Array.isArray(raw['data']))
        ? (raw['data'] as Record<string, unknown>)
        : raw;

      const list = Array.isArray(payload['items'])
        ? (payload['items'] as Array<Record<string, unknown>>)
        : [];

      for (const task of list) {
        if (task['status'] === 'completed' || task['deleted'] === true || task['hidden'] === true) {
          continue;
        }
        const id = typeof task['id'] === 'string' ? task['id'] : '';
        if (!id) {
          continue;
        }
        const title = typeof task['title'] === 'string' && task['title'].trim()
          ? task['title'].trim()
          : 'Việc Google Tasks';
        const dateOnly = extractDateOnly(task['due']);
        // Google Tasks API chỉ lưu phần ngày (thường trả về T00:00:00.000Z), không đặt giờ nhắc MQTT
        if (dateOnly) {
          items.push({
            externalId: id,
            title,
            dateOnly,
            notifyAt: null,
          });
        }
      }

      pageToken = typeof payload['nextPageToken'] === 'string' && payload['nextPageToken']
        ? payload['nextPageToken']
        : undefined;
    } while (pageToken);

    return items;
  },
};
