import IORedis from "ioredis";

const REDIS_CONFIG = {
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
  maxRetriesPerRequest: null,    // required by BullMQ
  enableReadyCheck: false        // prevents boot-time crash if Redis is slow to start
};

/**
 * Creates a fresh IORedis connection.
 *
 * BullMQ requires separate connection instances for Queue, Worker, and
 * QueueEvents — you must NOT share a single connection across all three
 * because BullMQ puts subscriber connections into a blocking mode that
 * prevents normal commands from being issued on the same socket.
 *
 * Usage:
 *   import { makeRedisConnection } from "./lib/redis.js";
 *   const connection = makeRedisConnection();
 */
export function makeRedisConnection() {
  return new IORedis(REDIS_CONFIG);
}

// ---------------------------------------------------------------------------
// Pub/Sub channel helpers
// ---------------------------------------------------------------------------

/** Channel name that the worker publishes to after every job state change. */
export function jobChannel(jobId) {
  return `job-updates:${jobId}`;
}