/** TypeID fields for params and bodies: `typeId('feed')` accepts only a `feed_…` id and yields a `FeedId`. */
import { z } from '@hono/zod-openapi';
import { parseId, type IdPrefix } from '@supercal/db';

export const typeId = <P extends IdPrefix>(prefix: P) =>
  z
    .string()
    .transform((raw, ctx) => parseId(prefix, raw) ?? (ctx.addIssue({ code: 'custom', message: `not a ${prefix}_ id` }), z.NEVER))
    .openapi({ type: 'string', pattern: `^${prefix}_[0-7][0-9a-hjkmnp-tv-z]{25}$`, example: `${prefix}_01h455vb4pex5vsknk084sn02q` });
