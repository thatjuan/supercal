/**
 * Better Auth for the daemon (architecture §7): email + password, organizations as tenants, the
 * admin plugin's global `user.role = 'admin'` as the Supercal operator, user API keys, and its own
 * OpenAPI reference. `createApi` mounts `auth.handler` at `/api/auth/*`.
 *
 * Sign-up modes (`SUPERCAL_SIGNUP`), enforced in `databaseHooks.user.create.before`:
 * - `open`: anyone signs up and gets a personal tenant (owner, set active).
 * - `invite`: sign-up needs `invitationId`, a pending invitation for the same email.
 * - `disabled`: nobody signs up; operators create users and tenants (`POST /api/v1/tenants`).
 * In every mode the first user of an empty install may sign up, becomes the operator, and gets a
 * personal tenant. Server-side calls (no HTTP request) are trusted and skip the mode check.
 *
 * With a mailer (`RESEND_API_KEY` + `MAIL_FROM`), sign-up requires a verified email, and
 * verification, password-reset, magic-link and invitation mail go out. Without one, magic links
 * are disabled and the dashboard hands out invitation and reset links to copy.
 */
import { apiKey } from '@better-auth/api-key';
import {
  account,
  apikey,
  invitation,
  member,
  organization as organizationTable,
  session,
  user as userTable,
  verification,
  type ControlDatabase,
  type ControlTx,
  type TenantId,
} from '@supercal/db';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError } from 'better-auth/api';
import { betterAuth } from 'better-auth/minimal';
import { admin, magicLink, openAPI, organization } from 'better-auth/plugins';
import { and, asc, count, eq, gt, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { publishAuthRevoked } from '../bus.ts';
import type { Config } from '../config.ts';
import { CLIENT_IP_HEADER } from '../client-ip.ts';
import type { Mailer } from '../mail/index.ts';
import * as templates from '../mail/templates.ts';
import { endMembership } from './departure.ts';

export type AuthConfig = Pick<
  Config,
  'PORT' | 'SUPERCAL_PUBLIC_URL' | 'WEB_ORIGIN' | 'BETTER_AUTH_SECRET' | 'SUPERCAL_SIGNUP' | 'SUPERCAL_INSECURE_DEV'
>;

/** The admin plugin's role for the Supercal operator. */
export const OPERATOR_ROLE = 'admin';

/** The extra sign-up body field `invite` mode reads. */
const SignUpInvitation = z.object({ invitationId: z.string().min(1) });

/** A unique-enough slug for `name`: its lowercase words joined by `-`, plus a random suffix. */
export const slugFor = (name: string) => {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `${base || 'tenant'}-${crypto.randomUUID().slice(0, 8)}`;
};

/**
 * Inserts a tenant (organization) and, when given, its first owner. Writes rows directly rather than
 * through Better Auth's organization API, so callers can do it inside their own transaction.
 */
export async function insertTenant(tx: Pick<ControlTx, 'insert'>, tenant: { name: string; slug: string; ownerId?: string | undefined }) {
  const id = crypto.randomUUID() as TenantId;
  const createdAt = new Date();
  const [row] = await tx
    .insert(organizationTable)
    .values({ id, name: tenant.name, slug: tenant.slug, createdAt })
    .returning({ id: organizationTable.id, name: organizationTable.name, slug: organizationTable.slug });
  if (tenant.ownerId) await tx.insert(member).values({ id: crypto.randomUUID(), organizationId: id, userId: tenant.ownerId, role: 'owner', createdAt });
  if (!row) throw new Error('organization insert returned no row');
  return { ...row, id };
}

/**
 * Builds the Better Auth instance over `db` (a `supercal_control` pool), sending mail through
 * `mailer` when there is one, plus
 * `passwordResetLink`, which issues a one-time reset link for an operator to hand out,
 * `isEmptyInstall`, true until the first user (the operator) signs up, and `publicUrl`, the origin
 * clients reach the daemon at.
 */
export function createAuth(config: AuthConfig, db: ControlDatabase, mailer: Mailer | null = null) {
  const baseURL = config.SUPERCAL_PUBLIC_URL ?? `http://localhost:${config.PORT}`;
  const pendingResetLinks = new Map<string, (url: string) => unknown>();

  const isEmptyInstall = async () => {
    const [row] = await db.select({ users: count() }).from(userTable);
    return (row?.users ?? 0) === 0;
  };

  const hasPendingInvitation = async (invitationId: string, email: string) => {
    const [row] = await db
      .select({ id: invitation.id })
      .from(invitation)
      .where(
        and(
          eq(invitation.id, invitationId),
          eq(invitation.email, email.toLowerCase()),
          eq(invitation.status, 'pending'),
          gt(invitation.expiresAt, new Date()),
        ),
      );
    return row !== undefined;
  };

  const auth = betterAuth({
    baseURL,
    secret: config.BETTER_AUTH_SECRET ?? crypto.randomUUID() + crypto.randomUUID(),
    trustedOrigins: [baseURL, ...(config.WEB_ORIGIN ? [config.WEB_ORIGIN] : [])],
    rateLimit: { enabled: !config.SUPERCAL_INSECURE_DEV },
    advanced: { useSecureCookies: !config.SUPERCAL_INSECURE_DEV, ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] } },
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: { user: userTable, session, account, verification, organization: organizationTable, member, invitation, apikey },
    }),
    emailAndPassword: {
      enabled: true,
      // Without mail, nothing could verify.
      requireEmailVerification: mailer !== null,
      // A reset link an operator asked for (`passwordResetLink`) is handed back, never mailed.
      sendResetPassword: async ({ user, url }) => {
        const handOut = pendingResetLinks.get(user.email);
        if (handOut) handOut(url);
        else await mailer?.send({ to: user.email, ...templates.resetPassword({ url }) });
      },
    },
    emailVerification: {
      sendOnSignUp: mailer !== null,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        await mailer?.send({ to: user.email, ...templates.verifyEmail({ url }) });
      },
    },
    // Keys are issued only by `POST /api/v1/api-keys`, which binds them to a tenant. The server API stays available.
    // Self-service leave skips the removal hook; the dashboard uses remove-member. Magic links need mail.
    disabledPaths: ['/api-key/create', '/organization/leave', ...(mailer ? [] : ['/sign-in/magic-link'])],
    databaseHooks: {
      user: {
        create: {
          before: async (user, ctx) => {
            if (await isEmptyInstall()) return { data: { ...user, role: OPERATOR_ROLE } };
            if (!ctx?.request || config.SUPERCAL_SIGNUP === 'open') return;
            const invited = SignUpInvitation.safeParse(ctx.body);
            if (config.SUPERCAL_SIGNUP === 'invite' && invited.success && (await hasPendingInvitation(invited.data.invitationId, user.email))) return;
            throw new APIError('FORBIDDEN', {
              message: config.SUPERCAL_SIGNUP === 'invite' ? 'Sign-up requires a pending invitation' : 'Sign-up is disabled',
              code: 'SIGN_UP_NOT_ALLOWED',
            });
          },
          after: async (user, ctx) => {
            const isOperator = 'role' in user && user.role === OPERATOR_ROLE;
            if (!isOperator && !(ctx?.request && config.SUPERCAL_SIGNUP === 'open')) return;
            // Sign-up runs this hook after it has created the session, so point that session at the tenant too.
            await db.transaction(async (tx) => {
              const tenant = await insertTenant(tx, { name: user.name, slug: slugFor(user.name), ownerId: user.id });
              await tx
                .update(session)
                .set({ activeOrganizationId: tenant.id })
                .where(and(eq(session.userId, user.id), isNull(session.activeOrganizationId)));
            });
          },
        },
      },
      session: {
        create: {
          // New sessions start in the user's oldest tenant, so `/api/v1` works straight after sign-in.
          before: async (row) => {
            if ('activeOrganizationId' in row && row.activeOrganizationId) return;
            const [first] = await db
              .select({ id: member.organizationId })
              .from(member)
              .where(eq(member.userId, row.userId))
              .orderBy(asc(member.createdAt))
              .limit(1);
            return first ? { data: { ...row, activeOrganizationId: first.id } } : undefined;
          },
        },
        // Sign-out, session revocation and bans: close the user's live streams now, not at revalidation.
        delete: { after: (row) => publishAuthRevoked(db, row.userId) },
      },
    },
    plugins: [
      organization({
        allowUserToCreateOrganization: (user) => config.SUPERCAL_SIGNUP === 'open' || ('role' in user && user.role === OPERATOR_ROLE),
        // The dashboard's `/invite/<id>` page accepts it, or signs the invitee up first.
        sendInvitationEmail: async ({ id, email, organization: tenant, inviter }) => {
          await mailer?.send({ to: email, ...templates.invitation({ url: `${baseURL}/invite/${id}`, inviter: inviter.user.name, tenant: tenant.name }) });
        },
        organizationHooks: {
          afterRemoveMember: async ({ user, organization }) => {
            await endMembership(db, organization.id as TenantId, user.id);
          },
        },
      }),
      admin({ adminRoles: [OPERATOR_ROLE] }),
      apiKey({ defaultPrefix: 'sc_', enableMetadata: true, rateLimit: { enabled: false } }),
      // Existing users only: accounts are created by sign-up, where the sign-up mode applies.
      magicLink({
        disableSignUp: true,
        sendMagicLink: async ({ email, url }) => {
          await mailer?.send({ to: email, ...templates.magicLink({ url }) });
        },
      }),
      openAPI(),
    ],
  });

  /** A one-time password-reset link for the user with `email` (the reset page redirects to `redirectTo`). */
  async function passwordResetLink(email: string, redirectTo = baseURL): Promise<string> {
    let link: string | undefined;
    pendingResetLinks.set(email, (url) => (link = url));
    try {
      // Better Auth awaits `sendResetPassword` before returning, so `link` is set once this resolves.
      await auth.api.requestPasswordReset({ body: { email, redirectTo } });
    } finally {
      pendingResetLinks.delete(email);
    }
    if (link === undefined) throw new Error('Better Auth issued no reset link');
    return link;
  }

  return Object.assign(auth, { passwordResetLink, isEmptyInstall, publicUrl: baseURL });
}

export type Auth = ReturnType<typeof createAuth>;
