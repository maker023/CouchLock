const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

function boot(localSession, legacySession, mediaSnapshot, options = {}) {
  const listeners = {};
  const connected = [];
  const disconnects = [];
  const sent = [];
  const tabMessages = [];
  const deliveries = [];
  const revoked = [];
  const windowUpdates = [];
  const timers = [];
  let activeId = 7;
  let windowState = 'maximized';
  let prepareReplies = 0;
  const injections = [];
  const local = { session: localSession };
  const on = (name) => ({ addListener(fn) { listeners[name] = fn; } });
  const chrome = {
    tabs: {
      query(_query, callback) { callback([{ id: activeId, windowId: 1 }]); },
      update(tabId, _update, callback) { activeId = tabId; callback(); },
      create() {},
      sendMessage(tabId, msg, options, callback) {
        if (typeof options === 'function') { callback = options; options = {}; }
        tabMessages.push(msg);
        deliveries.push({ tabId, msg, options });
        if (msg.action === 'requestMediaStatus' && mediaSnapshot) {
          listeners.message(mediaSnapshot, { tab: { id: tabId, title: 'Playing episode' }, frameId: 3 }, () => {});
        }
        if (msg.action === 'preparePlayerExpand') {
          prepareReplies++;
          if (callback) callback(optionsForBoot.staleContent && prepareReplies === 1 ? undefined : { ready: true });
        } else if (callback) callback();
      },
      onActivated: on('activated'),
      onCreated: on('created'),
      onRemoved: on('removed'),
      onUpdated: on('updated')
    },
    alarms: { create() {}, onAlarm: on('alarm') },
    windows: {
      WINDOW_ID_NONE: -1,
      get(_id, callback) { callback({ state: windowState }); },
      update(id, update, callback) {
        windowUpdates.push({ id, ...update });
        windowState = update.state;
        if (options.onWindowUpdate) options.onWindowUpdate(listeners);
        if (options.windowError && update.state === 'fullscreen') chrome.runtime.lastError = { message: 'Window unavailable' };
        if (callback) callback();
        chrome.runtime.lastError = null;
      },
      onFocusChanged: on('focus'), onBoundsChanged: on('bounds')
    },
    scripting: { executeScript(config) { injections.push(config); return Promise.resolve([]); } },
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
        get(_key, callback) {
          queueMicrotask(() => callback({ session: local.session, retiredTokens: local.retiredTokens }));
        },
        set(value) { Object.assign(local, value); return Promise.resolve(); }
      },
      session: {
        get(_key, callback) { queueMicrotask(() => callback({ session: legacySession })); },
        set() { return Promise.resolve(); }
      }
    }
  };
  const optionsForBoot = options;
  const transport = {
    connect(config) { connected.push(config); return Promise.resolve(); },
    disconnect(presence) { disconnects.push(presence); },
    isConnected() { return true; },
    checkAlive() {},
    send(msg) { sent.push(msg); return Promise.resolve(true); },
    revokeToken(token) { revoked.push(token); return Promise.resolve(true); },
    onStatus(fn) { listeners.status = fn; },
    onMessage(fn) { listeners.transport = fn; },
    onPresence() {}
  };
  const context = { chrome, CouchTransport: transport, crypto: webcrypto, importScripts() {},
    Uint8Array, Promise, Date,
    setTimeout(fn, ms) { const timer = { fn, ms }; timers.push(timer); return timer; },
    clearTimeout(timer) { if (timer) timer.cancelled = true; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'extension', 'background.js'), 'utf8'), context);
  function message(type) {
    return new Promise((resolve) => listeners.message({ type }, {}, resolve));
  }
  return {
    local, connected, disconnects, sent, tabMessages, deliveries, revoked, message, windowUpdates, timers, listeners, injections,
    setWindowState(state) { windowState = state; },
    relay: (status) => listeners.status(status),
    phone: (msg) => listeners.transport(msg),
    fromTab: (tabId, msg, frameId = 0, url = 'https://example.com/') => listeners.message(msg, { tab: { id: tabId, url, title: 'Playing episode' }, frameId }, () => {})
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

test('a paused main player is not overwritten by a small playing preview in another frame', async () => {
  const app = boot({ token: 'aa'.repeat(32) });
  await app.message('getSession');
  app.fromTab(7, { type: 'mediaStatus', platform: 'netflix', title: 'Episode', playing: true, mediaArea: 921600 }, 3);
  app.fromTab(7, { type: 'mediaStatus', platform: 'universal', title: 'Preview', playing: true, mediaArea: 10000 }, 4);
  app.fromTab(7, { type: 'mediaStatus', platform: 'netflix', title: 'Episode', playing: false, mediaArea: 921600 }, 3);
  assert.equal(app.sent.at(-1).title, 'Episode');
  assert.equal(app.sent.at(-1).playing, false);
  app.phone({ type: 'cmd', action: 'playPause' });
  assert.equal(app.deliveries.at(-1).options.frameId, 3);
});

test('reconnect discards a vanished playing frame and replays every action flag', async () => {
  const snapshot = { type: 'mediaStatus', platform: 'youtube', title: 'New video', playing: false,
    skipAdAvailable: true, skipIntroAvailable: true, nextEpisodeAvailable: true };
  const app = boot({ token: 'aa'.repeat(32) }, null, snapshot);
  await app.message('getSession');
  app.fromTab(7, { type: 'mediaStatus', platform: 'universal', title: 'Removed', playing: true, mediaArea: 2000000 }, 4);
  app.phone({ type: 'request_media_status' });
  const state = app.sent.at(-1);
  assert.equal(state.title, 'New video');
  assert.equal(state.playing, false);
  assert.equal(state.skipAdAvailable, true);
  assert.equal(state.skipIntroAvailable, true);
  assert.equal(state.nextEpisodeAvailable, true);
});

test('switching browser tabs clears stale media and immediately queries the new tab', async () => {
  const app = boot({ token: 'aa'.repeat(32), pairedAt: 1 });
  await app.message('getSession');
  app.phone({ type: 'tab_switch', tabId: 9 });
  assert.equal(app.sent.at(-1).platform, 'unknown');
  assert.ok(app.deliveries.some((d) => d.tabId === 9 && d.msg.action === 'requestMediaStatus'));
});

test('Star embedded video uses next-episode availability from the parent page', async () => {
  const app = boot({ token: 'aa'.repeat(32) });
  await app.message('getSession');
  app.fromTab(7, { type: 'mediaStatus', platform: 'unknown', nextEpisodeAvailable: true }, 0, 'https://www.star.gr/tv/episode');
  app.fromTab(7, { type: 'mediaStatus', platform: 'universal', playing: true }, 3, 'https://www.star.gr/tv/episode');
  assert.equal(app.sent.at(-1).platform, 'star');
  assert.equal(app.sent.at(-1).nextEpisodeAvailable, true);
  app.phone({ type: 'cmd', action: 'nextEpisode' });
  assert.equal(app.deliveries.at(-1).options.frameId, 0);
});

test('fullscreen restores the original window after a missing player or an expansion timeout', async () => {
  for (const failure of ['no_media', 'timeout', 'window']) {
    const app = boot({ token: 'aa'.repeat(32) }, null, null, { windowError: failure === 'window' });
    await app.message('getSession');
    app.phone({ type: 'cmd', action: 'fullscreen' });
    if (failure === 'no_media') {
      const expand = app.deliveries.find((d) => d.msg.action === 'playerExpand');
      app.fromTab(7, { type: 'playerExpandFailed', token: expand.msg.token, reason: failure });
    } else if (failure === 'timeout') {
      app.timers.find((timer) => timer.ms === 5000 && !timer.cancelled).fn();
    }
    assert.deepEqual(app.windowUpdates.map((u) => u.state), ['fullscreen', 'maximized'], failure);
    assert.ok(app.tabMessages.some((m) => m.action === 'playerRestore'), failure);
    assert.equal(app.sent.at(-1).success, false, failure);
  }
});

test('fullscreen confirms the top frame and restores when laptop exits fullscreen', async () => {
  const app = boot({ token: 'aa'.repeat(32) });
  await app.message('getSession');
  app.phone({ type: 'cmd', action: 'fullscreen' });
  const expand = app.deliveries.find((d) => d.msg.action === 'playerExpand');
  app.fromTab(7, { type: 'playerExpanded', token: expand.msg.token });
  assert.equal(app.sent.at(-1).success, true);
  assert.ok(app.timers.find((timer) => timer.ms === 5000).cancelled);
  app.setWindowState('normal');
  app.listeners.bounds({ id: 1, state: 'normal' });
  app.timers.filter((timer) => timer.ms === 200 && !timer.cancelled).at(-1).fn();
  assert.equal(app.windowUpdates.at(-1).state, 'maximized');
  assert.ok(app.tabMessages.some((m) => m.action === 'playerRestore'));
});

test('a stale window notification does not undo fullscreen and frame selection stays fixed through resize', async () => {
  const app = boot({ token: 'aa'.repeat(32) }, null, null, {
    onWindowUpdate(listeners) {
      listeners.bounds({ id: 1, state: 'maximized' });
      listeners.message({ type: 'mediaStatus', platform: 'universal', playing: true, mediaArea: 2000000 },
        { tab: { id: 7 }, frameId: 4 }, () => {});
    }
  });
  await app.message('getSession');
  app.fromTab(7, { type: 'mediaStatus', platform: 'star', mediaArea: 400000 }, 0);
  app.phone({ type: 'cmd', action: 'fullscreen' });
  const expand = app.deliveries.find((d) => d.msg.action === 'playerExpand');
  assert.equal(expand.options.frameId, 0, 'resize must not redirect expansion into another player');
  app.fromTab(7, { type: 'playerExpanded', token: expand.msg.token });
  app.listeners.bounds({ id: 1, state: 'maximized' });
  app.timers.filter((timer) => timer.ms === 200 && !timer.cancelled).at(-1).fn();
  assert.deepEqual(app.windowUpdates.map((u) => u.state), ['fullscreen']);
  assert.ok(!app.tabMessages.some((m) => m.action === 'playerRestore'));
});

test('fullscreen refreshes stale content scripts before entering the window', async () => {
  const app = boot({ token: 'aa'.repeat(32) }, null, null, { staleContent: true });
  await app.message('getSession');
  app.phone({ type: 'cmd', action: 'fullscreen' });
  assert.equal(app.windowUpdates.length, 0, 'wait for the player to acknowledge preparation');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.injections.length, 1);
  assert.equal(app.injections[0].files[0], 'content.js');
  assert.equal(app.windowUpdates[0].state, 'fullscreen');
  const prepare = app.deliveries.find((d) => d.msg.action === 'preparePlayerExpand');
  assert.equal(prepare.options.frameId, 0);
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

test('automatic reconnect fetches the playing title from all frames without toggling playback', async () => {
  const saved = { id: 'saved123', token: 'aa'.repeat(32), created: 1, pairedAt: 5 };
  const snapshot = { type: 'mediaStatus', platform: 'universal', title: 'Current episode', playing: true, currentTime: 120, duration: 1800 };
  const app = boot(saved, null, snapshot);
  await app.message('getSession');
  for (let reconnect = 0; reconnect < 2; reconnect++) {
    app.tabMessages.length = 0;
    app.deliveries.length = 0;
    app.phone({ type: 'hello', token: saved.token });
    const request = app.deliveries.find((entry) => entry.msg.action === 'requestMediaStatus');
    assert.ok(request, 'every hello requests current media');
    assert.equal(request.tabId, 7);
    assert.deepEqual(Object.keys(request.options), [], 'broadcast to embedded players too');
    const status = app.sent.filter((msg) => msg.type === 'media_status').at(-1);
    assert.equal(status.title, snapshot.title);
    assert.equal(status.playing, true);
    assert.equal(status.currentTime, 120);
    assert.ok(!app.tabMessages.some((msg) => msg.command === 'playPause'));
  }
});

test('media with an empty title uses the active browser tab title', async () => {
  const app = boot({ id: 'saved123', token: 'aa'.repeat(32), created: 1 }, null);
  await app.message('getSession');
  app.fromTab(7, { type: 'mediaStatus', platform: 'universal', playing: true, title: '  ' });
  assert.equal(app.sent.at(-1).title, 'Playing episode');
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

test('forgotten tokens are revoked again every time the relay connects', async () => {
  const saved = { id: 'saved123', token: 'aa'.repeat(32), created: 1, pairedAt: 5 };
  const app = boot(saved, null);
  await app.message('getSession');
  const renewed = await app.message('newSession');
  assert.deepEqual(Array.from(app.local.retiredTokens), [saved.token]);

  app.relay('connected');
  assert.deepEqual(app.revoked, [saved.token]);
  assert.ok(!app.revoked.includes(renewed.session.token), 'the live pairing is never revoked');

  app.revoked.length = 0;
  app.relay('connected'); // e.g. after laptop sleep
  assert.deepEqual(app.revoked, [saved.token]);
});
