import { describe, expect, it } from 'vitest';
import {
  SYNTHETIC_EGRESS_POLICY,
  SYNTHETIC_ORIGIN,
  SYNTHETIC_PROVIDER,
  evaluateEgressRequest,
  evaluateRedirectCandidate,
  type EgressPolicy,
  type EgressRequest,
  type EgressRule,
} from '@ember/credentials';

const CUSTOM_ORIGIN = 'https://allowed.example';

const CUSTOM_RULE: EgressRule = {
  ruleId: 'rule-custom-test',
  provider: 'custom-provider',
  allowedOrigins: [CUSTOM_ORIGIN],
  allowedMethods: ['GET', 'HEAD'],
  allowedPathPatterns: ['/v1/resource', '/v1/resource/*'],
  allowedQueryParams: ['safe_query'],
  requiredScopes: ['custom:read'],
  operationKind: 'read',
  allowRedirects: true,
};

const CUSTOM_POLICY: EgressPolicy = {
  version: 1,
  rules: [CUSTOM_RULE],
  defaultAction: 'deny',
};

function req(url: string, method: 'GET' | 'HEAD' = 'GET'): EgressRequest {
  return {
    url,
    method,
    provider: 'custom-provider',
    operation: 'test_operation',
    operationKind: 'read',
    requestedScopes: ['custom:read'],
  };
}

describe('Adversarial URL Matrix and Edge Cases', () => {
  describe('origin spoofing and subdomain attacks', () => {
    it('rejects subdomain suffix spoofing (https://allowed.example.evil.com)', () => {
      const decision = evaluateEgressRequest(
        CUSTOM_POLICY,
        req('https://allowed.example.evil.com/v1/resource'),
      );
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.denialCode).toBe('ORIGIN_NOT_ALLOWED');
      }
    });

    it('rejects prefix spoofing (https://evil-allowed.example)', () => {
      const decision = evaluateEgressRequest(
        CUSTOM_POLICY,
        req('https://evil-allowed.example/v1/resource'),
      );
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.denialCode).toBe('ORIGIN_NOT_ALLOWED');
      }
    });

    it('rejects userinfo-based destination spoofing (https://allowed.example@evil.com)', () => {
      const decision = evaluateEgressRequest(
        CUSTOM_POLICY,
        req('https://allowed.example@evil.com/v1/resource'),
      );
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.denialCode).toBe('USERINFO_FORBIDDEN');
      }
    });

    it('rejects userinfo with credentials (https://user:password@allowed.example/v1/resource)', () => {
      const decision = evaluateEgressRequest(
        CUSTOM_POLICY,
        req('https://user:password@allowed.example/v1/resource'),
      );
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.denialCode).toBe('USERINFO_FORBIDDEN');
      }
    });
  });

  describe('insecure schemes and non-HTTP protocols', () => {
    it.each([
      'http://allowed.example/v1/resource',
      'ftp://allowed.example/v1/resource',
      'file:///etc/passwd',
      'gopher://allowed.example:70/',
      'javascript:alert(1)',
      'data:text/plain;base64,SGVsbG8=',
    ])('rejects non-https scheme: %s', (url) => {
      const decision = evaluateEgressRequest(CUSTOM_POLICY, req(url));
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(['UNSUPPORTED_SCHEME', 'INVALID_URL']).toContain(decision.denialCode);
      }
    });
  });

  describe('localhost and private destination protection', () => {
    it.each([
      'https://localhost/v1/resource',
      'https://localhost:443/v1/resource',
      'https://sub.localhost/v1/resource',
      'https://myhost.local/v1/resource',
      'https://internal.lan/v1/resource',
    ])('rejects local/internal hostname: %s', (url) => {
      const decision = evaluateEgressRequest(CUSTOM_POLICY, req(url));
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.denialCode).toBe('PRIVATE_OR_LOCAL_HOST');
      }
    });
  });

  describe('IP literal address protection', () => {
    it.each([
      'https://127.0.0.1/v1/resource',
      'https://127.0.0.1:443/v1/resource',
      'https://[::1]/v1/resource',
      'https://10.0.0.1/v1/resource',
      'https://172.16.0.1/v1/resource',
      'https://192.168.1.1/v1/resource',
      'https://169.254.169.254/latest/meta-data/', // AWS metadata service
      'https://0.0.0.0/v1/resource',
      'https://8.8.8.8/v1/resource', // public IP literals are also forbidden
    ])('rejects IP literal: %s', (url) => {
      const decision = evaluateEgressRequest(CUSTOM_POLICY, req(url));
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.denialCode).toBe('IP_LITERAL_FORBIDDEN');
      }
    });
  });

  describe('non-standard ports', () => {
    it.each([
      'https://allowed.example:8443/v1/resource',
      'https://allowed.example:8080/v1/resource',
      'https://allowed.example:80/v1/resource',
      'https://allowed.example:444/v1/resource',
    ])('rejects non-443 port: %s', (url) => {
      const decision = evaluateEgressRequest(CUSTOM_POLICY, req(url));
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.denialCode).toBe('INVALID_PORT');
      }
    });
  });

  describe('path traversal and dot-encoding variants', () => {
    it.each([
      'https://allowed.example/v1/resource/../secret',
      'https://allowed.example/v1/resource/..',
      'https://allowed.example/v1/resource/%2e%2e/secret',
      'https://allowed.example/v1/resource/%2E%2E/secret',
      'https://allowed.example/v1/resource/%2e/secret',
      'https://allowed.example/v1/resource/./secret',
      'https://allowed.example/v1/resource\\secret',
    ])('rejects directory traversal and encoded variants: %s', (url) => {
      const decision = evaluateEgressRequest(CUSTOM_POLICY, req(url));
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.denialCode).toBe('PATH_NOT_ALLOWED');
      }
    });
  });

  describe('URL fragments', () => {
    it('rejects fragment identifiers', () => {
      const decision = evaluateEgressRequest(
        CUSTOM_POLICY,
        req('https://allowed.example/v1/resource#fragment-payload'),
      );
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.denialCode).toBe('FRAGMENT_FORBIDDEN');
      }
    });
  });

  describe('query parameter allowlist enforcement', () => {
    it('allows explicitly whitelisted query parameters', () => {
      const decision = evaluateEgressRequest(
        CUSTOM_POLICY,
        req('https://allowed.example/v1/resource?safe_query=value1'),
      );
      expect(decision.allowed).toBe(true);
    });

    it('rejects unknown query parameter keys', () => {
      const decision = evaluateEgressRequest(
        CUSTOM_POLICY,
        req('https://allowed.example/v1/resource?safe_query=1&unknown_extra=2'),
      );
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.denialCode).toBe('QUERY_PARAM_NOT_ALLOWED');
      }
    });
  });

  describe('redirect candidate second-hop enforcement', () => {
    it('rejects redirect to evil origin on second hop', () => {
      const original = req('https://allowed.example/v1/resource');
      const decision = evaluateRedirectCandidate(
        CUSTOM_POLICY,
        original,
        'https://allowed.example.evil.com/v1/resource',
      );
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.denialCode).toBe('REDIRECT_TARGET_DENIED');
      }
    });

    it('rejects redirect to localhost or internal network on second hop', () => {
      const original = req('https://allowed.example/v1/resource');
      const decision = evaluateRedirectCandidate(
        CUSTOM_POLICY,
        original,
        'https://169.254.169.254/latest/meta-data/',
      );
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.denialCode).toBe('REDIRECT_TARGET_DENIED');
      }
    });
  });

  describe('exact configured read-only destination', () => {
    it('allows legitimate requests exactly matching the policy', () => {
      const decision = evaluateEgressRequest(
        CUSTOM_POLICY,
        req('https://allowed.example/v1/resource'),
      );
      expect(decision.allowed).toBe(true);
      if (decision.allowed) {
        expect(decision.matchedRuleId).toBe('rule-custom-test');
        expect(decision.sanitizedUrl).toBe('https://allowed.example/v1/resource');
      }
    });

    it('allows legitimate synthetic fixture requests', () => {
      const decision = evaluateEgressRequest(SYNTHETIC_EGRESS_POLICY, {
        url: `${SYNTHETIC_ORIGIN}/v1/status`,
        method: 'GET',
        provider: SYNTHETIC_PROVIDER,
        operation: 'get_status',
      });
      expect(decision.allowed).toBe(true);
    });
  });
});
