const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

function boot(localSession, legacySession) {
  const listeners = {};
  const connected = [];
  const local = { session: localSession };
  const on = (name) => ({ addListener(fn) { listeners[name] = fn; } });
  const chrome = {
    tabs: {
      query(_query, callback) { callback([]); },
      onActivated: { addListener() {} },
      onCreated: on('created'),
      onRemoved: on('removed'),
      onUpdated: on('updated')
    },
    alarms: { create() {}, onAlarm: on('alarm') },
    runtime: {
      onStartup: on('startup'),
      onMessage: on('message'),
      sendMessage() { return Promise.resolve(); }
    },
    storage: {
      local: {
        setAccessLevel() { return Promise.resolve(); },
        get(_key, callback) { queueMicrotask(() => callback({ session: local.session })); },
        set(value) { Object.assign(local, value); return Promise.resolve(); }
      },
      session: {
        get(_key, callback) { queueMicrotask(() => callback({ session: legacySession })); }
      }
    }
  };
  const transport = {
    connect(config) { connected.push(config); return Promise.resolve(); },
    disconnect() {},
    isConnected() { return true; },
    send() { return Promise.resolve(true); },
    onStatus() {},
    onMessage() {}
  };
  const context = { chrome, CouchTransport: transport, crypto: webcrypto, importScripts() {},
    Uint8Array, Promise, Date, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'extension', 'background.js'), 'utf8'), context);
  function message(type) {
    return new Promise((resolve) => listeners.message({ type }, {}, resolve));
  }
  return { local, connected, message };
}

test('extension restores a saved pairing before answering popup requests', async () => {
  const saved = { id: 'saved123', token: 'aa'.repeat(32), created: 1 };
  const app = boot(saved, null);
  const response = await app.message('getSession');
  assert.equal(response.session.id, saved.id);
  assert.equal(app.connected[0].token, saved.token);
  const renewed = await app.message('newSession');
  assert.notEqual(renewed.session.id, saved.id);
  assert.equal(app.local.session.id, renewed.session.id);
});

test('extension migrates a pairing from temporary storage', async () => {
  const saved = { id: 'legacy123', token: 'bb'.repeat(32), created: 1 };
  const app = boot(null, saved);
  const response = await app.message('getSession');
  assert.equal(response.session.id, saved.id);
  assert.equal(app.local.session.id, saved.id);
});
