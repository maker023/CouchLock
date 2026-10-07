const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Broker, loadContext, waitFor } = require('./fake-broker.cjs');

const GRANT = { token: 'cd'.repeat(32), sessionId: 'sess1' };

function setup(phoneIp) {
  const broker = new Broker();
  const laptop = loadContext(broker).CouchDiscovery;
  const phoneCtx = phoneIp
    ? loadContext(broker, { fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ ip: phoneIp }) }) })
    : loadContext(broker);
  return { laptop, phone: phoneCtx.CouchDiscovery };
}

test('phone on the same network finds the laptop and pairs after confirmation', async () => {
  const { laptop, phone } = setup();
  const requests = [];
  const host = laptop.host({ name: 'Chrome on Windows', code: '123456', onRequest: (r) => requests.push(r) });

  const hosts = [];
  const finder = phone.find({ name: 'iPhone', onHost: (h) => hosts.push(h) });
  await waitFor(() => hosts.length);
  assert.equal(hosts[0].name, 'Chrome on Windows');

  let phoneCode = null;
  const paired = finder.pair(hosts[0].id, (code) => { phoneCode = code; });
  await waitFor(() => requests.length && phoneCode);
  assert.equal(requests[0].name, 'iPhone');
  assert.match(requests[0].code, /^\d{4}$/);
  assert.equal(requests[0].code, phoneCode, 'both screens show the same code');

  requests[0].accept(GRANT);
  assert.deepEqual({ ...(await paired) }, GRANT);
  finder.stop();
  host.stop();
});

test('the 6-digit code reaches the laptop from another network', async () => {
  const { laptop, phone } = setup('198.51.100.1');
  const requests = [];
  const host = laptop.host({ name: 'Laptop', code: '654321', onRequest: (r) => requests.push(r) });

  const nearby = [];
  const search = phone.find({ name: 'iPhone', onHost: (h) => nearby.push(h) });
  const viaCode = [];
  const finder = phone.find({ name: 'iPhone', code: '654321', onHost: (h) => viaCode.push(h) });
  await waitFor(() => viaCode.length);
  assert.equal(nearby.length, 0, 'a different public IP never matches');

  let phoneCode = null;
  const paired = finder.pair(viaCode[0].id, (code) => { phoneCode = code; });
  await waitFor(() => requests.length && phoneCode);
  requests[0].accept(GRANT);
  assert.equal((await paired).token, GRANT.token);
  search.stop();
  finder.stop();
  host.stop();
});

test('declining on the laptop rejects the phone and sends no token', async () => {
  const { laptop, phone } = setup();
  const requests = [];
  const host = laptop.host({ name: 'Laptop', code: '111111', onRequest: (r) => requests.push(r) });
  const hosts = [];
  const finder = phone.find({ name: 'Phone', onHost: (h) => hosts.push(h) });
  await waitFor(() => hosts.length);
  const paired = finder.pair(hosts[0].id, () => {});
  await waitFor(() => requests.length);
  requests[0].decline();
  await assert.rejects(paired, /denied/);
  finder.stop();
  host.stop();
});
