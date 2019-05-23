const crypto = require('crypto');
const fetch = require('node-fetch');
const h = require('render-html-rpf');
const lodash = require('lodash');
const multiExecAsync = require('multi-exec-async');
const mapProperties = require('map-properties');
const geoTimezone = require('geo-tz');

module.exports = async (appx) => {
  const {
    config, client, api,
  } = appx;

  api.get('/stats', async (ctx) => {
    ctx.redirect('/metrics');
  });
  api.get('/metrics', async (ctx) => {
    const [getCountRes, setCountRes, migrateCountRes] = await multiExecAsync(client, (multi) => {
      multi.hgetall([config.redisNamespace, 'metric:get:path:count:h'].join(':'));
      multi.hgetall([config.redisNamespace, 'metric:set:path:count:h'].join(':'));
      multi.hgetall([config.redisNamespace, 'metric:migrate:path:count:h'].join(':'));
    });
    const getCount = mapProperties(getCountRes || {}, value => parseInt(value, 10));
    const setCount = mapProperties(setCountRes || {}, value => parseInt(value, 10));
    const migrateCount = mapProperties(migrateCountRes || {}, value => parseInt(value, 10));
    const metrics = { getCount, setCount, migrateCount };
    if (/(Mobile)/.test(ctx.get('user-agent'))) {
      ctx.body = h.page({
        title: 'gcache',
        heading: 'Metrics',
        content: [{
          name: 'pre',
          content: JSON.stringify(metrics, null, 2),
        },
        ],
        footerLink: 'https://github.com/evanx/geo-cache',
      });
    } else {
      ctx.body = metrics;
    }
  });
  api.get('/maps/api/*', async (ctx) => {
    const path = ctx.params[0];
    const url = `https://maps.googleapis.com/maps/api/${path}`;
    const query = Object.keys(ctx.query)
      .reduce((arr, key) => {
        arr[key] = ctx.query[key];
        return arr;
      }, {});
    const queryString = Object.keys(query).slice(0).sort().map(
      key => [key, encodeURIComponent(query[key])].join('='),
    )
      .join('&');
    const urlString = [url, queryString].join('?');
    const authQuery = Object.assign({}, { key: config.apiKey }, ctx.query, query);
    if (!authQuery.key) {
      ctx.statusCode = 401;
      const statusText = 'Unauthorized';
      ctx.body = `${statusText}\n`;
      return;
    }
    console.log(`
    Incoming Request!
    url: ${url},
    query: ${JSON.stringify(ctx.query)},
    urlString: ${urlString}
    `);
    if (path === 'timezone/json') {
      const latlong = query.latlong.split(',');
      const timezones = geoTimezone(latlong[0], latlong[1]);
      ctx.set('Content-Type', 'application/json; charset=UTF-8');
      ctx.body = `${JSON.stringify({status: 'OK', timezoneId: timezones[0]}, null, 2)}\n`;
      console.log(`
      Timezone found!
      url: ${url},
      timezone: ${timezones}
      `);
      return;
    }
    const sha = crypto.createHash('sha1').update(urlString).digest('hex');
    const cacheKey = [config.redisNamespace, sha, 'j'].join(':');
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
        multi.hincrby([config.redisNamespace, 'metric:migrate:path:count:h'].join(':'), path, 1);
      });
    }
    const [cachedContent] = await multiExecAsync(client, (multi) => {
      multi.get(cacheKey);
      multi.expire(cacheKey, config.expireSeconds);
      multi.hincrby([config.redisNamespace, 'metric:get:path:count:h'].join(':'), path, 1);
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
        ctx.set('Content-Type', 'application/json; charset=UTF-8');
        ctx.body = `${JSON.stringify(parsedContent, null, 2)}\n`;
        return;
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
      ctx.statusCode = res.status;
      ctx.body = `${res.statusText}\n`;
      return;
    }
    const fetchedContent = await res.json();
    const formattedContent = `${JSON.stringify(fetchedContent, null, 2)}\n`;
    ctx.set('Content-Type', 'application/json; charset=UTF-8');
    ctx.body = formattedContent;
    if (!lodash.includes(['OK', 'ZERO_RESULTS'], fetchedContent.status)) {
      console.log(`
      Error from Google!
      url: ${url},
      status: ${fetchedContent.status},
      response: ${JSON.stringify(formattedContent)}
      `);
    } else {
      const expireSeconds = lodash.includes(['ZERO_RESULTS'], fetchedContent.status)
        ? config.shortExpireSeconds
        : config.expireSeconds;
      console.log(`
      Expire seconds: ${expireSeconds},
      url: ${url}
      status: ${fetchedContent.status},
      `);
      await multiExecAsync(client, (multi) => {
        multi.setex(cacheKey, expireSeconds, JSON.stringify(fetchedContent));
        multi.hincrby([config.redisNamespace, 'metric:set:path:count:h'].join(':'), path, 1);
      });
    }
  });
};
