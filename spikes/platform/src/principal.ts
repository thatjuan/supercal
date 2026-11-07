import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { auth } from './auth';
import { db } from './db';
import { member } from './auth-schema';
import {apiKeyBinding} from './platform-schema';
export const roleSchema = z.enum(['owner', 'admin', 'member']);
export type Principal = { userId: string; tenantId: string; role: z.infer<typeof roleSchema>; via: 'session' | 'apiKey' };
// Immutable tenant binding lives outside client-editable API-key metadata. Recheck membership per call.
export async function resolvePrincipal(headers: Headers): Promise<Principal | null> {
  const key = headers.get('x-api-key');
  let userId: string;
  let tenantId: string;
  let via: Principal['via'];
  if (key) {
    const verified = await auth.api.verifyApiKey({ body: { key, configId: 'default' } });
    if (!verified.valid || !verified.key) return null;
    const [binding] = await db.select().from(apiKeyBinding).where(eq(apiKeyBinding.apiKeyId,verified.key.id)).limit(1);
    if (!binding || binding.userId !== verified.key.referenceId) return null;
    userId = binding.userId;
    tenantId = binding.tenantId;
    via = 'apiKey';
  } else {
    const session = await auth.api.getSession({ headers });
    if (!session?.session.activeOrganizationId) return null;
    userId = session.user.id;
    tenantId = session.session.activeOrganizationId;
    via = 'session';
  }
  const [membership] = await db.select({ role: member.role }).from(member)
    .where(and(eq(member.userId, userId), eq(member.organizationId, tenantId))).limit(1);
  const role = roleSchema.safeParse(membership?.role);
  return role.success ? { userId, tenantId, role: role.data, via } : null;
}
