import { extractDateOnly, parseIsoDateTimeToUnixSec } from './time.ts';
import type { ComposioGateway, SourceAdapter, SourceConnection, SourceItem, SyncWindow } from './types.ts';

const REMIND_BEFORE_SEC = 10 * 60;

export const googleCalendarAdapter: SourceAdapter = {
  id: 'google_calendar',
  name: 'Google Calendar',
  toolkit: 'googlecalendar',
  kind: 'calendar',
  timeMode: 'mixed',
  requiresScope: false,
  requiredTools: ['GOOGLECALENDAR_EVENTS_LIST'],

  async readSource(
    connection: SourceConnection,
    window: SyncWindow,
    gateway: ComposioGateway,
    userId: string,
    timezone: string,
  ): Promise<SourceItem[]> {
    const items: SourceItem[] = [];
    let pageToken: string | undefined;

    do {
      const args: Record<string, unknown> = {
        calendarId: 'primary',
        singleEvents: true,
        timeMin: new Date(window.from * 1000).toISOString(),
        timeMax: new Date((window.to + REMIND_BEFORE_SEC) * 1000).toISOString(),
        maxResults: 250,
      };
      if (pageToken) {
        args['pageToken'] = pageToken;
      }

      const raw = await gateway.executeTool({
        userId,
        connectedAccountId: connection.connectedAccountId,
        toolSlug: 'GOOGLECALENDAR_EVENTS_LIST',
        arguments: args,
      });

      const payload = (raw['data'] && typeof raw['data'] === 'object' && !Array.isArray(raw['data']))
        ? (raw['data'] as Record<string, unknown>)
        : raw;

      const pageItems = Array.isArray(payload['items'])
        ? (payload['items'] as Array<Record<string, unknown>>)
        : [];

      for (const ev of pageItems) {
        if (ev['status'] === 'cancelled') {
          continue;
        }
        const id = typeof ev['id'] === 'string' ? ev['id'] : '';
        if (!id) {
          continue;
        }
        const summary = typeof ev['summary'] === 'string' && ev['summary'].trim()
          ? ev['summary'].trim()
          : 'Sự kiện lịch';
        const start = ev['start'] as Record<string, unknown> | undefined;
        if (!start || typeof start !== 'object') {
          continue;
        }

        if (typeof start['dateTime'] === 'string') {
          const startSec = parseIsoDateTimeToUnixSec(start['dateTime'], timezone);
          if (startSec !== null) {
            items.push({
              externalId: id,
              title: summary,
              dateOnly: null,
              notifyAt: startSec - REMIND_BEFORE_SEC,
            });
          }
        } else if (typeof start['date'] === 'string') {
          const dateOnly = extractDateOnly(start['date']);
          if (dateOnly) {
            items.push({
              externalId: id,
              title: summary,
              dateOnly,
              notifyAt: null,
            });
          }
        }
      }

      pageToken = typeof payload['nextPageToken'] === 'string' && payload['nextPageToken']
        ? payload['nextPageToken']
        : undefined;
    } while (pageToken);

    return items;
  },
};
