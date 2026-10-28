const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function boot() {
  const nodes = new Map();
  const sent = [];
  let reconnects = 0;
  function $(selector) {
    if (!nodes.has(selector)) {
      const classes = new Set();
      nodes.set(selector, { style: {}, attrs: {}, disabled: false, textContent: '',
        addEventListener() {}, setAttribute(key, value) { this.attrs[key] = value; },
        classList: { add: (key) => classes.add(key), remove: (key) => classes.delete(key),
          contains: (key) => classes.has(key), toggle(key, value) { if (value) classes.add(key); else classes.delete(key); } }
      });
    }
    return nodes.get(selector);
  }
  const context = {
    $, $$: () => ['#btn-play-pause', '#btn-next-ep', '#btn-skip-ad', '#btn-skip-intro'].map($),
    document: { visibilityState: 'visible', querySelector: $ },
    isPaired: true, mediaFresh: false, mediaReceivedAt: 0, mediaScrubbing: false,
    mediaState: { platform: '', currentTime: 0, duration: 0 }, skipAdAvailable: false,
    currentMode: 'media', token: 'saved', sessionPaused: false, autoReconnect: true,
    lastResumeReconnect: 0, hiddenAt: 0, mediaPoster: '', reconnectGraceUntil: 0, RECONNECT_GRACE: 4000,
    updateConnUI() {}, setTimeout() {},
    CouchTransport: { isConnected: () => true, reconnectNow() { reconnects++; } },
    send(msg) { sent.push(msg); }, setInterval() {}, Date
  };
  vm.createContext(context);
  vm.runInContext(html.slice(html.indexOf('  var MEDIA_BUTTONS ='), html.indexOf('  var nativeInput =')), context);
  vm.runInContext(html.slice(html.indexOf('  function resumeReconnect()'), html.indexOf("  document.addEventListener('visibilitychange'")), context);
  const receive = vm.runInContext('(function(msg) {' + html.slice(html.indexOf("      if (msg.type === 'media_status')"),
    html.indexOf("      if (msg.type === 'skip_ad_available')")) + '})', context);
  return { context, $, sent, receive, reconnects: () => reconnects };
}

test('quick app switches request fresh state without reconnecting; long locks reconnect once', () => {
  const app = boot();
  app.context.hiddenAt = Date.now() - 300;
  app.context.resumeReconnect();
  assert.equal(app.reconnects(), 0);
  assert.equal(app.sent.at(-1).type, 'request_media_status');
  app.context.lastResumeReconnect = 0;
  app.context.hiddenAt = Date.now() - 60000;
  app.context.resumeReconnect();
  app.context.resumeReconnect(); // focus + pageshow + visibilitychange coalesce
  assert.equal(app.reconnects(), 1);
  assert.equal(app.context.mediaFresh, false);
  assert.equal(app.$('#btn-play-pause').disabled, true);
});

test('unlocking a connected phone keeps the pill on Connected while the socket is rebuilt', () => {
  const app = boot();
  app.context.isPaired = true;
  app.context.hiddenAt = Date.now() - 60000;
  app.context.resumeReconnect();
  assert.equal(app.reconnects(), 1);
  assert.ok(app.context.reconnectGraceUntil > Date.now() + 3000);
});

test('wake refresh still runs with automatic socket reconnect disabled, but respects manual disconnect', () => {
  const app = boot();
  app.context.autoReconnect = false;
  app.context.hiddenAt = Date.now() - 60000;
  app.context.resumeReconnect();
  assert.equal(app.sent.at(-1).type, 'request_media_status');
  assert.equal(app.reconnects(), 0);
  app.context.lastResumeReconnect = 0;
  app.context.sessionPaused = true;
  app.context.resumeReconnect();
  assert.equal(app.sent.length, 1);
});

test('one fresh snapshot restores the correct play/pause icon and all action highlights', () => {
  const app = boot();
  app.receive({ type: 'media_status', platform: 'youtube', title: 'Episode', playing: false,
    currentTime: 100, duration: 1800, skipAdAvailable: true, skipIntroAvailable: true, nextEpisodeAvailable: true });
  assert.equal(app.$('#icon-play').style.display, '');
  assert.equal(app.$('#icon-pause').style.display, 'none');
  assert.equal(app.$('#btn-play-pause').disabled, false);
  for (const id of ['#btn-skip-ad', '#btn-skip-intro', '#btn-next-ep']) assert.equal(app.$(id).classList.contains('highlight'), true);
  app.receive({ type: 'media_status', platform: 'netflix', playing: true, currentTime: 10, duration: 1800 });
  assert.equal(app.$('#icon-pause').style.display, '');
  assert.equal(app.$('#btn-skip-ad').classList.contains('highlight'), false, 'old ad state is cleared on player changes');
});

test('background snapshots avoid rendering and progress updates do not interrupt a seek gesture', () => {
  const app = boot();
  app.context.document.visibilityState = 'hidden';
  app.receive({ type: 'media_status', platform: 'netflix', title: 'New episode', currentTime: 100, duration: 1800 });
  assert.equal(app.$('#media-title').textContent, '');
  app.context.document.visibilityState = 'visible';
  app.context.updateMediaUI();
  assert.equal(app.$('#media-title').textContent, 'New episode');
  app.context.mediaScrubbing = true;
  app.$('#media-progress').style.width = '80%';
  app.receive({ type: 'media_status', platform: 'netflix', currentTime: 101, duration: 1800 });
  assert.equal(app.$('#media-progress').style.width, '80%');
});

test('all inline PWA scripts parse', () => {
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
});

test('echoed phone commands cannot keep a silent laptop marked alive', () => {
  let receive;
  const context = { Date, lastLaptopSeen: 1, CouchTransport: { onMessage(fn) { receive = fn; } } };
  const start = html.indexOf('    CouchTransport.onMessage(function (msg)');
  const end = html.indexOf('    CouchTransport.connect(', start);
  vm.runInNewContext(html.slice(start, end), context);
  receive({ type: 'ping' });
  receive({ type: 'cmd', action: 'playPause' });
  assert.equal(context.lastLaptopSeen, 1);
  receive({ type: 'pong' });
  assert.ok(context.lastLaptopSeen > 1);
});
