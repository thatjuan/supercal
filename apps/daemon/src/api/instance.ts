/**
 * `GET /api/v1/instance`: public facts about this install that the sign-in and sign-up screens need
 * before anyone is signed in. `createApi` mounts it ahead of authentication.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { createApiApp, problemResponses } from './kit/index.ts';

export const Instance = z
  .object({
    signup: z.enum(['open', 'invite', 'disabled']).openapi({ description: '`SUPERCAL_SIGNUP`: who may create an account' }),
    setupRequired: z.boolean().openapi({ description: 'No user exists yet: whoever signs up first becomes the operator, whatever `signup` says' }),
    providers: z
      .object({ google: z.boolean(), microsoft: z.boolean() })
      .openapi({ description: 'OAuth account providers the operator has configured (client id and secret)' }),
  })
  .openapi('Instance');
export type Instance = z.infer<typeof Instance>;

export type Signup = Instance['signup'];

/** What config decides about the instance; `setupRequired` is read per request. */
type InstanceConfig = Omit<Instance, 'setupRequired'>;

const getInstance = createRoute({
  method: 'get',
  path: '/api/v1/instance',
  operationId: 'getInstance',
  tags: ['Account'],
  security: [],
  responses: {
    200: { description: 'This install’s sign-up mode and providers', content: { 'application/json': { schema: Instance } } },
    ...problemResponses(),
  },
});

export const instanceRoutes = (instance: InstanceConfig, isEmptyInstall: () => Promise<boolean>) =>
  createApiApp().openapi(getInstance, async (c) => c.json({ ...instance, setupRequired: await isEmptyInstall() }, 200));
