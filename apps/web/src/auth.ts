/**
 * The Better Auth client for sign-up, sign-in, sign-out, invitations and the active tenant
 * (organization). Same origin, so its cookie is the one `$api` sends.
 */
import { organizationClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient({ baseURL: window.location.origin, plugins: [organizationClient()] });
