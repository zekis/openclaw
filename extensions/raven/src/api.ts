export type RavenApiCredentials = {
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
};

export type RavenSendMessageResult = {
  messageId: string;
  chatId: string;
};

export type RavenProbeResult = {
  ok: boolean;
  message?: string;
  error?: string;
};

function buildAuthHeader(creds: RavenApiCredentials): string {
  return `token ${creds.apiKey}:${creds.apiSecret}`;
}

function normalizeBaseUrl(raw: string): string {
  return raw.replace(/\/$/, "");
}

/**
 * Convert markdown-style text to simple HTML for Raven.
 * Raven stores messages as HTML (ProseMirror format).
 */
export function markdownToRavenHtml(text: string): string {
  // Escape HTML special characters in non-tag content
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Apply basic inline formatting
  const formatted = escaped
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/_(.+?)_/g, "<em>$1</em>")
    .replace(/`(.+?)`/g, "<code>$1</code>");

  // Split into paragraphs on double newlines, single newlines become <br>
  const paragraphs = formatted.split(/\n\n+/);
  return paragraphs
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/**
 * Send a message to a Raven channel via the Frappe REST API.
 * Authentication: Frappe API token (apiKey:apiSecret).
 */
export async function ravenSendMessage(params: {
  creds: RavenApiCredentials;
  channelId: string;
  text: string;
  markdown?: boolean;
}): Promise<RavenSendMessageResult> {
  const { creds, channelId, markdown = true } = params;
  const base = normalizeBaseUrl(creds.baseUrl);

  const htmlText = markdown ? markdownToRavenHtml(params.text) : params.text;

  const res = await fetch(`${base}/api/resource/Raven%20Message`, {
    method: "POST",
    headers: {
      Authorization: buildAuthHeader(creds),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channel_id: channelId,
      text: htmlText,
      message_type: "Text",
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Raven API ${res.status}: ${body || res.statusText}`);
  }

  const data = (await res.json()) as { data?: { name?: string } };
  return {
    channel: "raven",
    messageId: data.data?.name ?? "",
    chatId: channelId,
  } as RavenSendMessageResult & { channel: string };
}

/**
 * Health-check the Raven/Frappe server.
 * Uses the Frappe ping endpoint which requires no auth.
 */
export async function ravenProbe(params: {
  creds: RavenApiCredentials;
  timeoutMs?: number;
}): Promise<RavenProbeResult> {
  const { creds, timeoutMs = 5000 } = params;
  const base = normalizeBaseUrl(creds.baseUrl);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${base}/api/method/frappe.utils.ping`, {
      method: "GET",
      headers: { Authorization: buildAuthHeader(creds) },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    const data = (await res.json()) as { message?: string };
    return { ok: true, message: data.message ?? "pong" };
  } catch (err) {
    if ((err as Error)?.name === "AbortError") {
      return { ok: false, error: `timeout after ${timeoutMs}ms` };
    }
    return { ok: false, error: String(err) };
  }
}
