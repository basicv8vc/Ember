import type {
  PersonalMemoryContextItem,
  ProactiveScheduleSnapshot,
  ProactiveScheduleTaskPayload,
} from '@ember/runtime-v2';

export const MAX_BRIEF_RECENT_MESSAGES = 8;
export const MAX_BRIEF_ACTIVE_SCHEDULES = 6;
export const MAX_BRIEF_PERSONAL_MEMORIES = 6;
export const MAX_BRIEF_ITEM_CHARS = 240;
export const MAX_BRIEF_PROMPT_CHARS = 3_600;
export const BRIEF_MESSAGE_PAGE_SIZE = 50;
export const MAX_BRIEF_TAIL_PROBE_STEPS = 30;
export const MAX_BRIEF_TAIL_WALK_PAGES = 4;

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

function appendUserOrEmber(
  tail: BriefContextMessage[],
  messages: BriefMessagePage['messages'],
  maxMessages: number,
): BriefContextMessage[] {
  for (const msg of messages) {
    if ((msg.kind === 'user' || msg.kind === 'ember') && typeof msg.text === 'string') {
      tail.push({ kind: msg.kind, text: msg.text });
    }
  }
  return tail.length > maxMessages ? tail.slice(-maxMessages) : tail;
}

/**
 * Retrieves the latest `maxMessages` user/ember messages using existing ascending
 * `sequence > after` pagination:
 * - Fast path (<= 50 messages): single page read.
 * - Long conversations (including > 1,000 messages): O(log N) exponential + binary
 *   sequence probe to locate the true tail, then bounded tail-window read.
 * - Fail-closed: if the true tail (`has_more === false`) cannot be reached within
 *   the bounded budget, returns `[]` so stale older history is never injected as
 *   recent context.
 */
export async function loadRecentBriefMessages(
  readPage: (after: number, limit: number) => Promise<BriefMessagePage>,
  maxMessages = MAX_BRIEF_RECENT_MESSAGES,
): Promise<readonly BriefContextMessage[]> {
  const first = await readPage(0, BRIEF_MESSAGE_PAGE_SIZE);
  if (!first.has_more) {
    return appendUserOrEmber([], first.messages, maxMessages);
  }
  if (first.next_after === null || first.next_after <= 0) {
    return [];
  }

  // Locate an upper bound `high` >= trueLastSeq via exponential sequence probing.
  let low = first.next_after;
  let high: number | null = null;
  let step = BRIEF_MESSAGE_PAGE_SIZE;

  for (let i = 0; i < MAX_BRIEF_TAIL_PROBE_STEPS; i += 1) {
    const probe = low + step;
    const probePage = await readPage(probe, 1);
    if (probePage.messages.length === 0) {
      high = probe;
      break;
    }
    low = Math.max(probe + 1, probePage.next_after ?? probe + 1);
    step *= 2;
  }

  if (high === null) {
    return [];
  }

  // Narrow [low, high] via binary search until within one page of the true tail.
  while (high - low > BRIEF_MESSAGE_PAGE_SIZE) {
    const mid = Math.floor((low + high) / 2);
    const probePage = await readPage(mid, 1);
    if (probePage.messages.length > 0) {
      low = Math.max(mid + 1, probePage.next_after ?? mid + 1);
    } else {
      high = mid;
    }
  }

  // Walk the tail window until `has_more === false`.
  let after = Math.max(0, low - BRIEF_MESSAGE_PAGE_SIZE);
  let tail: BriefContextMessage[] = [];
  for (let pageIndex = 0; pageIndex < MAX_BRIEF_TAIL_WALK_PAGES; pageIndex += 1) {
    const page = await readPage(after, BRIEF_MESSAGE_PAGE_SIZE);
    tail = appendUserOrEmber(tail, page.messages, maxMessages);
    if (!page.has_more) {
      return tail;
    }
    if (page.next_after === null || page.next_after <= after) {
      return [];
    }
    after = page.next_after;
  }

  // Could not confirm the true tail within bounded pages -> fail closed rather than returning stale context.
  return [];
}

export interface ProactiveBriefContext {
  readonly recentMessages?: readonly BriefContextMessage[];
  readonly activeSchedules?: readonly ProactiveScheduleSnapshot[];
  readonly personalMemories?: readonly PersonalMemoryContextItem[];
}

function truncateLine(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

/**
 * Builds a bounded prompt for `model_brief` proactive schedule execution.
 * Combines the schedule instruction with optional personal memories, active schedules,
 * and recent conversation turns while strictly clamping total output length so model
 * token budgets remain predictable.
 */
export function buildProactiveBriefPrompt(
  proactive: ProactiveScheduleTaskPayload,
  context?: ProactiveBriefContext,
): string {
  const sections: string[] = [
    `[Proactive ${proactive.kind} | ${proactive.title} | ${proactive.timezone}]\n${proactive.prompt.trim()}`,
  ];

  const memories = (context?.personalMemories ?? [])
    .map((m) => ({
      kind: m.kind,
      key: m.key,
      content: truncateLine(m.content, MAX_BRIEF_ITEM_CHARS),
    }))
    .filter((m) => m.content.length > 0)
    .slice(0, MAX_BRIEF_PERSONAL_MEMORIES);
  if (memories.length > 0) {
    const lines = memories.map((m) =>
      m.key !== undefined ? `- [${m.kind}:${m.key}] ${m.content}` : `- [${m.kind}] ${m.content}`,
    );
    sections.push(`User preferences & facts:\n${lines.join('\n')}`);
  }

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
