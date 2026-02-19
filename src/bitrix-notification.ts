import type { tool } from 'langchain';
import type { Config } from './config.js';
import type { SettingsRepository } from './settings-repository.js';

// ── Types ────────────────────────────────────────────────────────────────────

/** DB-persisted settings (dashboard Settings tab). */
export interface BitrixDashboardSettings {
  notifyOnPr: boolean;
  notifyOnIssue: boolean;
  dialogId: string;
}

/** Resolved config: env vars (connection) + DB settings (toggles + dialog). */
interface ResolvedBitrix {
  baseUrl: string;
  userId: string;
  webhookId: string;
  dialogId: string;
  notifyOnPr: boolean;
  notifyOnIssue: boolean;
}

const SETTINGS_KEY = 'bitrix';

// ── Resolve settings ─────────────────────────────────────────────────────────

async function resolve(config: Config, settingsRepo?: SettingsRepository): Promise<ResolvedBitrix | undefined> {
  const env = config.bitrix as { baseUrl: string; userId: string; webhookId: string } | undefined;
  if (!env?.webhookId) return undefined;

  if (!settingsRepo) return undefined;
  const db = await Promise.resolve(settingsRepo.get<BitrixDashboardSettings>(SETTINGS_KEY));
  if (!db?.dialogId) return undefined;

  return {
    baseUrl: env.baseUrl,
    userId: env.userId,
    webhookId: env.webhookId,
    dialogId: db.dialogId,
    notifyOnPr: db.notifyOnPr ?? true,
    notifyOnIssue: db.notifyOnIssue ?? true,
  };
}

// ── Bitrix BB-code message builders ──────────────────────────────────────────

function buildPrCreatedMessage(
  owner: string,
  repo: string,
  prNumber: number,
  prUrl: string,
  title: string,
  head: string,
  base: string,
  summary: string,
): string {
  const lines = [
    `[B]New Pull Request[/B]`,
    ``,
    `[URL=${prUrl}]${owner}/${repo}#${prNumber}[/URL]`,
    `[B]${title}[/B]`,
    ``,
    `Branch: [I]${head}[/I] -> [I]${base}[/I]`,
  ];
  if (summary) {
    // Strip markdown links/images, keep text readable for Bitrix
    const clean = summary
      .replace(/!\[.*?\]\(.*?\)/g, '')        // remove images
      .replace(/\[([^\]]+)\]\(.*?\)/g, '$1')  // [text](url) → text
      .replace(/#{1,6}\s*/g, '')              // remove heading markers
      .replace(/\*\*([^*]+)\*\*/g, '[B]$1[/B]')  // **bold** → [B]bold[/B]
      .replace(/\*([^*]+)\*/g, '[I]$1[/I]')      // *italic* → [I]italic[/I]
      .replace(/\n/g, '[BR]')
      .slice(0, 1500);
    lines.push(``, clean);
  }
  return lines.join('[BR]');
}

function buildIssueCreatedMessage(
  owner: string,
  repo: string,
  issueNumber: number,
  issueUrl: string,
  title: string,
  parentIssue?: number,
): string {
  const lines = [
    `[B]New Issue Created[/B]`,
    ``,
    `[URL=${issueUrl}]${owner}/${repo}#${issueNumber}[/URL]`,
    `[B]${title}[/B]`,
  ];
  if (parentIssue) {
    lines.push(``, `Parent issue: [I]#${parentIssue}[/I]`);
  }
  return lines.join('[BR]');
}

// ── Send to Bitrix ───────────────────────────────────────────────────────────

async function sendMessage(r: ResolvedBitrix, message: string): Promise<void> {
  const url = `${r.baseUrl}/rest/${r.userId}/${r.webhookId}/im.message.add.json`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        DIALOG_ID: r.dialogId,
        MESSAGE: message,
      }),
    });

    if (!res.ok) {
      console.warn(`[bitrix] Notification failed (${res.status}): ${await res.text().catch(() => '')}`);
    }
  } catch (err) {
    console.warn(`[bitrix] Notification error:`, err instanceof Error ? err.message : err);
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function notifyPrCreated(
  config: Config,
  settingsRepo: SettingsRepository | undefined,
  owner: string,
  repo: string,
  prNumber: number,
  prUrl: string,
  title: string,
  head: string,
  base: string,
  summary: string,
): Promise<void> {
  const r = await resolve(config, settingsRepo);
  if (!r?.notifyOnPr) return;
  await sendMessage(r, buildPrCreatedMessage(owner, repo, prNumber, prUrl, title, head, base, summary));
}

export async function notifyIssueCreated(
  config: Config,
  settingsRepo: SettingsRepository | undefined,
  owner: string,
  repo: string,
  issueNumber: number,
  issueUrl: string,
  title: string,
  parentIssue?: number,
): Promise<void> {
  const r = await resolve(config, settingsRepo);
  if (!r?.notifyOnIssue) return;
  await sendMessage(r, buildIssueCreatedMessage(owner, repo, issueNumber, issueUrl, title, parentIssue));
}

export async function sendTestNotification(
  config: Config,
  dialogId: string,
): Promise<{ ok: boolean; error?: string }> {
  const env = config.bitrix as { baseUrl: string; userId: string; webhookId: string } | undefined;
  if (!env?.webhookId) return { ok: false, error: 'BITRIX_WEBHOOK_ID not set in .env' };

  const url = `${env.baseUrl}/rest/${env.userId}/${env.webhookId}/im.message.add.json`;
  const message = `[B]Test Notification[/B][BR][BR]Deep Agents Bitrix integration is working.`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ DIALOG_ID: dialogId, MESSAGE: message }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `Bitrix returned ${res.status}: ${text}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Tool wrappers ────────────────────────────────────────────────────────────

/**
 * Wrap a create_pull_request tool to fire a Bitrix notification on success.
 * Uses the same monkey-patch pattern as wrapWithOutputCap.
 */
export function wrapPrToolWithNotification<T extends ReturnType<typeof tool>>(
  prTool: T,
  config: Config,
  settingsRepo: SettingsRepository | undefined,
  owner: string,
  repo: string,
): T {
  if (!settingsRepo || !config.bitrix) return prTool;
  const originalInvoke = prTool.invoke.bind(prTool);
  prTool.invoke = async (input: any, options?: any) => {
    const result = await originalInvoke(input, options);
    if (typeof result === 'string') {
      try {
        const parsed = JSON.parse(result);
        if (parsed.number && parsed.html_url && !parsed.skipped) {
          notifyPrCreated(
            config, settingsRepo, owner, repo,
            parsed.number, parsed.html_url,
            input?.title || '', input?.head || '', input?.base || 'main',
            input?.body || '',
          ).catch(() => {});
        }
      } catch { /* not JSON or parse error — skip */ }
    }
    return result;
  };
  return prTool;
}

/**
 * Wrap a create_sub_issue tool to fire a Bitrix notification on success.
 */
export function wrapIssueToolWithNotification<T extends ReturnType<typeof tool>>(
  issueTool: T,
  config: Config,
  settingsRepo: SettingsRepository | undefined,
  owner: string,
  repo: string,
): T {
  if (!settingsRepo || !config.bitrix) return issueTool;
  const originalInvoke = issueTool.invoke.bind(issueTool);
  issueTool.invoke = async (input: any, options?: any) => {
    const result = await originalInvoke(input, options);
    if (typeof result === 'string') {
      try {
        const parsed = JSON.parse(result);
        if (parsed.number && parsed.html_url) {
          notifyIssueCreated(
            config, settingsRepo, owner, repo,
            parsed.number, parsed.html_url,
            parsed.title || input?.title || '',
            input?.parent_issue_number,
          ).catch(() => {});
        }
      } catch { /* not JSON or parse error — skip */ }
    }
    return result;
  };
  return issueTool;
}
