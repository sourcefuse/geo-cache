const crypto = require('crypto');
const redis = require('redis');
const fetch = require('node-fetch');
const lodash = require('lodash');
const geoTimezone = require('geo-tz');
const bluebird = require('bluebird');
const logger = require('pino')();

bluebird.promisifyAll(redis.RedisClient.prototype);
bluebird.promisifyAll(redis.Multi.prototype);
logger.level = process.env.LOGGER_LEVEL;

const redisArguments = {
  tls: JSON.parse(process.env.REDIS_TLS),
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT,
  password: process.env.REDIS_PASSWORD,
  retry_strategy: (options) => {
    const retryAfter = Math.min(options.attempt * 100, 3000);

    if (options.error && options.error.code === 'ECONNREFUSED') {
      logger.error('Redis refused the connection');
      return new Error('Redis refused the connection');
    }
    if (options.total_retry_time > process.env.REDIS_TOTAL_RETRY_TIME) {
      logger.error('Retry time exhausted');
      return new Error('Retry time exhausted');
    }
    if (options.attempt > process.env.REDIS_RETRY_ATTEMPTS) {
      logger.error('Retry attempts exhausted');
      // End reconnecting with built in error
      return undefined;
    }
    // reconnect after
    logger.info(`Retrying in ${retryAfter} milliseconds..`);

    return retryAfter;
  },
};


async function metricsApi() {
  const client = redis.createClient(redisArguments);
  const multi = client.multi();
  try {
    logger.info('Incoming Request!  Api: /metrics');
    multi.hgetall([process.env.REDIS_NAMESPACE, 'metric:get:path:count:h'].join(':'));
    multi.hgetall([process.env.REDIS_NAMESPACE, 'metric:set:path:count:h'].join(':'));
    multi.hgetall([process.env.REDIS_NAMESPACE, 'metric:migrate:path:count:h'].join(':'));
    const [getCountRes, setCountRes, migrateCountRes] = await multi.execAsync();
    const metrics = {
      getCount: getCountRes || {},
      setCount: setCountRes || {},
      migrateCount: migrateCountRes || {},
    };
    logger.info('Response', metrics);
    return {
      statusCode: 200,
      body: `${JSON.stringify(metrics, null, 2)}\n`,
    };
  } catch (err) {
    logger.error('Error while fetching stats', err);
    throw err;
  } finally {
    await client.quitAsync();
  }
}

async function mapsApi(event) {
  const client = redis.createClient(redisArguments);
  try {
    const { path } = event;
    const url = `https://maps.googleapis.com${path}`;
    const requestParams = Object.assign({}, event.queryStringParameters);
    delete requestParams.key;

    logger.info('Incoming Request!', {
      ApiPath: path,
      query: requestParams,
    });

    const query = Object.keys(event.queryStringParameters)
      .reduce((arr, key) => {
        arr[key] = event.queryStringParameters[key];
        return arr;
      }, {});
    const queryString = Object.keys(query).slice(0).sort().map(
      key => [key, encodeURIComponent(query[key])].join('='),
    )
      .join('&');
    const urlString = [url, queryString].join('?');
    const authQuery = Object.assign({},
      { key: process.env.GOOGLE_API_KEY },
      event.queryStringParameters);
    if (!authQuery.key) {
      logger.error('No Google API key Found');
      const statusText = 'Unauthorized';
      return {
        statusCode: 401,
        body: `${statusText}\n`,
      };
    }
    if (path === '/maps/api/timezone/json') {
      const latlong = query.location.split(',');
      try {
        logger.debug('Looking for timezone of latlong');
        const timezones = geoTimezone(latlong[0], latlong[1]);
        if (timezones.length) {
          logger.info('Timezone found!', {
            latlong,
            timezones,
          });
          return {
            headers: {
              'Content-Type': 'application/json; charset=UTF-8',
            },
            statusCode: 200,
            body: `${JSON.stringify({ status: 'OK', timeZoneId: timezones[0] }, null, 2)}\n`,
          };
        }
      } catch (err) {
        logger.error(`Error while looking for timezone of ${latlong} falling back to google`, err);
      }
    }

    const sha = crypto.createHash('sha1').update(urlString).digest('hex');
    const cacheKey = [process.env.REDIS_NAMESPACE, sha, 'j'].join(':');

    try {
      const multi = client.multi();
      logger.debug(`Looking for cache ${cacheKey}`);
      multi.get(cacheKey);
      multi.expire(cacheKey, process.env.EXPIRE_SECONDS);
      multi.hincrby([process.env.REDIS_NAMESPACE, 'metric:get:path:count:h'].join(':'), path, 1);
      const [cachedContent] = await multi.execAsync();
      logger.debug('Done looking for cache');
      const parsedContent = JSON.parse(cachedContent);

      if (parsedContent && parsedContent.status && lodash.includes(['OK', 'ZERO_RESULTS'], parsedContent.status)) {
        logger.info('Cache hit!', {
          ApiPath: path,
          query: requestParams,
          cacheKey,
        });
        const formattedContent = JSON.stringify(parsedContent);
        if (cachedContent !== formattedContent) {
          logger.info('Reformating the cached content', cacheKey);
          multi.set(cacheKey, formattedContent);
          await multi.execAsync();
        }
        return {
          headers: {
            'Content-Type': 'application/json; charset=UTF-8',
          },
          body: `${JSON.stringify(parsedContent, null, 2)}\n`,
        };
      }
    } catch (err) {
      logger.error('Error while looking for cache', err);
      throw err;
    }

    try {
      logger.debug('Falling back to google');
      const urlQuery = `${url}?${Object.keys(authQuery)
        .map(key => [key, encodeURIComponent(authQuery[key])].join('='))
        .join('&')}`;
      const res = await fetch(urlQuery);
      logger.debug('Fetched results from google');

      if (res.status !== 200) {
        logger.error('Error!', {
          ApiPath: path,
          query: requestParams,
          status: res.status,
          statusText: res.statusText,
        });
        return {
          statusCode: res.status,
          body: `${res.statusText}\n`,
        };
      }
      const fetchedContent = await res.json();
      const formattedContent = `${JSON.stringify(fetchedContent, null, 2)}\n`;
      if (!lodash.includes(['OK', 'ZERO_RESULTS'], fetchedContent.status)) {
        logger.error('Error from Google!', {
          ApiPath: path,
          query: requestParams,
          status: fetchedContent.status,
          response: formattedContent,
        });
      } else {
        const multi = client.multi();
        const expireSeconds = lodash.includes(['ZERO_RESULTS'], fetchedContent.status)
          ? process.env.SHORT_EXPIRE_SECONDS
          : process.env.EXPIRE_SECONDS;
        if (path !== '/maps/api/timezone/json') {
          logger.debug(`Setting google response in cache ${cacheKey}`);
          multi.setex(cacheKey, expireSeconds, JSON.stringify(fetchedContent));
          multi.hincrby([process.env.REDIS_NAMESPACE, 'metric:set:path:count:h'].join(':'), path, 1);
          await multi.execAsync();
          logger.info({
            Expiry: expireSeconds,
            Api: path,
            query: requestParams,
            cacheKey,
            status: fetchedContent.status,
          });
        }
      }
      return {
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
        },
        body: formattedContent,
      };
    } catch (err) {
      logger.error('Error while fetching results from google', err);
      throw err;
    }
  } catch (err) {
    logger.error(err);
    throw err;
  } finally {
    if (event.path !== '/maps/api/timezone/json') {
      logger.info('Closing Redis connection');
      await client.quitAsync();
    }
  }
}


module.exports = {
  mapsApi,
  metricsApi,
};
