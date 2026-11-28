import { ModelGatewayFailure } from '../errors.js';
import type { WebEvidenceCollector } from '../web-evidence.js';
import {
  formatWebFetchToolOutput,
  formatWebSearchToolOutput,
  validateWebFetchUrl,
  validateWebSearchQueryPrivacy,
  type WebFetchResponse,
  type WebSearchPort,
  type WebSearchQueryPrivacyContext,
  type WebSearchResponse,
} from '../web-search.js';
import {
  WEB_FETCH_TOOL_NAME,
  formatWebFetchPolicyRefusal,
  formatWebSearchPrivacyRefusal,
  parseWebFetchToolArguments,
  parseWebSearchToolArguments,
  truncateToolOutputToTokenBudget,
} from './shared.js';

export interface WebToolCallInput {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

export interface ExecuteWebToolBatchParams {
  readonly calls: readonly WebToolCallInput[];
  readonly round: number;
  readonly perCallTokenBudget: number;
  readonly webSearch: WebSearchPort | undefined;
  readonly privacyContext: WebSearchQueryPrivacyContext;
  readonly evidenceCollector: WebEvidenceCollector;
  readonly signal: AbortSignal;
}

export interface ExecuteWebToolBatchResult {
  readonly outputs: readonly { readonly id: string; readonly content: string }[];
  readonly executedCallsCount: number;
}

type SettledWebToolReceipt =
  | { readonly kind: 'search_success'; readonly response: WebSearchResponse }
  | { readonly kind: 'fetch_success'; readonly page: WebFetchResponse }
  | { readonly kind: 'failure' };

interface SettledWebToolEntry {
  readonly id: string;
  readonly content: string;
  readonly counted: boolean;
  readonly receipt: SettledWebToolReceipt;
}

/**
 * Executes a round's bounded `web_search` and `web_fetch` tool calls and records
 * tool receipts into `evidenceCollector` in deterministic call order.
 */
export async function executeWebToolCallBatch(
  params: ExecuteWebToolBatchParams,
): Promise<ExecuteWebToolBatchResult> {
  const { calls, round, perCallTokenBudget, webSearch, privacyContext, evidenceCollector, signal } =
    params;

  const settled = await Promise.all(
    calls.map(async (call): Promise<SettledWebToolEntry> => {
      if (call.name === WEB_FETCH_TOOL_NAME) {
        const args = parseWebFetchToolArguments(call.arguments);
        const validation = validateWebFetchUrl(args.url);
        if (!validation.ok) {
          console.log(
            JSON.stringify({
              event: 'v2.web_fetch.policy_refused',
              round,
              reason: validation.reason,
            }),
          );
          return {
            id: call.id,
            content: truncateToolOutputToTokenBudget(
              formatWebFetchPolicyRefusal(validation.reason),
              perCallTokenBudget,
            ),
            counted: false,
            receipt: { kind: 'failure' },
          };
        }

        if (webSearch?.fetchPage === undefined) {
          return {
            id: call.id,
            content: truncateToolOutputToTokenBudget(
              'Web fetch unavailable: page fetching is not enabled in this runtime.',
              perCallTokenBudget,
            ),
            counted: false,
            receipt: { kind: 'failure' },
          };
        }

        try {
          const page = await webSearch.fetchPage({ url: validation.url }, signal);
          return {
            id: call.id,
            content: truncateToolOutputToTokenBudget(
              formatWebFetchToolOutput(page),
              perCallTokenBudget,
            ),
            counted: true,
            receipt: { kind: 'fetch_success', page },
          };
        } catch (error) {
          if (signal.aborted) {
            throw new ModelGatewayFailure('model_timeout');
          }
          const reason = error instanceof Error ? error.message.slice(0, 120) : 'fetch_failed';
          return {
            id: call.id,
            content: truncateToolOutputToTokenBudget(
              `Web fetch unavailable (${reason}). Continue without fetching this page and be honest about what could not be read.`,
              perCallTokenBudget,
            ),
            counted: true,
            receipt: { kind: 'failure' },
          };
        }
      }

      const args = parseWebSearchToolArguments(call.arguments);
      const privacy = validateWebSearchQueryPrivacy(args.query, privacyContext);
      if (!privacy.ok) {
        console.log(
          JSON.stringify({
            event: 'v2.web_search.privacy_refused',
            round,
            reason: privacy.reason,
          }),
        );
        return {
          id: call.id,
          content: truncateToolOutputToTokenBudget(
            formatWebSearchPrivacyRefusal(privacy.reason),
            perCallTokenBudget,
          ),
          counted: false,
          receipt: { kind: 'failure' },
        };
      }

      if (webSearch === undefined) {
        return {
          id: call.id,
          content: truncateToolOutputToTokenBudget(
            'Web search unavailable: search_not_configured',
            perCallTokenBudget,
          ),
          counted: false,
          receipt: { kind: 'failure' },
        };
      }

      try {
        const searchResponse = await webSearch.search(args, signal);
        return {
          id: call.id,
          content: truncateToolOutputToTokenBudget(
            formatWebSearchToolOutput(searchResponse),
            perCallTokenBudget,
          ),
          counted: true,
          receipt: { kind: 'search_success', response: searchResponse },
        };
      } catch (error) {
        if (signal.aborted) {
          throw new ModelGatewayFailure('model_timeout');
        }
        const reason = error instanceof Error ? error.message.slice(0, 120) : 'search_failed';
        return {
          id: call.id,
          content: truncateToolOutputToTokenBudget(
            `Web search unavailable: ${reason}`,
            perCallTokenBudget,
          ),
          counted: true,
          receipt: { kind: 'failure' },
        };
      }
    }),
  );

  let executedCallsCount = 0;
  for (const entry of settled) {
    if (entry.counted) {
      executedCallsCount += 1;
    }
    if (entry.receipt.kind === 'search_success') {
      evidenceCollector.recordSearchSuccess(entry.receipt.response.results);
    } else if (entry.receipt.kind === 'fetch_success') {
      evidenceCollector.recordFetchSuccess(entry.receipt.page);
    } else {
      evidenceCollector.recordToolFailure();
    }
  }

  return {
    outputs: settled.map((entry) => ({ id: entry.id, content: entry.content })),
    executedCallsCount,
  };
}
