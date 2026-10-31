/**
 * Default-deny egress policy engine for @ember/credentials.
 *
 * Implements Section 3 of P0-C1C:
 * - Pure default-deny evaluation function `evaluateEgressRequest`.
 * - Strictly rejects HTTP, IP literals, loopbacks, userinfo, fragments, non-443 ports,
 *   subdomain suffix spoofing, path traversals, unknown query parameters, and mutations.
 * - Redirect re-evaluation: every single hop must be independently authenticated.
 *
 * CRITICAL ARCHITECTURAL NOTICE (RFC v0.2 ADR-005):
 * Application-level URL string parsing CANNOT prove or guarantee protection against:
 * 1. DNS rebinding (host re-resolves to loopback/intranet after policy check);
 * 2. Socket-level 3xx redirect hijacking without client interception;
 * 3. Kernel-level network escape or raw socket creation;
 * 4. Time-of-check-to-time-of-use (TOCTOU) IP address shifts.
 * Real production security requires kernel-level network namespaces (netns, eBPF),
 * hypervisor isolation (Firecracker/gVisor), or a socket-pinning forward proxy.
 * This module provides the pure application-level default-deny authorization foundation.
 */

import type {
  EgressDecision,
  EgressDenialCode,
  EgressPolicy,
  EgressRequest,
  EgressRule,
  HttpMethod,
} from './types.js';

const READ_ONLY_METHODS: ReadonlySet<HttpMethod> = new Set(['GET', 'HEAD']);

const LOCAL_HOSTNAMES: ReadonlySet<string> = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
]);

const LOCAL_SUFFIXES: readonly string[] = ['.localhost', '.local', '.internal', '.lan', '.test'];

/**
 * Checks if a string looks like an IPv4 or IPv6 address literal.
 */
function isIpLiteral(hostname: string): boolean {
  // IPv6 literal: [::1], fe80::1, etc.
  if (hostname.startsWith('[') || hostname.endsWith(']') || hostname.includes(':')) {
    return true;
  }

  // IPv4 standard dotted decimal: 127.0.0.1, 10.0.0.1
  const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (ipv4Regex.test(hostname)) {
    return true;
  }

  // Integer / octal / hex encoded IP (e.g. 2130706433 or 0x7f000001)
  if (/^(0x[0-9a-f]+|\d+)$/i.test(hostname)) {
    return true;
  }

  return false;
}

/**
 * Checks if hostname is a known local, loopback, or internal domain.
 */
function isLocalOrPrivateHost(hostname: string): boolean {
  if (LOCAL_HOSTNAMES.has(hostname)) {
    return true;
  }

  for (const suffix of LOCAL_SUFFIXES) {
    if (hostname.endsWith(suffix)) {
      return true;
    }
  }

  return false;
}

/**
 * Matches a URL pathname against a path pattern.
 * Supports:
 * - Exact match: '/v1/users'
 * - Single-segment wildcard: '/v1/users/*' (matches '/v1/users/123', not '/v1/users/123/profile')
 * - Multi-segment wildcard: '/v1/users/**' (matches '/v1/users/123/profile')
 */
function matchPathPattern(pattern: string, pathname: string): boolean {
  if (pattern === pathname) {
    return true;
  }

  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3);
    return pathname === prefix || pathname.startsWith(prefix + '/');
  }

  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -2);
    if (!pathname.startsWith(prefix + '/')) {
      return false;
    }
    const remainder = pathname.slice(prefix.length + 1);
    return !remainder.includes('/') && remainder.length > 0;
  }

  return false;
}

/**
 * Sanitizes a URL for public reporting and audit logs.
 * Strips any potential query secrets or userinfo.
 */
export function sanitizeUrl(url: URL): string {
  // Returns scheme + host + pathname, query keys only without values
  const queryKeys = Array.from(url.searchParams.keys());
  const searchPart =
    queryKeys.length > 0 ? `?${queryKeys.map((k) => `${k}=[REDACTED]`).join('&')}` : '';
  return `${url.protocol}//${url.host}${url.pathname}${searchPart}`;
}

/**
 * Pure evaluation function for egress requests against policy.
 */
export function evaluateEgressRequest(
  policy: EgressPolicy,
  request: EgressRequest,
): EgressDecision {
  if (!policy || !Array.isArray(policy.rules)) {
    return {
      allowed: false,
      reason: 'Egress policy is missing or malformed',
      denialCode: 'NO_MATCHING_RULE',
    };
  }

  if (!request || typeof request.url !== 'string' || request.url.trim() === '') {
    return {
      allowed: false,
      reason: 'Request URL must be a non-empty string',
      denialCode: 'INVALID_URL',
    };
  }

  const rawUrl = request.url.trim();

  // 1. Userinfo check in raw string
  if (rawUrl.includes('@')) {
    return {
      allowed: false,
      reason: 'Userinfo credentials in URL are strictly forbidden',
      denialCode: 'USERINFO_FORBIDDEN',
    };
  }

  // 2. Fragment check in raw string
  if (rawUrl.includes('#')) {
    return {
      allowed: false,
      reason: 'URL fragment identifiers are strictly forbidden',
      denialCode: 'FRAGMENT_FORBIDDEN',
    };
  }

  // 3. Path traversal and suspicious encoding checks in raw string
  const lowerRaw = rawUrl.toLowerCase();
  if (
    lowerRaw.includes('%2e%2e') ||
    lowerRaw.includes('%2e') ||
    lowerRaw.includes('/../') ||
    lowerRaw.endsWith('/..') ||
    lowerRaw.includes('/./') ||
    lowerRaw.endsWith('/.') ||
    lowerRaw.includes('\\')
  ) {
    return {
      allowed: false,
      reason: 'Path traversal or suspicious dot-encoding is forbidden',
      denialCode: 'PATH_NOT_ALLOWED',
    };
  }

  // 4. URL parsing
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return {
      allowed: false,
      reason: 'Failed to parse URL syntax',
      denialCode: 'INVALID_URL',
    };
  }

  // 5. Scheme check
  if (parsedUrl.protocol !== 'https:') {
    return {
      allowed: false,
      reason: 'Protocol scheme is forbidden; only https is permitted',
      denialCode: 'UNSUPPORTED_SCHEME',
    };
  }

  // 6. Userinfo check on parsed object
  if (parsedUrl.username !== '' || parsedUrl.password !== '') {
    return {
      allowed: false,
      reason: 'Userinfo credentials in URL are forbidden',
      denialCode: 'USERINFO_FORBIDDEN',
    };
  }

  // 7. Port check: strictly default 443
  if (parsedUrl.port !== '' && parsedUrl.port !== '443') {
    return {
      allowed: false,
      reason: 'Non-standard port is forbidden; only port 443 is permitted',
      denialCode: 'INVALID_PORT',
    };
  }

  const hostname = parsedUrl.hostname.toLowerCase();

  // 8. IP literal check
  if (isIpLiteral(hostname)) {
    return {
      allowed: false,
      reason: 'IP address literals are forbidden',
      denialCode: 'IP_LITERAL_FORBIDDEN',
    };
  }

  // 9. Localhost / private hostname check
  if (isLocalOrPrivateHost(hostname)) {
    return {
      allowed: false,
      reason: 'Localhost and private network destinations are forbidden',
      denialCode: 'PRIVATE_OR_LOCAL_HOST',
    };
  }

  // 10. Mutation / side-effect rejection
  if (!READ_ONLY_METHODS.has(request.method)) {
    return {
      allowed: false,
      reason: 'Mutating HTTP methods are blocked; only read-only methods (GET, HEAD) are allowed',
      denialCode: 'WRITE_OPERATION_BLOCKED',
    };
  }

  if (request.operationKind && request.operationKind !== 'read') {
    return {
      allowed: false,
      reason: 'Operation kind must be read-only',
      denialCode: 'WRITE_OPERATION_BLOCKED',
    };
  }

  // 11. Operation identifier presence validation
  if (
    !request.operation ||
    typeof request.operation !== 'string' ||
    request.operation.trim() === ''
  ) {
    return {
      allowed: false,
      reason: 'Operation identifier must be a non-empty string',
      denialCode: 'OPERATION_NOT_ALLOWED',
    };
  }

  const normalizedOperation = request.operation.trim();

  // 12. Match against configured rules
  const candidateRules: readonly EgressRule[] = policy.rules.filter(
    (rule: EgressRule): boolean =>
      rule.provider === request.provider && rule.operationKind === 'read',
  );

  if (candidateRules.length === 0) {
    return {
      allowed: false,
      reason: 'No egress rule configured for provider with read operations',
      denialCode: 'NO_MATCHING_RULE',
    };
  }

  const requestOrigin = parsedUrl.origin.toLowerCase();
  const requestPath = parsedUrl.pathname;
  const queryParamKeys: string[] = Array.from(parsedUrl.searchParams.keys());

  let bestDenialReason: string | undefined;
  let bestDenialCode: EgressDenialCode = 'NO_MATCHING_RULE';

  for (const rule of candidateRules) {
    // 12a. Operation ID binding against rule allowlist
    if (!rule.allowedOperations || !rule.allowedOperations.includes(normalizedOperation)) {
      bestDenialReason = 'Operation is not permitted by egress rule';
      bestDenialCode = 'OPERATION_NOT_ALLOWED';
      continue;
    }

    // 12b. Exact Origin match (prevents subdomain spoofing like allowed.example.evil.com)
    const originMatch = rule.allowedOrigins.some(
      (origin: string): boolean => origin.toLowerCase() === requestOrigin,
    );
    if (!originMatch) {
      bestDenialReason = 'Target origin is not permitted by egress rule';
      bestDenialCode = 'ORIGIN_NOT_ALLOWED';
      continue;
    }

    // 12c. Method match
    if (!rule.allowedMethods.includes(request.method)) {
      bestDenialReason = 'HTTP method is not permitted by egress rule';
      bestDenialCode = 'METHOD_NOT_ALLOWED';
      continue;
    }

    // 12d. Path pattern match
    const pathMatch = rule.allowedPathPatterns.some((pattern: string): boolean =>
      matchPathPattern(pattern, requestPath),
    );
    if (!pathMatch) {
      bestDenialReason = 'Request path does not match rule allowlist';
      bestDenialCode = 'PATH_NOT_ALLOWED';
      continue;
    }

    // 12e. Query parameter allowlist match
    if (queryParamKeys.length > 0) {
      const allowedQuerySet: Set<string> = new Set<string>(rule.allowedQueryParams ?? []);
      const unallowedQueryKeys = queryParamKeys.filter((k: string) => !allowedQuerySet.has(k));
      if (unallowedQueryKeys.length > 0) {
        bestDenialReason = 'Query parameters contain disallowed keys';
        bestDenialCode = 'QUERY_PARAM_NOT_ALLOWED';
        continue;
      }
    }

    // 12f. Scope validation: check requestedScopes against rule.requiredScopes
    if (request.requestedScopes !== undefined) {
      if (request.requestedScopes.length === 0) {
        if (rule.requiredScopes.length > 0) {
          bestDenialReason = 'Empty requested scopes cannot satisfy required rule scopes';
          bestDenialCode = 'SCOPE_MISMATCH';
          continue;
        }
      } else {
        const ruleScopeSet = new Set<string>(rule.requiredScopes);
        const unpermitted = request.requestedScopes.filter((s: string) => !ruleScopeSet.has(s));
        if (unpermitted.length > 0) {
          bestDenialReason = 'Requested scopes exceed permitted rule scopes';
          bestDenialCode = 'SCOPE_MISMATCH';
          continue;
        }

        const reqScopeSet = new Set<string>(request.requestedScopes);
        const missingRequired = rule.requiredScopes.filter((s: string) => !reqScopeSet.has(s));
        if (missingRequired.length > 0) {
          bestDenialReason = 'Requested scopes do not satisfy required rule scopes';
          bestDenialCode = 'SCOPE_MISMATCH';
          continue;
        }
      }
    }

    // All conditions satisfied for this rule!
    return {
      allowed: true,
      matchedRuleId: rule.ruleId,
      sanitizedUrl: sanitizeUrl(parsedUrl),
      method: request.method,
      provider: request.provider,
      operation: normalizedOperation,
    };
  }

  return {
    allowed: false,
    reason: bestDenialReason ?? 'Request does not match any egress rule',
    denialCode: bestDenialCode,
  };
}

/**
 * Re-evaluates a redirect candidate target.
 * Every hop must be independently authorized against the policy; implicit forwarding is forbidden.
 */
export function evaluateRedirectCandidate(
  policy: EgressPolicy,
  originalRequest: EgressRequest,
  redirectUrl: string,
): EgressDecision {
  const originalDecision = evaluateEgressRequest(policy, originalRequest);
  if (!originalDecision.allowed) {
    return {
      allowed: false,
      reason: 'Original request was not permitted by egress policy',
      denialCode: originalDecision.denialCode,
    };
  }

  const matchedRule = policy.rules.find((r) => r.ruleId === originalDecision.matchedRuleId);
  if (!matchedRule || matchedRule.allowRedirects !== true) {
    return {
      allowed: false,
      reason: 'Redirects are not permitted for this egress rule',
      denialCode: 'REDIRECT_TARGET_DENIED',
    };
  }

  const hopRequest: EgressRequest = {
    ...originalRequest,
    url: redirectUrl,
  };

  const hopDecision = evaluateEgressRequest(policy, hopRequest);
  if (!hopDecision.allowed) {
    return {
      allowed: false,
      reason: 'Redirect target is not permitted by egress policy',
      denialCode: 'REDIRECT_TARGET_DENIED',
    };
  }

  return hopDecision;
}
