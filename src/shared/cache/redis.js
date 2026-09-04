'use strict';

const Redis = require('ioredis');
const config = require('../../config');

let redisClient = null;
let redisSubscriber = null;
let redisEnabled = false;

function isRedisAvailable() {
  return Boolean(redisClient && redisEnabled);
}

if (config.redis.enabled) {
  const redisClientConfig = {
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.pass || null,
    tls: config.redis.useTls ? {} : undefined,
  };

  redisClient = new Redis(redisClientConfig);

  redisClient.on('ready', () => {
    redisEnabled = true;
  });

  redisClient.on('error', (err) => {
    redisEnabled = false;
    console.error('[Redis] Error:', err.message);
  });

  redisSubscriber = redisClient.duplicate();
  redisSubscriber.on('error', (err) => {
    console.error('[Redis Subscriber] Error:', err.message);
  });
} else {
  console.log('[Redis] Disabled');
}

module.exports = {
  redisClient,
  redisSubscriber,
  isRedisAvailable,
};