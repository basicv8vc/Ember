import type { ProactiveScheduleSnapshot, ProactiveScheduleTaskPayload } from '@ember/runtime-v2';

export const MAX_BRIEF_RECENT_MESSAGES = 8;
export const MAX_BRIEF_ACTIVE_SCHEDULES = 6;
export const MAX_BRIEF_ITEM_CHARS = 240;
export const MAX_BRIEF_PROMPT_CHARS = 3_600;
export const BRIEF_MESSAGE_PAGE_SIZE = 50;
export const MAX_BRIEF_MESSAGE_PAGES = 20;

export interface BriefContextMessage {
  readonly kind: 'user' | 'ember';
  readonly text: string;
}

export interface BriefMessagePage {
  readonly messages: readonly (
    { readonly kind: string; readonly text?: string } | BriefContextMessage
  )[];
  readonly has_more: boolean;
  readonly next_after: number | null;
}

/**
 * Walks ascending conversation pages (`WHERE sequence > after ORDER BY sequence ASC`)
 * in a bounded loop and retains only the latest `maxMessages` user/ember messages.
 */
export async function loadRecentBriefMessages(
  readPage: (after: number, limit: number) => Promise<BriefMessagePage>,
  maxMessages = MAX_BRIEF_RECENT_MESSAGES,
): Promise<readonly BriefContextMessage[]> {
  let after = 0;
  let tail: BriefContextMessage[] = [];
  for (let pageIndex = 0; pageIndex < MAX_BRIEF_MESSAGE_PAGES; pageIndex += 1) {
    const page = await readPage(after, BRIEF_MESSAGE_PAGE_SIZE);
    for (const msg of page.messages) {
      if ((msg.kind === 'user' || msg.kind === 'ember') && typeof msg.text === 'string') {
        tail.push({ kind: msg.kind, text: msg.text });
      }
    }
    if (tail.length > maxMessages) {
      tail = tail.slice(-maxMessages);
    }
    if (!page.has_more || page.next_after === null || page.next_after <= after) {
      break;
    }
    after = page.next_after;
  }
  return tail;
}

export interface ProactiveBriefContext {
  readonly recentMessages?: readonly BriefContextMessage[];
  readonly activeSchedules?: readonly ProactiveScheduleSnapshot[];
}

function truncateLine(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

/**
 * Builds a bounded prompt for `model_brief` proactive schedule execution.
 * Combines the schedule instruction with optional active schedules and recent conversation turns
 * while strictly clamping total output length so model token budgets remain predictable.
 */
export function buildProactiveBriefPrompt(
  proactive: ProactiveScheduleTaskPayload,
  context?: ProactiveBriefContext,
): string {
  const sections: string[] = [
    `[Proactive ${proactive.kind} | ${proactive.title} | ${proactive.timezone}]\n${proactive.prompt.trim()}`,
  ];

  const activeOthers = (context?.activeSchedules ?? [])
    .filter((s) => s.status === 'active' && s.scheduleId !== proactive.scheduleId)
    .slice(0, MAX_BRIEF_ACTIVE_SCHEDULES);
  if (activeOthers.length > 0) {
    const lines = activeOthers.map((s) => {
      const next = s.nextFireAt === null ? 'unscheduled' : s.nextFireAt;
      return `- [${s.kind}] ${truncateLine(s.title, MAX_BRIEF_ITEM_CHARS)} (next: ${next})`;
    });
    sections.push(`Active schedules:\n${lines.join('\n')}`);
  }

  const recent = (context?.recentMessages ?? [])
    .map((m) => ({ kind: m.kind, text: truncateLine(m.text, MAX_BRIEF_ITEM_CHARS) }))
    .filter((m) => m.text.length > 0)
    .slice(-MAX_BRIEF_RECENT_MESSAGES);
  if (recent.length > 0) {
    const lines = recent.map((m) => `- ${m.kind === 'user' ? 'User' : 'Ember'}: ${m.text}`);
    sections.push(`Recent conversation:\n${lines.join('\n')}`);
  }

  const combined = sections.join('\n\n');
  if (combined.length <= MAX_BRIEF_PROMPT_CHARS) return combined;
  return `${combined.slice(0, MAX_BRIEF_PROMPT_CHARS - 1).trimEnd()}…`;
}
