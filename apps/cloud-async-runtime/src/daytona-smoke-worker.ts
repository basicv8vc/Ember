import {
  handleDaytonaSmokeFetch,
  handleDaytonaSmokeQueue,
  type DaytonaSmokeWorkerEnv,
  type SmokeQueueBatch,
} from './daytona-smoke-handler.js';

export default {
  fetch(request: Request, env: DaytonaSmokeWorkerEnv): Promise<Response> {
    return handleDaytonaSmokeFetch(request, env);
  },

  queue(batch: SmokeQueueBatch, env: DaytonaSmokeWorkerEnv): Promise<void> {
    return handleDaytonaSmokeQueue(batch, env);
  },
};
