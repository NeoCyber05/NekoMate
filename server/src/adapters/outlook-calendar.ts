import { extractDateOnly, parseMicrosoftDateTime } from './time.ts';
import type { ComposioGateway, SourceAdapter, SourceConnection, SourceItem, SyncWindow } from './types.ts';

const REMIND_BEFORE_SEC = 10 * 60;

function extractSkipToken(nextLink: unknown): string | undefined {
  if (typeof nextLink !== 'string' || !nextLink) {
    return undefined;
  }
  try {
    const u = new URL(nextLink);
    return u.searchParams.get('$skiptoken') ?? u.searchParams.get('skiptoken') ?? nextLink;
  } catch {
    return nextLink;
  }
}

export const outlookCalendarAdapter: SourceAdapter = {
  id: 'outlook_calendar',
  name: 'Outlook Calendar',
  toolkit: 'outlook',
  kind: 'calendar',
  timeMode: 'mixed',
  requiresScope: false,
  sharedAuthGroup: 'outlook',
  requiredTools: ['OUTLOOK_GET_CALENDAR_VIEW'],

  async verifyConnection(
    connectedAccountId: string,
    gateway: ComposioGateway,
    userId: string,
    nowSec: number,
  ): Promise<void> {
    await gateway.executeTool({
      userId,
      connectedAccountId,
      toolSlug: 'OUTLOOK_GET_CALENDAR_VIEW',
      arguments: {
        startDateTime: new Date(nowSec * 1000).toISOString(),
        endDateTime: new Date((nowSec + 3600) * 1000).toISOString(),
      },
    });
  },

  async readSource(
    connection: SourceConnection,
    window: SyncWindow,
    gateway: ComposioGateway,
    userId: string,
    timezone: string,
  ): Promise<SourceItem[]> {
    const items: SourceItem[] = [];
    let nextToken: string | undefined;

    do {
      const args: Record<string, unknown> = {
        startDateTime: new Date(window.from * 1000).toISOString(),
        endDateTime: new Date((window.to + REMIND_BEFORE_SEC) * 1000).toISOString(),
      };
      if (nextToken) {
        args['skipToken'] = nextToken;
      }

      const raw = await gateway.executeTool({
        userId,
        connectedAccountId: connection.connectedAccountId,
        toolSlug: 'OUTLOOK_GET_CALENDAR_VIEW',
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

      for (const ev of list) {
        if (ev['isCancelled'] === true) {
          continue;
        }
        const id = typeof ev['id'] === 'string' ? ev['id'] : '';
        if (!id) {
          continue;
        }
        const title = typeof ev['subject'] === 'string' && ev['subject'].trim()
          ? ev['subject'].trim()
          : 'Sự kiện Outlook';

        if (ev['isAllDay'] === true) {
          const startObj = ev['start'] as Record<string, unknown> | undefined;
          const dateOnly = extractDateOnly(startObj?.['dateTime']);
          if (dateOnly) {
            items.push({ externalId: id, title, dateOnly, notifyAt: null });
          }
          continue;
        }

        const startSec = parseMicrosoftDateTime(ev['start'], timezone);
        if (startSec !== null) {
          items.push({
            externalId: id,
            title,
            dateOnly: null,
            notifyAt: startSec - REMIND_BEFORE_SEC,
          });
        }
      }

      nextToken = extractSkipToken(payload['@odata.nextLink'] ?? payload['nextLink']);
    } while (nextToken);

    return items;
  },
};
