/**
 * Compile-time checks on the generated client, run by `bun run typecheck`. Each `@ts-expect-error`
 * fails the build if the mistake below it stops being a type error. Nothing here executes.
 */
import { createClient, createQueryHooks, type Problem } from './index.ts';

const client = createClient('');
const hooks = createQueryHooks(client);

export async function auditEntriesOrProblem(): Promise<string[] | Problem> {
  const { data, error } = await client.GET('/api/v1/audit-log', { params: { query: { limit: 20, targetType: 'feed' } } });
  if (error) return error;
  return data.items.map((entry) => `${entry.action} by ${entry.actor.userId} at ${entry.at}`);
}

export const auditLogOptions = () => hooks.queryOptions('get', '/api/v1/audit-log', { params: { query: { limit: 10 } } });

export function rejectedCalls() {
  // @ts-expect-error nonexistent path
  hooks.queryOptions('get', '/api/v1/audit-logs');
  // @ts-expect-error limit is a number
  hooks.queryOptions('get', '/api/v1/audit-log', { params: { query: { limit: 'many' } } });
  // @ts-expect-error listAuditLog declares no request body, so any body is invalid
  void client.GET('/api/v1/audit-log', { body: { action: 'feed.create' } });
  // @ts-expect-error targetType is a string
  void client.GET('/api/v1/audit-log', { params: { query: { targetType: 5 } } });
}
