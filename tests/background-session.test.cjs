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
  const local = { session: localSession, pushTarget: options.pushTarget, vapid: options.vapid };
  const sessionStore = { session: legacySession };
  const pushes = [];
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
    scripting: {
      executeScript(config) {
        injections.push(config);
        const poster = config.func && config.func.name === 'findPosterURL' && options.posterURL;
        return Promise.resolve(poster ? [{ result: options.posterURL }] : []);
      }
    },
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
          queueMicrotask(() => callback({ session: local.session, retiredTokens: local.retiredTokens,
            pushTarget: local.pushTarget, vapid: local.vapid }));
        },
        set(value) { Object.assign(local, value); return Promise.resolve(); }
      },
      session: {
        get(_key, callback) { queueMicrotask(() => callback({ ...sessionStore })); },
        set(value) { Object.assign(sessionStore, value); return Promise.resolve(); }
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
  const push = {
    createVapidKeys() { return Promise.resolve({ publicKey: 'new-key', privateJwk: {} }); },
    send(subscription, note, vapid, sendOptions) {
      pushes.push({ subscription, note, vapid, options: sendOptions });
      return Promise.resolve(options.pushResult || { ok: true, status: 201, gone: false });
    }
  };
  const fetches = [];
  const canvases = [];
  const context = { chrome, CouchTransport: transport, CouchPush: push, crypto: webcrypto, importScripts() {}, URL, btoa,
    fetch(url, init) {
      fetches.push({ url, init });
      if (options.unreachable && url.startsWith(options.unreachable)) return Promise.reject(new TypeError('Failed to fetch'));
      return Promise.resolve({ ok: true, status: 200, blob: () => Promise.resolve({ size: 2048 }) });
    },
    createImageBitmap() { return Promise.resolve({ width: 640, height: 360, close() {} }); },
    OffscreenCanvas: function (width, height) {
      canvases.push({ width, height });
      this.getContext = () => ({ drawImage() {} });
      this.convertToBlob = () => Promise.resolve({ arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer) });
    },
    Uint8Array, Promise, Date,
    setTimeout(fn, ms) { const timer = { fn, ms }; timers.push(timer); return timer; },
    clearTimeout(timer) { if (timer) timer.cancelled = true; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'extension', 'background.js'), 'utf8'), context);
  function message(type) {
    return new Promise((resolve) => listeners.message({ type }, {}, resolve));
  }
  return {
    context, fetches, canvases, local, sessionStore, pushes, connected, disconnects, sent, tabMessages, deliveries, revoked, message, windowUpdates, timers, listeners, injections,
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

// ── Phone notifications ──

const PAIRED = { id: 'paired1', token: 'aa'.repeat(32), created: 1, pairedAt: 1 };
const SUB = { endpoint: 'https://web.push.apple.com/QGx', keys: { p256dh: 'p256', auth: 'auth' } };
const VAPID = { publicKey: 'k1', privateJwk: {} };
const MEDIA = { type: 'mediaStatus', platform: 'netflix', title: 'Ep 1', mediaKey: 'ep1', playing: true, mediaArea: 921600 };
const settle = () => new Promise((resolve) => setImmediate(resolve));
const notes = (app) => app.sent.filter((msg) => msg.type === 'notify');
const plain = (value) => JSON.parse(JSON.stringify(value)); // sandbox objects have another realm's prototypes

test('an on-screen phone gets one in-app message per playback moment, not a push', async () => {
  const app = boot(PAIRED, null, null, { vapid: VAPID, pushTarget: { subscription: SUB, prefs: {} } });
  await app.message('getSession');
  app.phone({ type: 'phone_state', visible: true });
  app.fromTab(7, { ...MEDIA, skipIntroAvailable: true });
  app.fromTab(7, { ...MEDIA, skipIntroAvailable: true });
  app.fromTab(7, { ...MEDIA, skipIntroAvailable: false });
  app.fromTab(7, { ...MEDIA, skipIntroAvailable: true }); // flicker inside the cooldown
  await settle();
  assert.deepEqual(notes(app).map((n) => [n.kind, n.title, n.body]), [['skipIntro', 'Intro can be skipped', 'Ep 1']]);
  assert.equal(app.pushes.length, 0);
});

test('an off-screen phone gets a push to its synced subscription, minus muted kinds', async () => {
  const app = boot(PAIRED, null, null, { vapid: VAPID });
  await app.message('getSession');
  app.phone({ type: 'notify_sync', enabled: true, key: 'k1', subscription: SUB, prefs: { skipIntro: false } });
  await settle();
  assert.deepEqual(plain(app.sent.at(-1)), { type: 'push_key', key: 'k1', reachable: true });
  app.phone({ type: 'ping', visible: false });
  app.fromTab(7, { ...MEDIA, platform: 'youtube', skipAdAvailable: true, skipIntroAvailable: true });
  await settle();
  assert.deepEqual(plain(app.pushes.map((p) => p.note)), [{ kind: 'skipAd', title: 'Ad can be skipped', body: 'Ep 1' }]);
  assert.equal(app.pushes[0].subscription.endpoint, SUB.endpoint);
  assert.deepEqual(plain(app.pushes[0].options), { ttl: 30 });
  assert.equal(notes(app).length, 0);
});

test('subscriptions for an old key or a non-push host are not kept', async () => {
  const app = boot(PAIRED, null, null, { vapid: VAPID, pushTarget: { subscription: SUB, prefs: {} } });
  await app.message('getSession');
  app.phone({ type: 'notify_sync', enabled: true, key: 'old', subscription: SUB, prefs: {} });
  await settle();
  assert.equal(app.local.pushTarget.subscription, null);
  assert.deepEqual(plain(app.sent.at(-1)), { type: 'push_key', key: 'k1', reachable: true });
  app.phone({ type: 'notify_sync', enabled: true, key: 'k1', subscription: { ...SUB, endpoint: 'https://router.local/x' }, prefs: {} });
  await settle();
  assert.equal(app.local.pushTarget.subscription, null);
});

test('a subscription the push service reports gone is dropped', async () => {
  const app = boot(PAIRED, null, null, { vapid: VAPID, pushTarget: { subscription: SUB, prefs: {} }, pushResult: { ok: false, status: 410, gone: true } });
  await app.message('getSession');
  app.fromTab(7, { ...MEDIA, stillWatching: true });
  await settle();
  assert.equal(app.pushes[0].note.kind, 'stillWatching');
  assert.equal(app.local.pushTarget.subscription, null);
});

test('"laptop connected" fires once per Chrome launch, and not after the phone already said hello', async () => {
  const app = boot(PAIRED, null, null, { vapid: VAPID, pushTarget: { subscription: SUB, prefs: {} } });
  await app.message('getSession');
  app.relay('connected');
  await settle();
  app.timers.find((t) => t.ms === 4000).fn();
  await settle();
  assert.deepEqual(app.pushes.map((p) => [p.note.kind, p.options.ttl]), [['connected', 300]]);
  app.relay('reconnecting');
  app.relay('connected');
  await settle();
  assert.equal(app.timers.filter((t) => t.ms === 4000).length, 1);

  const greeted = boot(PAIRED, null, null, { vapid: VAPID, pushTarget: { subscription: SUB, prefs: {} } });
  await greeted.message('getSession');
  greeted.phone({ type: 'hello', token: PAIRED.token });
  greeted.relay('connected');
  await settle();
  assert.equal(greeted.timers.filter((t) => t.ms === 4000).length, 0);
});

test('autoplay after the credits announces the new episode; a manual switch does not', async () => {
  const app = boot(PAIRED, null, null, { vapid: VAPID });
  await app.message('getSession');
  app.phone({ type: 'phone_state', visible: true });
  app.fromTab(7, { ...MEDIA, upNext: true });
  app.fromTab(7, { ...MEDIA, mediaKey: 'ep2', title: '', playing: true }); // title not resolved yet
  app.fromTab(7, { ...MEDIA, mediaKey: 'ep2', title: 'Ep 2', playing: true });
  app.fromTab(7, { ...MEDIA, mediaKey: 'ep3', title: 'Ep 3', playing: true });
  assert.deepEqual(notes(app).map((n) => [n.kind, n.title, n.body]),
    [['nextEpisode', 'Episode finished', 'Next episode is up'], ['nowPlaying', 'Now playing', 'Ep 2']]);
});

test('forgetting the phone forgets its push subscription', async () => {
  const app = boot(PAIRED, null, null, { vapid: VAPID, pushTarget: { subscription: SUB, prefs: {} } });
  await app.message('getSession');
  await app.message('newSession');
  assert.equal(app.local.pushTarget.subscription, null);
});

// ── Now-playing poster ──

test('the playing video artwork is fetched once, shrunk and sent; it clears when media goes', async () => {
  const app = boot(PAIRED, null, null, { posterURL: 'https://i.ytimg.com/vi/x/hq.jpg' });
  await app.message('getSession');
  app.fromTab(7, { ...MEDIA, platform: 'youtube' });
  app.fromTab(7, { ...MEDIA, platform: 'youtube', playing: false }); // same video: no refetch
  await settle();
  await settle();
  const posters = () => app.sent.filter((msg) => msg.type === 'media_poster');
  assert.deepEqual(plain(posters()), [{ type: 'media_poster', image: 'data:image/jpeg;base64,AQID' }]);
  assert.equal(app.fetches.length, 1);
  assert.equal(app.fetches[0].init.credentials, 'omit');
  assert.deepEqual(app.canvases, [{ width: 160, height: 90 }]);
  app.timers.find((t) => t.ms === 4000).fn(); // late artwork check finds the same image
  await settle();
  assert.equal(app.fetches.length, 1);
  app.phone({ type: 'request_media_status' }); // a phone back from the lock screen gets it again
  assert.equal(posters().length, 2);
  app.fromTab(7, { type: 'mediaStatus', platform: 'unknown' }, 3);
  assert.deepEqual(plain(posters().at(-1)), { type: 'media_poster', image: '' });
});

test('artwork prefers the smallest sharp Media Session image, then the largest video poster', () => {
  const app = boot(PAIRED, null, null);
  const find = () => {
    app.fromTab(7, { ...MEDIA, mediaKey: 'k' + app.injections.length });
    return app.injections.at(-1).func;
  };
  const func = find();
  app.context.location = { href: 'https://site.example/watch/1' };
  app.context.document = { querySelectorAll: () => [] };
  app.context.navigator = { mediaSession: { metadata: { artwork: [
    { src: '/a96.jpg', sizes: '96x96' }, { src: '/a1024.jpg', sizes: '1024x576' },
    { src: '/a512.jpg', sizes: '512x288' }, { src: 'javascript:alert(1)', sizes: '300x300' }] } } };
  assert.equal(func(), 'https://site.example/a512.jpg');
  app.context.navigator.mediaSession.metadata.artwork = [{ src: '/a96.jpg', sizes: '96x96' }, { src: '/a128.jpg', sizes: '128x128' }];
  assert.equal(func(), 'https://site.example/a128.jpg');
  const video = (w, h, poster) => ({ getBoundingClientRect: () => ({ width: w, height: h }), getAttribute: () => poster });
  app.context.navigator = {};
  app.context.document = { querySelectorAll: () => [video(200, 100, '/small.jpg'), video(1280, 720, '/main.jpg'), video(1920, 1080, 'data:x')] };
  assert.equal(func(), 'https://site.example/main.jpg');
});

test('a test notification always pushes and reports the outcome to the phone', async () => {
  const app = boot(PAIRED, null, null, { vapid: VAPID, pushTarget: { subscription: SUB, prefs: { connected: false } },
    pushResult: { ok: false, status: 403, gone: false, reason: '{"reason":"BadJwtToken"}' } });
  await app.message('getSession');
  app.phone({ type: 'phone_state', visible: true }); // on screen, yet the test still goes out as a push
  app.phone({ type: 'notify_test' });
  await settle();
  assert.equal(app.pushes[0].note.kind, 'test');
  assert.deepEqual(plain(app.sent.at(-1)), { type: 'notify_test_result', ok: false, status: 403, reason: '{"reason":"BadJwtToken"}' });

  const unsubscribed = boot(PAIRED, null, null, { vapid: VAPID });
  await unsubscribed.message('getSession');
  unsubscribed.phone({ type: 'notify_test' });
  assert.equal(unsubscribed.sent.at(-1).reason, 'no_subscription');
});

test('an unreachable push service is reported to the phone and not pushed to', async () => {
  const app = boot(PAIRED, null, null, { vapid: VAPID, unreachable: 'https://web.push.apple.com' });
  await app.message('getSession');
  app.phone({ type: 'notify_sync', enabled: true, key: 'k1', subscription: SUB, prefs: {}, pushOrigin: 'https://web.push.apple.com' });
  await settle();
  assert.deepEqual(plain(app.sent.at(-1)), { type: 'push_key', key: 'k1', reachable: false });
  app.fromTab(7, { ...MEDIA, skipIntroAvailable: true }); // phone off screen
  await settle();
  assert.equal(app.pushes.length, 0);
  app.phone({ type: 'notify_sync', enabled: true, key: 'k1', subscription: SUB, prefs: {}, pushOrigin: 'https://web.push.apple.com' });
  await settle();
  assert.equal(app.fetches.filter((f) => f.url === 'https://web.push.apple.com/').length, 1, 'cached for 10 minutes');
  app.phone({ type: 'notify_sync', enabled: false, key: '', subscription: null, prefs: {}, pushOrigin: 'https://evil.example' });
  await settle();
  assert.equal(app.sent.at(-1).reachable, true, 'only known push services are probed');
});
