/**
 * RFC 9457 problem details. Handlers throw the error classes below; `createApiApp`'s error handler
 * renders them as `application/problem+json`. Routes declare the statuses they can return with
 * `problemResponses`, because a global handler alone does not document them.
 */
import { z } from '@hono/zod-openapi';

export const FieldError = z.object({ path: z.string(), message: z.string() }).openapi('FieldError');
export type FieldError = z.infer<typeof FieldError>;

export const Problem = z
  .object({
    type: z.url(),
    title: z.string(),
    status: z.int(),
    detail: z.string().optional(),
    instance: z.string().optional(),
    errors: z.array(FieldError).optional(),
  })
  .openapi('Problem');
export type Problem = z.infer<typeof Problem>;

/** Each status we emit, with its stable `type` slug and title. */
const PROBLEMS = {
  400: { slug: 'bad-request', title: 'Bad request' },
  401: { slug: 'unauthorized', title: 'Unauthorized' },
  403: { slug: 'forbidden', title: 'Forbidden' },
  404: { slug: 'not-found', title: 'Not found' },
  409: { slug: 'conflict', title: 'Conflict' },
  412: { slug: 'precondition-failed', title: 'Precondition failed' },
  428: { slug: 'precondition-required', title: 'Precondition required' },
  429: { slug: 'too-many-requests', title: 'Too many requests' },
  500: { slug: 'internal', title: 'Internal error' },
  503: { slug: 'unavailable', title: 'Service unavailable' },
} as const;

export type ProblemStatus = keyof typeof PROBLEMS;

export const problemType = (slug: string) => `https://supercal.dev/problems/${slug}`;

/**
 * Base class for errors that render as a problem; prefer the named subclasses. `slug` names a more
 * specific problem type than the status's default (e.g. `no-active-tenant` for a 403).
 */
export class ProblemError extends Error {
  constructor(
    readonly status: ProblemStatus,
    readonly detail?: string,
    readonly errors?: FieldError[],
    readonly slug: string = PROBLEMS[status].slug,
  ) {
    super(detail ?? PROBLEMS[status].title);
  }

  toProblem(instance: string): Problem {
    return {
      type: problemType(this.slug),
      title: PROBLEMS[this.status].title,
      status: this.status,
      ...(this.detail !== undefined && { detail: this.detail }),
      instance,
      ...(this.errors && { errors: this.errors }),
    };
  }
}

export class BadRequest extends ProblemError {
  constructor(errors: FieldError[], detail = 'The request failed validation') {
    super(400, detail, errors);
  }
}
export class Unauthorized extends ProblemError {
  constructor(detail?: string) {
    super(401, detail);
  }
}
export class Forbidden extends ProblemError {
  constructor(detail?: string, slug?: string) {
    super(403, detail, undefined, slug);
  }
}
export class NotFound extends ProblemError {
  constructor(detail?: string) {
    super(404, detail);
  }
}
export class Conflict extends ProblemError {
  constructor(detail?: string) {
    super(409, detail);
  }
}
export class PreconditionFailed extends ProblemError {
  constructor(detail = 'If-Match does not match the current ETag') {
    super(412, detail);
  }
}
export class PreconditionRequired extends ProblemError {
  constructor(detail = 'This request requires an If-Match header') {
    super(428, detail);
  }
}

export class TooManyRequests extends ProblemError {
  constructor(detail?: string) {
    super(429, detail);
  }
}

const problemResponse = (status: ProblemStatus) => ({
  description: PROBLEMS[status].title,
  content: { 'application/problem+json': { schema: Problem } },
});

/**
 * The `responses` entries for `createRoute`, spread next to the success response:
 * `responses: { 200: …, ...problemResponses(400, 404) }`. 500 is always included.
 */
export function problemResponses<const S extends ProblemStatus>(...statuses: S[]) {
  const entries = [...statuses, 500 as const].map((status) => [status, problemResponse(status)]);
  return Object.fromEntries(entries) as Record<S | 500, ReturnType<typeof problemResponse>>;
}
