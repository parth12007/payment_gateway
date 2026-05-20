import { createHash } from 'node:crypto';

// Deterministic JSON serializer: object keys sorted alphabetically, no whitespace.
// Two objects with the same data produce the same string regardless of key order.
// This is what we hash for idempotency-conflict detection.
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(sortValue);
  const obj = v as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortValue(obj[key]);
  }
  return sorted;
}

export function requestHash(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}
