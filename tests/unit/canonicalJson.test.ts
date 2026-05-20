import { describe, expect, it } from 'vitest';
import { canonicalize, requestHash } from '../../src/utils/canonicalJson.js';

describe('canonicalize', () => {
  it('sorts object keys alphabetically', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('produces identical output for equivalent objects', () => {
    const a = { amount: 100, currency: 'USD', merchantId: 'm1' };
    const b = { merchantId: 'm1', currency: 'USD', amount: 100 };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it('recursively sorts nested objects', () => {
    expect(canonicalize({ z: { b: 1, a: 2 }, a: 1 })).toBe('{"a":1,"z":{"a":2,"b":1}}');
  });

  it('preserves array order', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });

  it('handles null, primitives, and booleans', () => {
    expect(canonicalize(null)).toBe('null');
    expect(canonicalize(42)).toBe('42');
    expect(canonicalize('hi')).toBe('"hi"');
    expect(canonicalize(true)).toBe('true');
  });
});

describe('requestHash', () => {
  it('returns the same sha256 for equivalent objects', () => {
    const a = { x: 1, y: { c: 3, b: 2 } };
    const b = { y: { b: 2, c: 3 }, x: 1 };
    expect(requestHash(a)).toBe(requestHash(b));
  });

  it('returns different hashes for different payloads', () => {
    expect(requestHash({ x: 1 })).not.toBe(requestHash({ x: 2 }));
  });

  it('returns a 64-char hex string', () => {
    expect(requestHash({ any: 'thing' })).toMatch(/^[0-9a-f]{64}$/);
  });
});
