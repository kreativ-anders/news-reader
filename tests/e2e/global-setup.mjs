// Starts the fixture server and a sandboxed API/app server once for all E2E tests.
// URLs are handed to the tests via process.env (read in tests/e2e/fixtures.mjs).
import { startApi, startFixtures } from '../support/servers.mjs';

export default async function globalSetup() {
  const [fx, api] = await Promise.all([startFixtures({ workers: 4 }), startApi('lab')]);
  process.env.NR_E2E_API = api.url;
  process.env.NR_E2E_FIXTURES = fx.url;
  process.env.NR_E2E_API_DIR = api.dir;
  return async () => {
    const errors = [...api.phpErrors(), ...fx.phpErrors()];
    await Promise.all([api.stop(), fx.stop()]);
    if (errors.length) throw new Error(`PHP logged errors during the E2E run:\n${errors.join('\n')}`);
  };
}
