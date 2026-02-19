import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import {
  createReplyPrefixOptions,
  registerWebhookTarget,
  rejectNonPostWebhookRequest,
  resolveWebhookPath,
  resolveWebhookTargets,
} from "openclaw/plugin-sdk";
import { ravenSendMessage } from "./api.js";
import type { ResolvedRavenAccount } from "./channel.js";
import { getRavenRuntime } from "./runtime.js";

export type RavenRuntimeEnv = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

type WebhookTarget = {
  account: ResolvedRavenAccount;
  config: OpenClawConfig;
  runtime: RavenRuntimeEnv;
  path: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

const webhookTargets = new Map<string, WebhookTarget[]>();

export function registerRavenWebhookTarget(target: WebhookTarget): () => void {
  return registerWebhookTarget(webhookTargets, target).unregister;
}

/**
 * Read the full raw body from an IncomingMessage.
 * Returns null if the body exceeds maxBytes.
 */
async function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        resolve(null);
      } else {
        chunks.push(chunk);
      }
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", () => resolve(null));
  });
}

/**
 * Parse a Raven webhook body. Raven uses Frappe's built-in webhook system
 * which sends form-URL-encoded data by default. JSON is also accepted as a
 * fallback for flexibility.
 *
 * Expected fields (configured via Raven Webhook → Webhook Data):
 *   name, channel_id, owner, text, message_type, is_bot_message, bot
 */
function parseWebhookBody(
  rawBody: Buffer,
  contentType: string,
): Record<string, string> | null {
  const ct = contentType.toLowerCase();
  if (ct.includes("application/json")) {
    try {
      const parsed = JSON.parse(rawBody.toString("utf-8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, string>;
      }
      return null;
    } catch {
      return null;
    }
  }

  // Default: application/x-www-form-urlencoded
  const payload: Record<string, string> = {};
  const params = new URLSearchParams(rawBody.toString("utf-8"));
  for (const [key, value] of params.entries()) {
    payload[key] = value;
  }
  return payload;
}

/**
 * Verify Frappe HMAC-SHA256 webhook signature.
 * Frappe sends the signature in the X-Frappe-Webhook-Signature header.
 */
function verifyWebhookSignature(rawBody: Buffer, secret: string, signature: string): boolean {
  try {
    const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
    const expectedBuf = Buffer.from(expected, "utf-8");
    const sigBuf = Buffer.from(signature, "utf-8");
    if (expectedBuf.length !== sigBuf.length) {
      return false;
    }
    return crypto.timingSafeEqual(expectedBuf, sigBuf);
  } catch {
    return false;
  }
}

/**
 * Global HTTP handler registered via api.registerHttpHandler.
 * Returns true if the request matched the /raven webhook path and was handled.
 */
export async function handleRavenWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const resolved = resolveWebhookTargets(req, webhookTargets);
  if (!resolved) {
    return false;
  }
  const { targets } = resolved;

  if (rejectNonPostWebhookRequest(req, res)) {
    return true;
  }

  const rawBody = await readRawBody(req, 512 * 1024);
  if (rawBody === null) {
    res.statusCode = 413;
    res.end("payload too large");
    return true;
  }

  const contentType = String(req.headers["content-type"] ?? "");
  const payload = parseWebhookBody(rawBody, contentType);
  if (!payload) {
    res.statusCode = 400;
    res.end("invalid payload");
    return true;
  }

  const signature = String(req.headers["x-frappe-webhook-signature"] ?? "");

  // Find a matching target — verify HMAC if a secret is configured
  let selected: WebhookTarget | null = null;
  for (const target of targets) {
    if (target.account.webhookSecret) {
      if (signature && verifyWebhookSignature(rawBody, target.account.webhookSecret, signature)) {
        selected = target;
        break;
      }
      // Secret configured but signature missing or invalid — skip
      continue;
    }
    // No secret required — accept this target
    selected = target;
    break;
  }

  if (!selected) {
    res.statusCode = 401;
    res.end("unauthorized");
    return true;
  }

  selected.statusSink?.({ lastInboundAt: Date.now() });

  processRavenWebhookPayload(payload, selected).catch((err) => {
    selected?.runtime.error?.(
      `[${selected?.account.accountId}] Raven webhook processing failed: ${String(err)}`,
    );
  });

  res.statusCode = 200;
  res.end("ok");
  return true;
}

/**
 * Process a parsed Raven webhook payload through the OpenClaw pipeline.
 */
async function processRavenWebhookPayload(
  payload: Record<string, string>,
  target: WebhookTarget,
): Promise<void> {
  const { account, config, runtime } = target;
  const core = getRavenRuntime();

  const channelId = String(payload.channel_id ?? "").trim();
  const messageId = String(payload.name ?? "").trim();
  const owner = String(payload.owner ?? "").trim();
  const rawText = String(payload.text ?? "").trim();
  const messageType = String(payload.message_type ?? "Text");
  const isBotMessage =
    payload.is_bot_message === "1" || payload.is_bot_message === "true";

  if (!channelId || !messageId) {
    return;
  }

  // Skip bot-generated messages to prevent response loops
  if (isBotMessage) {
    return;
  }

  // Only handle text messages in v1
  if (messageType !== "Text") {
    return;
  }

  // Strip HTML tags to get plain text for the agent
  const text = rawText.replace(/<[^>]+>/g, "").trim();
  if (!text) {
    return;
  }

  if (core.logging.shouldLogVerbose()) {
    runtime.log?.(
      `[raven] inbound message=${messageId} channel=${channelId} owner=${owner}`,
    );
  }

  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "raven",
    accountId: account.accountId,
    peer: {
      kind: "group",
      id: channelId,
    },
  });

  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  const fromLabel = owner || `raven:${channelId}`;
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Raven",
    from: fromLabel,
    previousTimestamp,
    envelope: envelopeOptions,
    body: text,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: text,
    RawBody: text,
    CommandBody: text,
    From: `raven:${owner}`,
    To: `raven:${channelId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "group",
    ConversationLabel: fromLabel,
    SenderName: owner || undefined,
    SenderId: owner,
    SenderUsername: owner,
    Provider: "raven",
    Surface: "raven",
    MessageSid: messageId,
    MessageSidFull: messageId,
    OriginatingChannel: "raven",
    OriginatingTo: `raven:${channelId}`,
  });

  void core.channel.session
    .recordSessionMetaFromInbound({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
    })
    .catch((err) => {
      runtime.error?.(`raven: failed updating session meta: ${String(err)}`);
    });

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg: config,
    agentId: route.agentId,
    channel: "raven",
    accountId: route.accountId,
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      ...prefixOptions,
      deliver: async (replyPayload) => {
        await ravenSendMessage({
          creds: {
            baseUrl: account.baseUrl,
            apiKey: account.apiKey,
            apiSecret: account.apiSecret,
          },
          channelId,
          text: replyPayload.text,
          markdown: true,
        });
        target.statusSink?.({ lastOutboundAt: Date.now() });
      },
      onError: (err, info) => {
        runtime.error?.(
          `[${account.accountId}] Raven ${info.kind} reply failed: ${String(err)}`,
        );
      },
    },
    replyOptions: { onModelSelected },
  });
}

/**
 * Register a webhook target for this account and return an unregister function.
 * Called from gateway.startAccount.
 */
export function monitorRavenProvider(options: {
  account: ResolvedRavenAccount;
  config: OpenClawConfig;
  runtime: RavenRuntimeEnv;
  abortSignal: AbortSignal;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): () => void {
  const webhookPath = resolveWebhookPath({
    webhookPath: options.account.webhookPath,
    defaultPath: "/raven",
  });

  if (!webhookPath) {
    options.runtime.error?.(
      `[${options.account.accountId}] Raven: invalid webhook path`,
    );
    return () => {};
  }

  const unregister = registerRavenWebhookTarget({
    account: options.account,
    config: options.config,
    runtime: options.runtime,
    path: webhookPath,
    statusSink: options.statusSink,
  });

  return unregister;
}

export function resolveRavenWebhookPath(params: { account: ResolvedRavenAccount }): string {
  return (
    resolveWebhookPath({
      webhookPath: params.account.webhookPath,
      defaultPath: "/raven",
    }) ?? "/raven"
  );
}
