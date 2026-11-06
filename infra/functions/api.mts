import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { deliveryKey } from '../../src/jobs/delivery.js';
import { reuseStores, type Stores } from './database.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (statusCode: number, body: unknown): APIGatewayProxyResult =>
  ({ statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/**
 * The read side of the API. API Gateway checks the API key and sends POST /jobs straight to SQS,
 * so this function only answers GET requests.
 */
export function createHandler(stores: () => Promise<Stores>) {
  return async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const id = event.pathParameters?.id;
    if (id !== undefined && !uuid.test(id)) return json(400, { error: 'The ID must be a UUID' });
    try {
      const { runs, jobs } = await stores();
      switch (`${event.httpMethod} ${event.resource}`) {
        case 'GET /runs': return json(200, { runs: await runs.list(50) });
        case 'GET /runs/{id}': {
          const run = await runs.get(id!);
          return run ? json(200, run) : json(404, { error: 'Run not found' });
        }
        case 'GET /summary': return json(200, { summary: await runs.summary() });
        // The ID is the one POST /jobs returned, which is the SQS message ID.
        case 'GET /jobs/{id}': {
          const job = await jobs.getByIdempotencyKey(deliveryKey(id!));
          if (!job) return json(404, { error: 'Job not found. It may still be waiting in the queue.' });
          return json(200, { job, run: job.runId ? await runs.get(job.runId) ?? null : null });
        }
        default: return json(404, { error: 'Not found' });
      }
    } catch (error) {
      console.error(JSON.stringify({ path: event.path, error: error instanceof Error ? error.message : String(error) }));
      return json(500, { error: 'Internal error' });
    }
  };
}

export const handler = createHandler(reuseStores());
