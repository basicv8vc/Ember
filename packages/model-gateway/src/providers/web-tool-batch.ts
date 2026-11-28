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
  | { readonly kind: 'failure'; readonly content: string };

interface SettledWebToolEntry {
  readonly id: string;
  readonly counted: boolean;
  readonly receipt: SettledWebToolReceipt;
}

/**
 * Executes a round's bounded `web_search` and `web_fetch` tool calls, records
 * tool receipts into `evidenceCollector` in deterministic call order, and formats
 * search tool outputs with authoritative turn-wide source indices.
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
            counted: false,
            receipt: {
              kind: 'failure',
              content: truncateToolOutputToTokenBudget(
                formatWebFetchPolicyRefusal(validation.reason),
                perCallTokenBudget,
              ),
            },
          };
        }

        if (webSearch?.fetchPage === undefined) {
          return {
            id: call.id,
            counted: false,
            receipt: {
              kind: 'failure',
              content: truncateToolOutputToTokenBudget(
                'Web fetch unavailable: page fetching is not enabled in this runtime.',
                perCallTokenBudget,
              ),
            },
          };
        }

        try {
          const page = await webSearch.fetchPage({ url: validation.url }, signal);
          return {
            id: call.id,
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
            counted: true,
            receipt: {
              kind: 'failure',
              content: truncateToolOutputToTokenBudget(
                `Web fetch unavailable (${reason}). Continue without fetching this page and be honest about what could not be read.`,
                perCallTokenBudget,
              ),
            },
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
          counted: false,
          receipt: {
            kind: 'failure',
            content: truncateToolOutputToTokenBudget(
              formatWebSearchPrivacyRefusal(privacy.reason),
              perCallTokenBudget,
            ),
          },
        };
      }

      if (webSearch === undefined) {
        return {
          id: call.id,
          counted: false,
          receipt: {
            kind: 'failure',
            content: truncateToolOutputToTokenBudget(
              'Web search unavailable: search_not_configured',
              perCallTokenBudget,
            ),
          },
        };
      }

      try {
        const searchResponse = await webSearch.search(args, signal);
        return {
          id: call.id,
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
          counted: true,
          receipt: {
            kind: 'failure',
            content: truncateToolOutputToTokenBudget(
              `Web search unavailable: ${reason}`,
              perCallTokenBudget,
            ),
          },
        };
      }
    }),
  );

  let executedCallsCount = 0;
  const outputs: { readonly id: string; readonly content: string }[] = [];

  for (const entry of settled) {
    if (entry.counted) {
      executedCallsCount += 1;
    }
    if (entry.receipt.kind === 'search_success') {
      evidenceCollector.recordSearchSuccess(entry.receipt.response.results);
      outputs.push({
        id: entry.id,
        content: truncateToolOutputToTokenBudget(
          formatWebSearchToolOutput(entry.receipt.response, undefined, {
            resolveIndex: (url) => evidenceCollector.getSourceIndexForUrl(url),
          }),
          perCallTokenBudget,
        ),
      });
    } else if (entry.receipt.kind === 'fetch_success') {
      evidenceCollector.recordFetchSuccess(entry.receipt.page);
      outputs.push({
        id: entry.id,
        content: truncateToolOutputToTokenBudget(
          formatWebFetchToolOutput(entry.receipt.page),
          perCallTokenBudget,
        ),
      });
    } else {
      evidenceCollector.recordToolFailure();
      outputs.push({
        id: entry.id,
        content: entry.receipt.content,
      });
    }
  }

  return {
    outputs,
    executedCallsCount,
  };
}
