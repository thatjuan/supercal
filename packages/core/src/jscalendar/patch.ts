import { isDeepStrictEqual } from 'node:util';
import { JSEvent, type PatchObject } from './schema.ts';

export class InvalidPatchError extends Error {
  constructor(readonly pointer: string, message: string) { super(message); }
}
export const escapePointer = (key: string): string => key.replace(/~/g, '~0').replace(/\//g, '~1');
export function pointerTokens(pointer: string): string[] {
  if (/~(?![01])/u.test(pointer)) throw new InvalidPatchError(pointer, 'Invalid JSON Pointer escape');
  return pointer.split('/').map((token) => token.replace(/~1/g, '/').replace(/~0/g, '~'));
}
const container = (value: unknown): value is Record<string, unknown> | unknown[] => value !== null && typeof value === 'object';

/** Applies all patches atomically, including array member replacement (draft bis-22 §1.5.9). */
export function applyPatch(event: JSEvent, patch: PatchObject): JSEvent {
  const entries = Object.entries(patch).map(([pointer, value]) => ({ pointer, value, tokens: pointerTokens(pointer) }));
  for (const a of entries) for (const b of entries) {
    if (a !== b && a.tokens.length <= b.tokens.length && a.tokens.every((t, i) => t === b.tokens[i]))
      throw new InvalidPatchError(b.pointer, 'A patch pointer cannot be the prefix of another pointer');
  }
  const result: Record<string, unknown> = structuredClone(event);
  for (const { pointer, tokens, value } of entries) {
    let target: Record<string, unknown> | unknown[] = result;
    for (const [i, token] of tokens.entries()) {
      if (Array.isArray(target)) {
        if (!/^(0|[1-9]\d*)$/.test(token) || Number(token) >= target.length || (i === tokens.length - 1 && value === null))
          throw new InvalidPatchError(pointer, 'Array patches may only replace existing members with non-null values');
      }
      if (i === tokens.length - 1) {
        if (value === null) {
          if (tokens.length === 1 && ['@type', 'version', 'start', 'uid'].includes(token)) throw new InvalidPatchError(pointer, 'Cannot remove a required property');
          if (!Array.isArray(target)) delete target[token];
        } else {
          Object.defineProperty(target, token, { value: structuredClone(value), enumerable: true, writable: true, configurable: true });
        }
      } else {
        const next: unknown = Object.hasOwn(target, token) ? Reflect.get(target, token) : undefined;
        if (!container(next)) throw new InvalidPatchError(pointer, 'Every token before the last must exist and reference an object or array');
        target = next;
      }
    }
  }
  const parsed = JSEvent.safeParse(result);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const bad = issue.path.map(String);
    const entry = entries.find((e) => e.tokens.every((t, i) => t === bad[i]) || bad.every((t, i) => t === e.tokens[i]));
    throw new InvalidPatchError(entry?.pointer ?? bad.map(escapePointer).join('/'), issue.message);
  }
  return parsed.data;
}

/** A recursive object diff keeps recurrence overrides small and preserves nested patch intent. */
export function diffObjects(base: Record<string, unknown>, next: Record<string, unknown>, prefix = ''): PatchObject {
  const patch: PatchObject = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(next)])) {
    const pointer = prefix + escapePointer(key);
    if (!Object.hasOwn(next, key)) patch[pointer] = null;
    else if (!isDeepStrictEqual(base[key], next[key])) {
      const a = base[key], b = next[key];
      if (container(a) && !Array.isArray(a) && container(b) && !Array.isArray(b) && isDeepStrictEqual(Object.keys(a).sort(), Object.keys(b).sort())) Object.assign(patch, diffObjects(a, b, `${pointer}/`));
      else patch[pointer] = b;
    }
  }
  return patch;
}
