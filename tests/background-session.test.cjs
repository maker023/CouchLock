const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

function boot(localSession, legacySession) {
  const listeners = {};
  const connected = [];
  const disconnects = [];
  const sent = [];
  const tabMessages = [];
  const local = { session: localSession };
  const on = (name) => ({ addListener(fn) { listeners[name] = fn; } });
  const chrome = {
    tabs: {
      query(_query, callback) { callback([{ id: 7, windowId: 1 }]); },
      create() {},
      sendMessage(tabId, msg, options, callback) {
        tabMessages.push(msg);
        if (callback) callback();
      },
      onActivated: { addListener() {} },
      onCreated: on('created'),
      onRemoved: on('removed'),
      onUpdated: on('updated')
    },
    alarms: { create() {}, onAlarm: on('alarm') },
    windows: { WINDOW_ID_NONE: -1, get() {}, update() {}, onFocusChanged: on('focus') },
    scripting: { executeScript() { return Promise.resolve([]); } },
    runtime: {
      lastError: null,
      onStartup: on('startup'),
      onInstalled: on('installed'),
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
        get(_key, callback) { queueMicrotask(() => callback({ session: legacySession })); },
        set() { return Promise.resolve(); }
      }
    }
  };
  const transport = {
    connect(config) { connected.push(config); return Promise.resolve(); },
    disconnect(presence) { disconnects.push(presence); },
    isConnected() { return true; },
    checkAlive() {},
    send(msg) { sent.push(msg); return Promise.resolve(true); },
    onStatus() {},
    onMessage(fn) { listeners.transport = fn; },
    onPresence() {}
  };
  const context = { chrome, CouchTransport: transport, crypto: webcrypto, importScripts() {},
    Uint8Array, Promise, Date, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'extension', 'background.js'), 'utf8'), context);
  function message(type) {
    return new Promise((resolve) => listeners.message({ type }, {}, resolve));
  }
  return {
    local, connected, disconnects, sent, tabMessages, message,
    phone: (msg) => listeners.transport(msg),
    fromTab: (tabId, msg) => listeners.message(msg, { tab: { id: tabId, url: 'https://example.com/' }, frameId: 0 }, () => {})
  };
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

test('extension announces presence and revokes the old pairing when forgetting the phone', async () => {
  const saved = { id: 'saved123', token: 'aa'.repeat(32), created: 1, pairedAt: 5 };
  const app = boot(saved, null);
  await app.message('getSession');
  assert.equal(app.connected[0].presence, 'announce');
  await app.message('newSession');
  assert.deepEqual(app.disconnects, ['x'], 'phones holding the old token see it revoked');
  assert.equal(app.local.session.pairedAt, undefined);
});

test('disconnecting keeps the pairing and ignores the phone until it says hello again', async () => {
  const saved = { id: 'saved123', token: 'aa'.repeat(32), created: 1, pairedAt: 5 };
  const app = boot(saved, null);
  await app.message('getSession');
  await app.message('pausePhone');
  assert.equal(app.local.session.token, saved.token);
  assert.equal(app.local.session.paused, true);
  assert.ok(app.sent.some((m) => m.type === 'session_paused'));

  app.tabMessages.length = 0;
  app.phone({ type: 'cmd', action: 'playPause' });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(app.tabMessages.length, 0, 'commands from a disconnected phone are dropped');

  app.phone({ type: 'hello', token: saved.token });
  assert.equal(app.local.session.paused, false);
  assert.ok(app.sent.some((m) => m.type === 'ready'));
});

test('media status only comes from the tab the remote is driving', async () => {
  const app = boot({ id: 'saved123', token: 'aa'.repeat(32), created: 1 }, null);
  await app.message('getSession');
  const status = { type: 'mediaStatus', platform: 'universal', playing: true, title: 't' };
  app.fromTab(9, status); // video in another window's tab
  assert.equal(app.sent.filter((m) => m.type === 'media_status').length, 0);
  app.fromTab(7, status); // active tab of the last-focused window
  assert.equal(app.sent.filter((m) => m.type === 'media_status').length, 1);
});

test('disconnecting from the phone keeps the pairing without echoing back', async () => {
  const saved = { id: 'saved123', token: 'aa'.repeat(32), created: 1, pairedAt: 5 };
  const app = boot(saved, null);
  await app.message('getSession');
  app.phone({ type: 'session_pause' });
  assert.equal(app.local.session.paused, true);
  assert.equal(app.local.session.token, saved.token);
  assert.equal(app.sent.some((m) => m.type === 'session_paused'), false);
  app.phone({ type: 'hello', token: saved.token });
  assert.equal(app.local.session.paused, false);
});
