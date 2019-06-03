const crypto = require('crypto');
const redis = require('redis');
const fetch = require('node-fetch');
const h = require('render-html-rpf');
const lodash = require('lodash');
const multiExecAsync = require('multi-exec-async');
const mapProperties = require('map-properties');
const geoTimezone = require('geo-tz');

const client = redis.createClient({
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT,
  password: process.env.REDIS_PASSWORD,
});

async function metricsApi() {
  const [getCountRes, setCountRes, migrateCountRes] = await multiExecAsync(client, (multi) => {
    multi.hgetall([process.env.REDIS_NAMESPACE, 'metric:get:path:count:h'].join(':'));
    multi.hgetall([process.env.REDIS_NAMESPACE, 'metric:set:path:count:h'].join(':'));
    multi.hgetall([process.env.REDIS_NAMESPACE, 'metric:migrate:path:count:h'].join(':'));
  });
  const getCount = mapProperties(getCountRes || {}, value => parseInt(value, 10));
  const setCount = mapProperties(setCountRes || {}, value => parseInt(value, 10));
  const migrateCount = mapProperties(migrateCountRes || {}, value => parseInt(value, 10));
  const metrics = { getCount, setCount, migrateCount };

  return {
    statusCode: 200,
    body: metrics,
  };
}

async function mapsApi(event) {
  const { path } = event;
  const url = `https://maps.googleapis.com${path}`;
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
  console.log(`
  Incoming Request!
  url: ${url},
  query: ${JSON.stringify(query)},
  urlString: ${urlString}
  `);
  if (path === '/maps/api/timezone/json') {
    const latlong = query.location.split(',');
    try {
      const timezones = geoTimezone(latlong[0], latlong[1]);
      if (timezones.length) {
        console.log(`
        Timezone found!
        url: ${url},
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
      console.log('Error', err);
    }
  }
  const sha = crypto.createHash('sha1').update(urlString).digest('hex');
  const cacheKey = [process.env.REDIS_NAMESPACE, sha, 'j'].join(':');
  const migrateSha = crypto.createHash('sha1').update(
    [url, JSON.stringify(query)].join('#'),
  ).digest('hex');
  const migrateKey = ['cache-geo-cache', migrateSha, 'json'].join(':');
  const [migrateContent] = await multiExecAsync(client, (multi) => {
    multi.get(migrateKey);
  });
  if (migrateContent) {
    await multiExecAsync(client, (multi) => {
      multi.set(cacheKey, JSON.stringify(JSON.parse(migrateContent)));
      multi.del(migrateKey);
      multi.hincrby([process.env.REDIS_NAMESPACE, 'metric:migrate:path:count:h'].join(':'), path, 1);
    });
  }
  const [cachedContent] = await multiExecAsync(client, (multi) => {
    multi.get(cacheKey);
    multi.expire(cacheKey, process.env.EXPIRE_SECONDS);
    multi.hincrby([process.env.REDIS_NAMESPACE, 'metric:get:path:count:h'].join(':'), path, 1);
  });
  if (cachedContent) {
    console.log(`
    Cache hit!
    url: ${url},
    hash: ${sha},
    cache-key: ${cacheKey}
    `);
    const parsedContent = JSON.parse(cachedContent);
    const formattedContent = JSON.stringify(parsedContent);
    if (cachedContent !== formattedContent) {
      console.log('reformat', cacheKey);
      await multiExecAsync(client, (multi) => {
        multi.set(cacheKey, formattedContent);
      });
    }
    if (lodash.includes(['OK', 'ZERO_RESULTS'], parsedContent.status)) {
      return {
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
        },
        body: `${JSON.stringify(parsedContent, null, 2)}\n`,
      };
    }
  }
  const urlQuery = `${url}?${Object.keys(authQuery)
    .map(key => [key, encodeURIComponent(authQuery[key])].join('='))
    .join('&')}`;
  const res = await fetch(urlQuery);
  if (res.status !== 200) {
    console.log(`
    Error!
    url: ${url},
    status: ${res.status} ${res.statusText},
    query: ${JSON.stringify(query)}
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
    url: ${url},
    status: ${fetchedContent.status},
    response: ${JSON.stringify(formattedContent)}
    `);
  } else {
    const expireSeconds = lodash.includes(['ZERO_RESULTS'], fetchedContent.status)
      ? process.env.SHORT_EXPIRE_SECONDS
      : process.env.EXPIRE_SECONDS;
    console.log(`
    Expire seconds: ${expireSeconds},
    url: ${url}
    status: ${fetchedContent.status},
    `);
    if (path !== 'timezone/json') {
      await multiExecAsync(client, (multi) => {
        multi.setex(cacheKey, expireSeconds, JSON.stringify(fetchedContent));
        multi.hincrby([process.env.REDIS_NAMESPACE, 'metric:set:path:count:h'].join(':'), path, 1);
      });
    }
  }
  return {
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: formattedContent,
  };
}


module.exports = {
  mapsApi,
  metricsApi,
};
