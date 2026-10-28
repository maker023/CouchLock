const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function element(width = 1280, height = 720) {
  const attrs = {};
  return {
    attrs, isConnected: true, tagName: 'VIDEO', paused: false, ended: false, readyState: 4,
    duration: 1800, currentTime: 100, currentSrc: 'episode', offsetParent: null,
    visibility: 'visible', display: 'block',
    getBoundingClientRect() { return { width, height }; },
    getAttribute(key) { return Object.hasOwn(attrs, key) ? attrs[key] : null; },
    setAttribute(key, value) { attrs[key] = value; },
    removeAttribute(key) { delete attrs[key]; },
    closest() { return null; },
    matches() { return !!this.open; },
    showPopover() { this.open = true; }, hidePopover() { this.open = false; },
    style: { setProperty() {} },
    click() { this.clicked = true; },
    dispatchEvent(event) { this.events = (this.events || []).concat(event); },
    addEventListener() {}, removeEventListener() {}
  };
}

function boot({ hostname = 'netflix.com', videos = [element()], frames = [], child = false } = {}) {
  const messages = [];
  const timers = [];
  const docEvents = {};
  const winEvents = {};
  const selectors = {};
  let onMessage;
  const document = {
    body: {}, documentElement: {}, title: 'Netflix', fullscreenElement: null,
    querySelector(selector) { return (selectors[selector] || [])[0] || null; },
    querySelectorAll(selector) {
      if (selector === 'video') return videos;
      if (selector === 'iframe, frame') return frames;
      return selectors[selector] || [];
    },
    addEventListener(type, fn) { docEvents[type] = fn; }, removeEventListener() {}
  };
  const window = {
    location: { hostname, href: 'https://' + hostname + '/watch/1' },
    addEventListener(type, fn) { winEvents[type] = fn; }, removeEventListener() {}
  };
  window.top = child ? {} : window;
  const parentMessages = [];
  window.parent = { postMessage(msg) { parentMessages.push(msg); } };
  const context = {
    window, document, navigator: {}, URL, Number, Date,
    HTMLElement: { prototype: { showPopover() {} } },
    KeyboardEvent: function (type, init) { Object.assign(this, init, { type }); },
    getComputedStyle(el) { return { visibility: el.visibility, display: el.display }; },
    setInterval() { return 1; }, clearInterval() {},
    setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout() {},
    chrome: { runtime: { id: 'test',
      sendMessage(msg, callback) { messages.push(msg); if (callback) callback(); },
      onMessage: { addListener(fn) { onMessage = fn; }, removeListener() {} }
    } }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'extension/content.js'), 'utf8'), context);
  return { messages, timers, docEvents, winEvents, selectors, window, parentMessages,
    command(msg) { onMessage(msg, {}, () => {}); },
    status() { return messages.filter((msg) => msg.type === 'mediaStatus').at(-1); }
  };
}

test('fixed-position skip controls are available and hidden/disabled duplicates are ignored when clicking', () => {
  const app = boot();
  const hidden = element(); hidden.visibility = 'hidden';
  const disabled = element(); disabled.disabled = true;
  const visible = element();
  app.selectors['[data-uia="player-skip-intro"]'] = [hidden, disabled, visible];
  app.command({ action: 'requestMediaStatus' });
  assert.equal(app.status().skipIntroAvailable, true);
  app.command({ action: 'cmd', command: 'skipIntro' });
  assert.equal(visible.clicked, true);
  assert.equal(hidden.clicked, undefined);
  assert.equal(disabled.clicked, undefined);
});

test('credits and "still watching?" are reported apart from the control-bar next button', () => {
  const app = boot();
  app.selectors['[data-uia="control-next"]'] = [element()];
  app.command({ action: 'requestMediaStatus' });
  assert.equal(app.status().nextEpisodeAvailable, true);
  assert.equal(app.status().upNext, false);
  assert.equal(app.status().stillWatching, false);
  const seamless = element();
  const proceed = element();
  app.selectors['[data-uia="next-episode-seamless-button"]'] = [seamless];
  app.selectors['[data-uia="interrupt-autoplay-continue"]'] = [proceed];
  app.command({ action: 'requestMediaStatus' });
  assert.equal(app.status().upNext, true);
  assert.equal(app.status().stillWatching, true);
  app.command({ action: 'cmd', command: 'stillWatching' });
  assert.equal(proceed.clicked, true);
});

test('pause events promptly report the visible player instead of a hidden playing preview', () => {
  const preview = element(0, 0);
  const video = element();
  const app = boot({ videos: [preview, video] });
  video.paused = true;
  app.docEvents.pause({ target: video });
  app.timers.at(-1)();
  assert.equal(app.status().playing, false);
});

test('YouTube next-video fallback includes Shift in both keyboard events', () => {
  const video = element();
  const app = boot({ hostname: 'youtube.com', videos: [video] });
  app.command({ action: 'cmd', command: 'nextEpisode' });
  assert.deepEqual(video.events.map((event) => [event.type, event.key, event.shiftKey]),
    [['keydown', 'N', true], ['keyup', 'N', true]]);
});

test('nested fullscreen lifts only the authorized child window and restores original attributes', () => {
  const source = {};
  const frame = element(640, 360);
  frame.contentWindow = source;
  frame.setAttribute('style', 'width:640px');
  const app = boot({ videos: [], frames: [frame], child: true });
  const event = { source, data: { type: 'couchlock-expand-frame', token: 'authorized' } };
  app.winEvents.message(event);
  assert.equal(frame.open, undefined, 'page messages cannot initiate fullscreen');
  app.command({ action: 'preparePlayerExpand', token: 'authorized' });
  app.winEvents.message({ ...event, source: {} });
  assert.equal(frame.open, undefined, 'must match the actual child window');
  app.winEvents.message(event);
  assert.equal(frame.open, true);
  assert.equal(app.parentMessages.at(-1).token, 'authorized');
  app.winEvents.message(event); // duplicate must not overwrite the saved style
  app.command({ action: 'playerRestore' });
  assert.equal(frame.open, false);
  assert.equal(frame.getAttribute('style'), 'width:640px');
  assert.equal(frame.getAttribute('popover'), null);
});

test('an embedded player retries a delayed parent handoff and stops after restore', () => {
  const app = boot({ child: true });
  app.command({ action: 'preparePlayerExpand', token: 'authorized' });
  app.command({ action: 'playerExpand', token: 'authorized' });
  const initial = app.parentMessages.length;
  app.timers.at(-1)();
  assert.equal(app.parentMessages.length, initial + 1, 'a parent armed after the first message gets another chance');
  const retry = app.timers.at(-1);
  app.command({ action: 'playerRestore' });
  retry();
  assert.equal(app.parentMessages.length, initial + 1, 'pending retries cannot reopen restored frames');
});
