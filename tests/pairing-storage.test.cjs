const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = html.indexOf('  var PAIRING_KEY =');
const end = html.indexOf('  restorePairing();', start);
assert.ok(start > 0 && end > start, 'pairing storage functions are present');
const source = html.slice(start, end);

function page(sharedCookies, localData, token, sessionId) {
  const document = {
    get cookie() { return Object.entries(sharedCookies).map(([key, value]) => `${key}=${value}`).join('; '); },
    set cookie(value) {
      const [name, encoded] = value.split(';')[0].split('=');
      if (value.includes('Max-Age=0')) delete sharedCookies[name];
      else sharedCookies[name] = encoded;
    }
  };
  const context = {
    token,
    sessionId,
    document,
    window: { location: { pathname: '/CouchLock/index.html', search: '' } },
    localStorage: {
      getItem(key) { return localData[key] || null; },
      setItem(key, value) { localData[key] = value; },
      removeItem(key) { delete localData[key]; }
    },
    history: { replaceState() {} },
    URLSearchParams,
    JSON,
    encodeURIComponent,
    decodeURIComponent
  };
  vm.runInNewContext(source, context);
  return context;
}

test('a new Home Screen storage partition restores pairing from the copied cookie', () => {
  const cookies = {};
  const browserStorage = {};
  const token = 'cc'.repeat(32);
  const browser = page(cookies, browserStorage, token, 'phone123');
  browser.savePairing();
  assert.ok(browserStorage['couchlock-pairing-v1']);
  assert.ok(cookies['couchlock-pairing-v1']);

  const standaloneStorage = {};
  const installed = page(cookies, standaloneStorage, null, null);
  installed.restorePairing();
  assert.equal(installed.token, token);
  assert.equal(installed.sessionId, 'phone123');
  assert.ok(standaloneStorage['couchlock-pairing-v1']);

  installed.clearPairing();
  assert.equal(installed.token, null);
  assert.equal(cookies['couchlock-pairing-v1'], undefined);
  assert.equal(standaloneStorage['couchlock-pairing-v1'], undefined);
});
