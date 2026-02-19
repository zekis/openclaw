import {
  DEFAULT_ACCOUNT_ID,
  getChatChannelMeta,
  type ChannelPlugin,
  type ChannelStatusIssue,
  type OpenClawConfig,
} from "openclaw/plugin-sdk";
import { ravenProbe, ravenSendMessage } from "./api.js";
import { monitorRavenProvider, resolveRavenWebhookPath } from "./monitor.js";

const meta = getChatChannelMeta("raven");

/**
 * Raw config as read from the OpenClaw config file under channels.raven.
 * Stored as-is from YAML/JSON; all fields are optional.
 */
type RavenRawConfig = {
  enabled?: boolean;
  baseUrl?: string;
  apiKey?: string;
  apiKeyFile?: string;
  apiSecret?: string;
  apiSecretFile?: string;
  webhookPath?: string;
  webhookSecret?: string;
  botUser?: string;
  name?: string;
  dmPolicy?: string;
  allowFrom?: string | string[];
};

/**
 * Resolved account — credentials and config normalised and validated.
 */
export type ResolvedRavenAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
  webhookPath?: string;
  webhookSecret?: string;
  botUser?: string;
  config: {
    dmPolicy?: string;
    allowFrom?: string[];
    webhookPath?: string;
  };
};

function getRawConfig(cfg: OpenClawConfig): RavenRawConfig {
  return (cfg.channels?.raven as RavenRawConfig) ?? {};
}

function normalizeAllowFrom(raw: string | string[] | undefined): string[] {
  if (!raw) return [];
  return (Array.isArray(raw) ? raw : [raw])
    .map((v) => String(v).trim())
    .filter(Boolean);
}

function resolveRavenAccount(cfg: OpenClawConfig): ResolvedRavenAccount {
  const raw = getRawConfig(cfg);
  return {
    accountId: DEFAULT_ACCOUNT_ID,
    name: raw.name?.trim(),
    enabled: raw.enabled !== false,
    baseUrl: raw.baseUrl?.trim() ?? "",
    apiKey: raw.apiKey?.trim() ?? "",
    apiSecret: raw.apiSecret?.trim() ?? "",
    webhookPath: raw.webhookPath?.trim(),
    webhookSecret: raw.webhookSecret?.trim(),
    botUser: raw.botUser?.trim(),
    config: {
      dmPolicy: raw.dmPolicy?.trim(),
      allowFrom: normalizeAllowFrom(raw.allowFrom),
      webhookPath: raw.webhookPath?.trim(),
    },
  };
}

function isConfigured(account: ResolvedRavenAccount): boolean {
  return Boolean(account.baseUrl && account.apiKey && account.apiSecret);
}

export const ravenPlugin: ChannelPlugin<ResolvedRavenAccount> = {
  id: "raven",
  meta: {
    ...meta,
  },
  capabilities: {
    chatTypes: ["group"],
    reactions: false,
    threads: false,
    media: false,
    polls: false,
    nativeCommands: false,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.raven"] },
  config: {
    listAccountIds: (_cfg) => [DEFAULT_ACCOUNT_ID],
    resolveAccount: (cfg, _accountId) => resolveRavenAccount(cfg),
    defaultAccountId: (_cfg) => DEFAULT_ACCOUNT_ID,
    setAccountEnabled: ({ cfg, enabled }) => ({
      ...cfg,
      channels: {
        ...cfg.channels,
        raven: {
          ...(getRawConfig(cfg) as object),
          enabled,
        },
      },
    }),
    deleteAccount: ({ cfg }) => {
      const next = { ...cfg };
      const channels = { ...next.channels };
      delete channels.raven;
      if (Object.keys(channels).length > 0) {
        next.channels = channels;
      } else {
        delete next.channels;
      }
      return next;
    },
    isConfigured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: isConfigured(account),
      baseUrl: account.baseUrl || null,
    }),
    resolveAllowFrom: ({ cfg }) =>
      normalizeAllowFrom(getRawConfig(cfg).allowFrom),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((v) => String(v).trim().replace(/^raven:/i, ""))
        .filter(Boolean),
  },
  setup: {
    resolveAccountId: () => DEFAULT_ACCOUNT_ID,
    applyAccountName: ({ cfg, name }) => ({
      ...cfg,
      channels: {
        ...cfg.channels,
        raven: { ...(getRawConfig(cfg) as object), name },
      },
    }),
    validateInput: ({ input }) => {
      if (!input.token && !input.tokenFile) {
        return "Raven requires --token (format: baseUrl|apiKey|apiSecret) or --token-file.";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, input }) => {
      // Token format: "baseUrl|apiKey|apiSecret"
      const tokenStr = input.token ?? "";
      const [baseUrl, apiKey, apiSecret] = tokenStr.split("|");
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          raven: {
            ...(getRawConfig(cfg) as object),
            enabled: true,
            ...(baseUrl ? { baseUrl: baseUrl.trim() } : {}),
            ...(apiKey ? { apiKey: apiKey.trim() } : {}),
            ...(apiSecret ? { apiSecret: apiSecret.trim() } : {}),
            ...(input.tokenFile ? { apiKeyFile: input.tokenFile } : {}),
          },
        },
      };
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunkerMode: "markdown",
    textChunkLimit: 10000,
    sendText: async ({ cfg, to, text, accountId }) => {
      const account = resolveRavenAccount(cfg);
      const channelId = to.replace(/^raven:/i, "").trim();
      if (!channelId) {
        throw new Error("Raven: missing channel ID for outbound message");
      }
      const result = await ravenSendMessage({
        creds: {
          baseUrl: account.baseUrl,
          apiKey: account.apiKey,
          apiSecret: account.apiSecret,
        },
        channelId,
        text,
        markdown: true,
      });
      return { channel: "raven", messageId: result.messageId, chatId: result.chatId };
    },
  },
  messaging: {
    normalizeTarget: (raw) => {
      const trimmed = String(raw ?? "").trim().replace(/^raven:/i, "");
      return trimmed || null;
    },
    targetResolver: {
      looksLikeId: (raw) => {
        const normalized = String(raw ?? "")
          .trim()
          .replace(/^raven:/i, "");
        return normalized.length > 0;
      },
      hint: "<channelId>",
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: (accounts): ChannelStatusIssue[] =>
      accounts.flatMap((entry) => {
        const accountId = String(entry.accountId ?? DEFAULT_ACCOUNT_ID);
        const enabled = entry.enabled !== false;
        const configured = entry.configured === true;
        if (!enabled || !configured) return [];
        const issues: ChannelStatusIssue[] = [];
        if (!entry.baseUrl) {
          issues.push({
            channel: "raven",
            accountId,
            kind: "config",
            message: "Raven baseUrl is not configured.",
            fix: "Set channels.raven.baseUrl to your Raven server URL.",
          });
        }
        return issues;
      }),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      baseUrl: snapshot.baseUrl ?? null,
      running: snapshot.running ?? false,
      webhookPath: snapshot.webhookPath ?? null,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }) =>
      ravenProbe({ creds: account, timeoutMs }),
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: isConfigured(account),
      baseUrl: account.baseUrl || null,
      webhookPath: resolveRavenWebhookPath({ account }),
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
      probe,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.log?.info(`[${account.accountId}] starting Raven webhook listener`);

      ctx.setStatus({
        accountId: account.accountId,
        running: true,
        lastStartAt: Date.now(),
        webhookPath: resolveRavenWebhookPath({ account }),
      });

      const unregister = monitorRavenProvider({
        account,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        statusSink: (patch) => ctx.setStatus({ accountId: account.accountId, ...patch }),
      });

      return () => {
        unregister();
        ctx.setStatus({
          accountId: account.accountId,
          running: false,
          lastStopAt: Date.now(),
        });
      };
    },
  },
};
