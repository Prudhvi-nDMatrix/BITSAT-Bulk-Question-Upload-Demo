import { Queue } from "bullmq";
import { makeRedisConnection } from "./redis.js";

/**
 * The BullMQ Queue (producer side).
 *
 * Uses its own dedicated connection — BullMQ docs explicitly warn against
 * sharing IORedis instances between Queue, Worker, and QueueEvents.
 */
export const questionQueue = new Queue("question-upload-queue", {
  connection: makeRedisConnection()
});