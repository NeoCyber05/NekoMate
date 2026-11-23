export interface SourceItem {
  externalId: string;
  title: string;
  dateOnly: string | null;
  notifyAt: number | null;
}

export interface SourceConnection {
  sourceId: string;
  connectedAccountId: string;
  scopeId: string | null;
}

export interface SyncWindow {
  from: number;
  to: number;
}

export interface ScopeOption {
  id: string;
  label: string;
}

export interface ComposioConnectedAccount {
  id: string;
  userId?: string;
  toolkitSlug: string;
  status: string;
}

export interface ComposioGateway {
  createConnectLink(params: {
    userId: string;
    toolkit: string;
    callbackUrl: string;
  }): Promise<{ connectionRequestId: string; redirectUrl: string }>;
  getConnectedAccount(
    connectedAccountId: string,
    expectedUserId?: string,
  ): Promise<ComposioConnectedAccount | null>;
  executeTool(params: {
    userId: string;
    connectedAccountId?: string;
    toolSlug: string;
    arguments: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
}

export interface SourceAdapter {
  readonly id: string;
  readonly name: string;
  readonly toolkit: string;
  readonly kind: 'calendar' | 'task';
  readonly timeMode: 'timed' | 'date_only' | 'mixed';
  readonly requiresScope: boolean;
  readonly sharedAuthGroup?: string;
  readonly requiredTools: readonly string[];
  readSource(
    connection: SourceConnection,
    window: SyncWindow,
    gateway: ComposioGateway,
    userId: string,
    timezone: string,
  ): Promise<SourceItem[]>;
  listOptions?(
    connection: SourceConnection,
    gateway: ComposioGateway,
    userId: string,
  ): Promise<ScopeOption[]>;
  verifyConnection?(
    connectedAccountId: string,
    gateway: ComposioGateway,
    userId: string,
    nowSec: number,
  ): Promise<void>;
}
