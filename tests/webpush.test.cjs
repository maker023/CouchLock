const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

function load(fetchImpl) {
  const context = { crypto: webcrypto, TextEncoder, URL, DataView, Uint8Array, Promise, Date, btoa, atob, fetch: fetchImpl };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'extension', 'webpush.js'), 'utf8') + ';this.CouchPush = CouchPush;', context);
  return context.CouchPush;
}

const b64url = (bytes) => Buffer.from(bytes).toString('base64url');

// RFC 8291 Appendix A
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  serverPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  serverPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN'
};

test('payload encryption reproduces the RFC 8291 test vector byte for byte', async () => {
  const push = load();
  const body = await push.encrypt({ p256dh: RFC.p256dh, auth: RFC.auth }, new TextEncoder().encode(RFC.plaintext),
    { salt: RFC.salt, serverPublic: RFC.serverPublic, serverPrivate: RFC.serverPrivate });
  assert.equal(b64url(body), RFC.body);
});

test('VAPID header is a valid ES256 JWT for the push service origin', async () => {
  const push = load();
  const vapid = await push.createVapidKeys();
  const header = await push.vapidAuth('https://web.push.apple.com/abc123', vapid);
  const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
  assert.ok(match);
  const claims = JSON.parse(Buffer.from(match[2], 'base64url').toString());
  assert.equal(claims.aud, 'https://web.push.apple.com');
  assert.ok(claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 24 * 3600);
  assert.match(claims.sub, /^https:\/\//);
  assert.equal(match[4], vapid.publicKey);
  const publicKey = await webcrypto.subtle.importKey('raw', Buffer.from(vapid.publicKey, 'base64url'),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const valid = await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey,
    Buffer.from(match[3], 'base64url'), Buffer.from(match[1] + '.' + match[2]));
  assert.equal(valid, true);
});

test('send posts an encrypted body and reports a dropped subscription as gone', async () => {
  const requests = [];
  const push = load((url, init) => {
    requests.push({ url, init });
    return Promise.resolve({ ok: false, status: 410, text: () => Promise.resolve('{"reason":"Unregistered"}') });
  });
  const vapid = await push.createVapidKeys();
  const phone = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const p256dh = b64url(new Uint8Array(await webcrypto.subtle.exportKey('raw', phone.publicKey)));
  const result = await push.send({ endpoint: 'https://web.push.apple.com/x', keys: { p256dh, auth: b64url(webcrypto.getRandomValues(new Uint8Array(16))) } },
    { kind: 'skipAd', title: 'Ad can be skipped' }, vapid, { ttl: 30 });
  assert.deepEqual({ ...result }, { ok: false, status: 410, gone: true, reason: '{"reason":"Unregistered"}' });
  const { headers, body } = requests[0].init;
  assert.equal(headers['Content-Encoding'], 'aes128gcm');
  assert.equal(headers.TTL, '30');
  assert.equal(headers.Topic, undefined); // Apple rejects any Topic: 400 BadWebPushTopic
  assert.equal(body[20], 65); // keyid length: the one-off server public key
  assert.ok(!Buffer.from(body).toString().includes('Ad can be skipped'));
});

test('a request that never reaches the push service reports why', async () => {
  const push = load(() => Promise.reject(new TypeError('Failed to fetch')));
  const vapid = await push.createVapidKeys();
  const phone = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const p256dh = b64url(new Uint8Array(await webcrypto.subtle.exportKey('raw', phone.publicKey)));
  const result = await push.send({ endpoint: 'https://web.push.apple.com/x', keys: { p256dh, auth: b64url(new Uint8Array(16)) } }, {}, vapid);
  assert.deepEqual({ ...result }, { ok: false, status: 0, gone: false, reason: 'Failed to fetch' });
});
