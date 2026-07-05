// Manual mock so no test suite opens a real Redis connection - mirrors how
// Prisma/Telnyx/Google are mocked at the module boundary in individual tests,
// but applied globally since bullmq.Queue connects eagerly on construction.
export class Queue {
  add = jest.fn().mockResolvedValue({ id: "mock-job-id" });
  getJobs = jest.fn().mockResolvedValue([]);
  close = jest.fn().mockResolvedValue(undefined);
  constructor(_name: string, _opts?: unknown) {}
}

export class Worker {
  on = jest.fn();
  close = jest.fn().mockResolvedValue(undefined);
  constructor(_name: string, _processor: unknown, _opts?: unknown) {}
}

export type ConnectionOptions = unknown;
export type Job<T = unknown> = { id?: string; data: T };
