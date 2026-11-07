/** `bun run api:spec`: writes the OpenAPI document to packages/api-client/openapi.json without starting a server. */
import { createControlDatabase, createSecretBox } from '@supercal/db';
import { createApi, openApiConfig } from '../src/api/index.ts';
import { createAuth } from '../src/auth/auth.ts';

// Route registration needs an auth instance but never a connection; the pool connects lazily.
const auth = createAuth(
  { PORT: 0, SUPERCAL_SIGNUP: 'invite', SUPERCAL_INSECURE_DEV: true, SUPERCAL_PUBLIC_URL: undefined, WEB_ORIGIN: undefined, BETTER_AUTH_SECRET: undefined, RESEND_API_KEY: undefined },
  createControlDatabase('postgres://localhost/unused'),
);

const out = new URL('../../../packages/api-client/openapi.json', import.meta.url);
await Bun.write(out, `${JSON.stringify(createApi({ auth, secrets: await createSecretBox({ insecureDev: true, warn: () => {} }) }).getOpenAPI31Document(openApiConfig), null, 2)}\n`);
console.log(`wrote ${out.pathname}`);
