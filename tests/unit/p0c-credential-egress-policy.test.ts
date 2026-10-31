import { describe, expect, it } from 'vitest';
import {
  EMPTY_EGRESS_POLICY,
  SYNTHETIC_EGRESS_POLICY,
  SYNTHETIC_ORIGIN,
  SYNTHETIC_PROVIDER,
  SYNTHETIC_SCOPE_READ,
  evaluateEgressRequest,
  evaluateRedirectCandidate,
  type EgressPolicy,
  type EgressRequest,
  type EgressRule,
} from '@ember/credentials';

describe('evaluateEgressRequest & Egress Policy', () => {
  describe('default-deny behavior', () => {
    it('denies any request when policy rules are empty', () => {
      const request: EgressRequest = {
        url: 'https://api.synthetic-connector.example/v1/status',
        method: 'GET',
        provider: 'synthetic-connector',
        operation: 'get_status',
        operationKind: 'read',
      };

      const decision = evaluateEgressRequest(EMPTY_EGRESS_POLICY, request);
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.denialCode).toBe('NO_MATCHING_RULE');
      }
    });

    it('denies requests to unknown connector providers', () => {
      const request: EgressRequest = {
        url: 'https://api.synthetic-connector.example/v1/status',
        method: 'GET',
        provider: 'unknown-service-provider',
        operation: 'get_status',
        operationKind: 'read',
      };

      const decision = evaluateEgressRequest(SYNTHETIC_EGRESS_POLICY, request);
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.denialCode).toBe('NO_MATCHING_RULE');
      }
    });
  });

  describe('explicitly configured synthetic read-only fixture', () => {
    it('allows a valid read-only request conforming to the policy', () => {
      const request: EgressRequest = {
        url: `${SYNTHETIC_ORIGIN}/v1/status`,
        method: 'GET',
        provider: SYNTHETIC_PROVIDER,
        operation: 'check_status',
        operationKind: 'read',
        requestedScopes: [SYNTHETIC_SCOPE_READ],
      };

      const decision = evaluateEgressRequest(SYNTHETIC_EGRESS_POLICY, request);
      expect(decision.allowed).toBe(true);
      if (decision.allowed) {
        expect(decision.matchedRuleId).toBe('rule-synthetic-read');
        expect(decision.sanitizedUrl).toBe(`${SYNTHETIC_ORIGIN}/v1/status`);
        expect(decision.method).toBe('GET');
      }
    });

    it('allows HEAD requests when included in allowedMethods', () => {
      const request: EgressRequest = {
        url: `${SYNTHETIC_ORIGIN}/v1/status`,
        method: 'HEAD',
        provider: SYNTHETIC_PROVIDER,
        operation: 'head_status',
        operationKind: 'read',
      };

      const decision = evaluateEgressRequest(SYNTHETIC_EGRESS_POLICY, request);
      expect(decision.allowed).toBe(true);
    });

    it('allows path matching with wildcards (e.g. /v1/items/*)', () => {
      const request: EgressRequest = {
        url: `${SYNTHETIC_ORIGIN}/v1/items/item-12345`,
        method: 'GET',
        provider: SYNTHETIC_PROVIDER,
        operation: 'get_item',
        operationKind: 'read',
      };

      const decision = evaluateEgressRequest(SYNTHETIC_EGRESS_POLICY, request);
      expect(decision.allowed).toBe(true);
    });

    it('allows whitelisted query parameters (limit, cursor)', () => {
      const request: EgressRequest = {
        url: `${SYNTHETIC_ORIGIN}/v1/items?limit=10&cursor=abc`,
        method: 'GET',
        provider: SYNTHETIC_PROVIDER,
        operation: 'list_items',
        operationKind: 'read',
      };

      const decision = evaluateEgressRequest(SYNTHETIC_EGRESS_POLICY, request);
      expect(decision.allowed).toBe(true);
      if (decision.allowed) {
        // Query param values are redacted in the output
        expect(decision.sanitizedUrl).toContain('limit=[REDACTED]');
        expect(decision.sanitizedUrl).toContain('cursor=[REDACTED]');
      }
    });

    it('rejects unexpected query parameters', () => {
      const request: EgressRequest = {
        url: `${SYNTHETIC_ORIGIN}/v1/items?limit=10&malicious_filter=inject`,
        method: 'GET',
        provider: SYNTHETIC_PROVIDER,
        operation: 'list_items',
        operationKind: 'read',
      };

      const decision = evaluateEgressRequest(SYNTHETIC_EGRESS_POLICY, request);
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.denialCode).toBe('QUERY_PARAM_NOT_ALLOWED');
      }
    });
  });

  describe('mutation and side-effect rejection', () => {
    it.each(['POST', 'PUT', 'DELETE', 'PATCH'] as const)(
      'rejects mutating HTTP method %s',
      (method) => {
        const request: EgressRequest = {
          url: `${SYNTHETIC_ORIGIN}/v1/items`,
          method,
          provider: SYNTHETIC_PROVIDER,
          operation: 'create_or_mutate_item',
        };

        const decision = evaluateEgressRequest(SYNTHETIC_EGRESS_POLICY, request);
        expect(decision.allowed).toBe(false);
        if (!decision.allowed) {
          expect(decision.denialCode).toBe('WRITE_OPERATION_BLOCKED');
        }
      },
    );

    it('rejects non-read operation kinds', () => {
      const request: EgressRequest = {
        url: `${SYNTHETIC_ORIGIN}/v1/status`,
        method: 'GET',
        provider: SYNTHETIC_PROVIDER,
        operation: 'delete_operation',
        operationKind: 'write',
      };

      const decision = evaluateEgressRequest(SYNTHETIC_EGRESS_POLICY, request);
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.denialCode).toBe('WRITE_OPERATION_BLOCKED');
      }
    });
  });

  describe('scope checking', () => {
    it('denies requests requiring scopes not granted by the rule', () => {
      const request: EgressRequest = {
        url: `${SYNTHETIC_ORIGIN}/v1/status`,
        method: 'GET',
        provider: SYNTHETIC_PROVIDER,
        operation: 'get_status',
        operationKind: 'read',
        requestedScopes: ['connector:admin', SYNTHETIC_SCOPE_READ],
      };

      const decision = evaluateEgressRequest(SYNTHETIC_EGRESS_POLICY, request);
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.denialCode).toBe('SCOPE_MISMATCH');
      }
    });
  });

  describe('redirect evaluation and re-authentication', () => {
    it('denies redirect if the rule does not explicitly allow redirects', () => {
      const noRedirectRule: EgressRule = {
        ruleId: 'rule-no-redirect',
        provider: SYNTHETIC_PROVIDER,
        allowedOrigins: [SYNTHETIC_ORIGIN],
        allowedMethods: ['GET'],
        allowedPathPatterns: ['/v1/status'],
        requiredScopes: [SYNTHETIC_SCOPE_READ],
        allowedOperations: ['get_status'],
        operationKind: 'read',
        allowRedirects: false,
      };

      const policy: EgressPolicy = {
        version: 1,
        rules: [noRedirectRule],
        defaultAction: 'deny',
      };

      const originalRequest: EgressRequest = {
        url: `${SYNTHETIC_ORIGIN}/v1/status`,
        method: 'GET',
        provider: SYNTHETIC_PROVIDER,
        operation: 'get_status',
      };

      const decision = evaluateRedirectCandidate(
        policy,
        originalRequest,
        `${SYNTHETIC_ORIGIN}/v1/status`,
      );
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.denialCode).toBe('REDIRECT_TARGET_DENIED');
      }
    });

    it('denies redirect if the second hop attempts an unapproved destination', () => {
      const originalRequest: EgressRequest = {
        url: `${SYNTHETIC_ORIGIN}/v1/status`,
        method: 'GET',
        provider: SYNTHETIC_PROVIDER,
        operation: 'get_status',
      };

      // Redirect target pointing to evil origin
      const decision = evaluateRedirectCandidate(
        SYNTHETIC_EGRESS_POLICY,
        originalRequest,
        'https://attacker.example.com/steal',
      );

      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.denialCode).toBe('REDIRECT_TARGET_DENIED');
      }
    });

    it('allows redirect if the target independently passes all egress rules', () => {
      const originalRequest: EgressRequest = {
        url: `${SYNTHETIC_ORIGIN}/v1/status`,
        method: 'GET',
        provider: SYNTHETIC_PROVIDER,
        operation: 'get_status',
      };

      const targetUrl = `${SYNTHETIC_ORIGIN}/v1/items/item-redirected`;
      const decision = evaluateRedirectCandidate(
        SYNTHETIC_EGRESS_POLICY,
        originalRequest,
        targetUrl,
      );

      expect(decision.allowed).toBe(true);
      if (decision.allowed) {
        expect(decision.sanitizedUrl).toBe(targetUrl);
      }
    });
  });

  describe('operation ID binding and scope defenses', () => {
    it('denies requests with operation ID not included in rule allowedOperations', () => {
      const request: EgressRequest = {
        url: `${SYNTHETIC_ORIGIN}/v1/status`,
        method: 'GET',
        provider: SYNTHETIC_PROVIDER,
        operation: 'unlisted_synthetic_operation',
        operationKind: 'read',
      };

      const decision = evaluateEgressRequest(SYNTHETIC_EGRESS_POLICY, request);
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.denialCode).toBe('OPERATION_NOT_ALLOWED');
        expect(decision.reason).not.toContain('unlisted_synthetic_operation');
      }
    });

    it('denies requests with empty requestedScopes when rule requires scopes', () => {
      const request: EgressRequest = {
        url: `${SYNTHETIC_ORIGIN}/v1/status`,
        method: 'GET',
        provider: SYNTHETIC_PROVIDER,
        operation: 'get_status',
        operationKind: 'read',
        requestedScopes: [],
      };

      const decision = evaluateEgressRequest(SYNTHETIC_EGRESS_POLICY, request);
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.denialCode).toBe('SCOPE_MISMATCH');
      }
    });

    it('rejects policy evaluation when duplicate ruleId is present', () => {
      const dupPolicy: EgressPolicy = {
        version: 1,
        rules: [
          SYNTHETIC_EGRESS_POLICY.rules[0]!,
          { ...SYNTHETIC_EGRESS_POLICY.rules[0]! }, // identical ruleId
        ],
        defaultAction: 'deny',
      };

      const request: EgressRequest = {
        url: `${SYNTHETIC_ORIGIN}/v1/status`,
        method: 'GET',
        provider: SYNTHETIC_PROVIDER,
        operation: 'get_status',
        operationKind: 'read',
      };

      const decision = evaluateEgressRequest(dupPolicy, request);
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.denialCode).toBe('NO_MATCHING_RULE');
        expect(decision.reason).toContain('duplicate ruleId');
      }
    });

    it('rejects requests when callingTenantId does not match tenant-bound policy', () => {
      const tenantPolicy: EgressPolicy = {
        version: 1,
        tenantId: 'tenant-1111',
        rules: SYNTHETIC_EGRESS_POLICY.rules,
        defaultAction: 'deny',
      };

      const request: EgressRequest = {
        url: `${SYNTHETIC_ORIGIN}/v1/status`,
        method: 'GET',
        provider: SYNTHETIC_PROVIDER,
        operation: 'get_status',
        operationKind: 'read',
        requestedScopes: [SYNTHETIC_SCOPE_READ],
      };

      // Mismatched tenant
      const deniedDecision = evaluateEgressRequest(tenantPolicy, request, 'tenant-2222');
      expect(deniedDecision.allowed).toBe(false);
      if (!deniedDecision.allowed) {
        expect(deniedDecision.denialCode).toBe('NO_MATCHING_RULE');
        expect(deniedDecision.reason).toContain('Policy tenant mismatch');
      }

      // Matching tenant
      const allowedDecision = evaluateEgressRequest(tenantPolicy, request, 'tenant-1111');
      expect(allowedDecision.allowed).toBe(true);
    });

    it('fails closed when tenant-bound policy is evaluated without callingTenantId or with empty/whitespace callingTenantId', () => {
      const tenantPolicy: EgressPolicy = {
        version: 1,
        tenantId: 'tenant-1111',
        rules: SYNTHETIC_EGRESS_POLICY.rules,
        defaultAction: 'deny',
      };

      const request: EgressRequest = {
        url: `${SYNTHETIC_ORIGIN}/v1/status`,
        method: 'GET',
        provider: SYNTHETIC_PROVIDER,
        operation: 'get_status',
        operationKind: 'read',
        requestedScopes: [SYNTHETIC_SCOPE_READ],
      };

      // 1. callingTenantId omitted completely
      const missingTenantDecision = evaluateEgressRequest(tenantPolicy, request);
      expect(missingTenantDecision.allowed).toBe(false);
      if (!missingTenantDecision.allowed) {
        expect(missingTenantDecision.denialCode).toBe('NO_MATCHING_RULE');
        expect(missingTenantDecision.reason).toContain(
          'tenant-bound policy requires matching callingTenantId',
        );
      }

      // 2. callingTenantId is undefined
      const undefinedTenantDecision = evaluateEgressRequest(tenantPolicy, request, undefined);
      expect(undefinedTenantDecision.allowed).toBe(false);
      if (!undefinedTenantDecision.allowed) {
        expect(undefinedTenantDecision.denialCode).toBe('NO_MATCHING_RULE');
      }

      // 3. callingTenantId is empty string
      const emptyTenantDecision = evaluateEgressRequest(tenantPolicy, request, '');
      expect(emptyTenantDecision.allowed).toBe(false);
      if (!emptyTenantDecision.allowed) {
        expect(emptyTenantDecision.denialCode).toBe('NO_MATCHING_RULE');
      }

      // 4. callingTenantId is whitespace only
      const whitespaceTenantDecision = evaluateEgressRequest(tenantPolicy, request, '   ');
      expect(whitespaceTenantDecision.allowed).toBe(false);
      if (!whitespaceTenantDecision.allowed) {
        expect(whitespaceTenantDecision.denialCode).toBe('NO_MATCHING_RULE');
      }

      // 5. evaluateRedirectCandidate also fails closed when callingTenantId is omitted on tenant-bound policy
      const redirectDecision = evaluateRedirectCandidate(
        tenantPolicy,
        request,
        `${SYNTHETIC_ORIGIN}/v1/status/redirected`,
      );
      expect(redirectDecision.allowed).toBe(false);
      if (!redirectDecision.allowed) {
        expect(redirectDecision.denialCode).toBe('NO_MATCHING_RULE');
      }
    });
  });
});
