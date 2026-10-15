/**
 * CORS & preflight validation (ISSUE-111).
 * Verifies that all HTTP methods used across the web-v5 dashboard and operator
 * panel (specifically PUT for mail-config and admin config) are included in
 * Access-Control-Allow-Methods, and that cross-origin preflight requests
 * succeed from allow-listed origins and fail-close for strangers.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';
import { testTmpDir } from './helpers/tmp-dirs.js';

const TEST_JWT_SECRET = 'test-only-secret-0123456789abcdef0123456789abcdef';
const OPERATOR = 'test-operator-secret-0123456789abcdef';
const ALLOWED_ORIGIN = 'https://app.dprelay.digital-papyrus.com';

let app: FastifyInstance;

function makeApp(): FastifyInstance {
  const dbPath = join(testTmpDir('dprelay-cors-test-'), 'test.db');
  return buildApp({
    dbPath,
    env: {
      JWT_SECRET: TEST_JWT_SECRET,
      OPERATOR_SECRET: OPERATOR,
      CORS_ALLOWED_ORIGINS: ALLOWED_ORIGIN,
    },
  });
}

beforeAll(async () => {
  app = makeApp();
});

afterAll(async () => {
  await app.close();
});

describe('CORS preflight & method allow-list (ISSUE-111)', () => {
  it('allows preflight OPTIONS with PUT method on /v5/admin/mail-config', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/v5/admin/mail-config',
      headers: {
        Origin: ALLOWED_ORIGIN,
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'authorization, content-type',
      },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    const allowMethods = res.headers['access-control-allow-methods'] as string;
    expect(allowMethods).toBeDefined();
    const methods = allowMethods.split(',').map((m) => m.trim());
    expect(methods).toContain('PUT');
    expect(methods).toContain('GET');
    expect(methods).toContain('POST');
    expect(methods).toContain('PATCH');
    expect(methods).toContain('DELETE');
    expect(methods).toContain('HEAD');
    expect(methods).toContain('OPTIONS');
  });

  it('allows preflight OPTIONS with PUT method on /v5/admin/config/:key', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/v5/admin/config/payment_match_window_min',
      headers: {
        Origin: ALLOWED_ORIGIN,
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'authorization, content-type',
      },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    const allowMethods = res.headers['access-control-allow-methods'] as string;
    expect(allowMethods.split(',').map((m) => m.trim())).toContain('PUT');
  });

  it('allows preflight OPTIONS with POST and custom headers', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/v5/admin/mail-config/test',
      headers: {
        Origin: ALLOWED_ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization, content-type, x-app-id, x-app-secret',
      },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    const allowHeaders = (res.headers['access-control-allow-headers'] as string).toLowerCase();
    expect(allowHeaders).toContain('authorization');
    expect(allowHeaders).toContain('content-type');
  });

  it('allows actual cross-origin PUT /v5/admin/mail-config and returns CORS headers', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/v5/admin/mail-config',
      headers: {
        Origin: ALLOWED_ORIGIN,
        Authorization: `Bearer ${OPERATOR}`,
        'Content-Type': 'application/json',
      },
      payload: {
        host: 'smtp.test.example',
        port: 587,
        username: 'user@test.example',
        password: 'secure-smtp-password',
        fromAddress: 'notifications@test.example',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(res.json()).toMatchObject({
      ok: true,
      configured: true,
      host: 'smtp.test.example',
      port: 587,
      fromAddress: 'notifications@test.example',
      passwordMasked: '••••',
    });
  });

  it('allows actual cross-origin PUT /v5/admin/config/:key and returns CORS headers', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/v5/admin/config/payment_match_window_min',
      headers: {
        Origin: ALLOWED_ORIGIN,
        Authorization: `Bearer ${OPERATOR}`,
        'Content-Type': 'application/json',
      },
      payload: { value: 45 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(res.json()).toMatchObject({
      ok: true,
      key: 'payment_match_window_min',
      value: 45,
    });
  });

  it('fails closed for unallowed origin (no Access-Control-Allow-Origin returned)', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/v5/admin/mail-config',
      headers: {
        Origin: 'https://malicious.example',
        'Access-Control-Request-Method': 'PUT',
      },
    });

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
