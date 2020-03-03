const crypto = require('crypto');
const redis = require('redis');
const fetch = require('node-fetch');
const lodash = require('lodash');
const geoTimezone = require('geo-tz');
const bluebird = require('bluebird');

bluebird.promisifyAll(redis.RedisClient.prototype);
bluebird.promisifyAll(redis.Multi.prototype);

const redisArguments = {
  tls: JSON.parse(process.env.REDIS_TLS),
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT,
  password: process.env.REDIS_PASSWORD,
  retry_strategy: (options) => {
    const retryAfter = Math.min(options.attempt * 100, 3000);

    if (options.error && options.error.code === 'ECONNREFUSED') {
      console.log('Redis refused the connection');
      return new Error('Redis refused the connection');
    }
    if (options.total_retry_time > process.env.REDIS_TOTAL_RETRY_TIME) {
      console.log('Retry time exhausted');
      return new Error('Retry time exhausted');
    }
    if (options.attempt > process.env.REDIS_RETRY_ATTEMPTS) {
      console.log('Retry attempts exhausted');
      // End reconnecting with built in error
      return undefined;
    }
    // reconnect after
    console.log(`Retrying in ${retryAfter} milliseconds..`);

    return retryAfter;
  },
};


async function metricsApi() {
  const client = redis.createClient(redisArguments);
  const multi = client.multi();
  try {
    console.log(`
    Incoming Request!
    Api: /metrics
    `);
    multi.hgetall([process.env.REDIS_NAMESPACE, 'metric:get:path:count:h'].join(':'));
    multi.hgetall([process.env.REDIS_NAMESPACE, 'metric:set:path:count:h'].join(':'));
    multi.hgetall([process.env.REDIS_NAMESPACE, 'metric:migrate:path:count:h'].join(':'));
    const [getCountRes, setCountRes, migrateCountRes] = await multi.execAsync();
    const metrics = {
      getCount: getCountRes || {},
      setCount: setCountRes || {},
      migrateCount: migrateCountRes || {},
    };
    console.log(`Response: ${JSON.stringify(metrics)}`);
    return {
      statusCode: 200,
      body: `${JSON.stringify(metrics, null, 2)}\n`,
    };
  } catch (err) {
    console.log('Error while fetching stats', err);
    throw err;
  } finally {
    await client.quitAsync();
  }
}

async function mapsApi(event) {
  const client = redis.createClient(redisArguments);
  const multi = client.multi();
  try {
    const { path } = event;
    const url = `https://maps.googleapis.com${path}`;
    const requestParams = Object.assign({}, event.queryStringParameters);
    delete requestParams.key;

    console.log(`
    Incoming Request!
    Api: ${path},
    query: ${JSON.stringify(requestParams)}
    `);

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
      const statusText = 'Unauthorized';
      return {
        statusCode: 401,
        body: `${statusText}\n`,
      };
    }
    if (path === '/maps/api/timezone/json') {
      const latlong = query.location.split(',');
      try {
        const timezones = geoTimezone(latlong[0], latlong[1]);
        if (timezones.length) {
          console.log(`
          Timezone found!
          latLong: ${latlong},
          timezone: ${timezones}
          `);
          return {
            headers: {
              'Content-Type': 'application/json; charset=UTF-8',
            },
            statusCode: 200,
            body: `${JSON.stringify({ status: 'OK', timeZoneId: timezones[0] }, null, 2)}\n`,
          };
        }
      } catch (err) {
        console.log(`Error while looking for timezone of ${latlong} falling back to google`, err);
      }
    }

    const sha = crypto.createHash('sha1').update(urlString).digest('hex');
    const cacheKey = [process.env.REDIS_NAMESPACE, sha, 'j'].join(':');
    const migrateSha = crypto.createHash('sha1').update(
      [url, JSON.stringify(query)].join('#'),
    ).digest('hex');
    const migrateKey = ['cache-geo-cache', migrateSha, 'json'].join(':');
    multi.get(migrateKey);
    const [migrateContent] = await multi.execAsync();
    if (migrateContent) {
      multi.set(cacheKey, JSON.stringify(JSON.parse(migrateContent)));
      multi.del(migrateKey);
      multi.hincrby([process.env.REDIS_NAMESPACE, 'metric:migrate:path:count:h'].join(':'), path, 1);
      await multi.execAsync();
    }

    multi.get(cacheKey);
    multi.expire(cacheKey, process.env.EXPIRE_SECONDS);
    multi.hincrby([process.env.REDIS_NAMESPACE, 'metric:get:path:count:h'].join(':'), path, 1);

    const [cachedContent] = await multi.execAsync();
    const parsedContent = JSON.parse(cachedContent);
    if (parsedContent && parsedContent.status && lodash.includes(['OK', 'ZERO_RESULTS'], parsedContent.status)) {
      console.log(`
      Cache hit!
      Api: ${path},
      query: ${JSON.stringify(requestParams)},
      cache-key: ${cacheKey},
      `);
      const formattedContent = JSON.stringify(parsedContent);
      if (cachedContent !== formattedContent) {
        console.log('reformating', cacheKey);
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

    const urlQuery = `${url}?${Object.keys(authQuery)
      .map(key => [key, encodeURIComponent(authQuery[key])].join('='))
      .join('&')}`;
    const res = await fetch(urlQuery);
    if (res.status !== 200) {
      console.log(`
      Error!
      Api: ${path},
      query: ${JSON.stringify(requestParams)},
      status: ${res.status} ${res.statusText},
      `);
      return {
        statusCode: res.status,
        body: `${res.statusText}\n`,
      };
    }

    const fetchedContent = await res.json();
    const formattedContent = `${JSON.stringify(fetchedContent, null, 2)}\n`;
    if (!lodash.includes(['OK', 'ZERO_RESULTS'], fetchedContent.status)) {
      console.log(`
      Error from Google!
      Api: ${path},
      query: ${JSON.stringify(requestParams)},
      status: ${fetchedContent.status},
      response: ${JSON.stringify(formattedContent)}
      `);
    } else {
      const expireSeconds = lodash.includes(['ZERO_RESULTS'], fetchedContent.status)
        ? process.env.SHORT_EXPIRE_SECONDS
        : process.env.EXPIRE_SECONDS;
      console.log(`
      Expire seconds: ${expireSeconds},
      Api: ${path},
      query: ${JSON.stringify(requestParams)},
      cache-key: ${cacheKey},
      status: ${fetchedContent.status}
      `);
      if (path !== '/maps/api/timezone/json') {
        multi.setex(cacheKey, expireSeconds, JSON.stringify(fetchedContent));
        multi.hincrby([process.env.REDIS_NAMESPACE, 'metric:set:path:count:h'].join(':'), path, 1);
        await multi.execAsync();
      }
    }
    return {
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: formattedContent,
    };
  } catch (err) {
    console.log(err);
    throw err;
  } finally {
    console.log('Closing Redis connection');
    await client.quitAsync();
  }
}

/*
Lambda wrapper has been written to ensure that we get new relic on QA env
*/
function lambdaWrapper(event, context, callback, func) {
  if (process.env.NEW_RELIC_ACTIVATE === 'true') {
    // eslint-disable-next-line global-require
    const newrelic = require('newrelic');
    // eslint-disable-next-line global-require
    require('@newrelic/aws-sdk');
    newrelic.setLambdaHandler(() => func(event, context, callback));
  }
  return func(event, context, callback);
}
module.exports.mapsApi = (event, context, callback) => lambdaWrapper(event, context, callback, mapsApi);
module.exports.metricsApi = (event, context, callback) => lambdaWrapper(event, context, callback, metricsApi);
