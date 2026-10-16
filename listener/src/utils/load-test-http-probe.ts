/**
 * HTTP probe for the load-testing workflow (issue #860)
 *
 * Kept separate from the measurement core so `load-test-runner.ts` stays
 * socket-free (and therefore deterministic under unit test). Latency is sampled
 * with `process.hrtime.bigint()` because it is monotonic and unaffected by
 * wall-clock adjustments.
 */

import http from 'http';
import https from 'https';

import type { LoadTestProbe, LoadTestScenario } from './load-test-runner';

/**
 * Builds a probe that issues real HTTP requests against `baseUrl`.
 *
 * Network failures resolve with status `0` rather than rejecting, so a flaky
 * connection shows up in the error rate instead of aborting the whole run.
 */
export function makeHttpProbe(baseUrl: string): LoadTestProbe {
  const target = new URL(baseUrl);
  const secure = target.protocol === 'https:';
  const port = target.port ? Number(target.port) : secure ? 443 : 80;
  const agent = secure
    ? new https.Agent({ keepAlive: true, maxSockets: 256 })
    : new http.Agent({ keepAlive: true, maxSockets: 256 });

  return (scenario: LoadTestScenario) =>
    new Promise((resolve) => {
      const startedAt = process.hrtime.bigint();
      const request = (secure ? https : http).request(
        {
          host: target.hostname,
          port,
          path: scenario.path,
          method: scenario.method,
          agent,
          headers: {
            'content-type': 'application/json',
            ...(scenario.headers ?? {}),
          },
        },
        (response) => {
          response.on('data', () => {
            /* drain the body so the socket can be reused */
          });
          response.on('end', () => {
            resolve({
              status: response.statusCode ?? 0,
              durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
            });
          });
        },
      );

      request.on('error', () => {
        resolve({ status: 0, durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6 });
      });

      if (scenario.body) request.write(scenario.body);
      request.end();
    });
}
