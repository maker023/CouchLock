const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const content = fs.readFileSync(path.join(__dirname, '..', 'extension', 'content.js'), 'utf8');
const source = content.slice(content.indexOf("  var titleKey = ''"), content.indexOf('  var statusInterval ='));

function player(options = {}) {
  const messages = [];
  const video = { paused: false, currentTime: 120, duration: 1800, currentSrc: 'episode-1',
    getBoundingClientRect() { return { width: 1280, height: 720 }; } };
  const context = {
    window: { location: { href: 'https://example.com/watch/1' } },
    S: { universal: {} }, Date, setTimeout, clearTimeout,
    platform: options.platform || 'netflix',
    document: {
      get title() { return options.pageTitle || ''; },
      querySelector(selector) {
        if (selector.includes('meta[')) return options.metaTitle ? { content: options.metaTitle } : null;
        return options.overlayTitle ? { textContent: options.overlayTitle } : null;
      }
    },
    navigator: options.sessionTitle ? { mediaSession: { metadata: { title: options.sessionTitle } } } : {},
    activeVideo() { return video; }, currentPlatform() { return options.platform || 'netflix'; },
    getStrategies() { return {}; }, checkStrategyExists() { return false; },
    safeSendMessage(msg, callback) {
      if (msg.type === 'requestMediaTitle') {
        if (callback) callback({ title: options.mainTitle || '', url: context.window.location.href });
      } else messages.push(msg);
    },
    contextValid: true
  };
  vm.runInNewContext(source, context);
  context.reportMediaStatus();
  return { message: messages.at(-1), video, context, messages };
}

test('playing Netflix titles do not require visible pause controls', () => {
  const { message, video } = player({ sessionTitle: '  Episode one  ', pageTitle: 'Netflix' });
  assert.equal(message.title, 'Episode one');
  assert.equal(message.playing, true);
  assert.equal(video.paused, false);
  assert.equal(video.currentTime, 120);
});

test('player overlay titles take priority over other metadata', () => {
  assert.equal(player({ overlayTitle: 'Episode two', sessionTitle: 'Episode one' }).message.title, 'Episode two');
});

test('YouTube and universal players fall back to metadata and page titles', () => {
  assert.equal(player({ platform: 'youtube', metaTitle: 'Current video', pageTitle: 'YouTube' }).message.title, 'Current video');
  assert.equal(player({ platform: 'universal', sessionTitle: 'Live stream', pageTitle: 'Player' }).message.title, 'Live stream');
  assert.equal(player({ pageTitle: 'Current episode — Netflix' }).message.title, 'Current episode — Netflix');
  assert.equal(player().message.title, '', 'background can supply a parent tab title for an untitled frame');
});

test('a generic service title does not replace an episode after its overlay hides', () => {
  const options = { overlayTitle: 'Episode one', pageTitle: 'Netflix' };
  const app = player(options);
  options.overlayTitle = '';
  app.context.reportMediaStatus(true);
  assert.equal(app.messages.at(-1).title, 'Episode one');
  app.context.window.location.href = 'https://example.com/watch/2';
  app.video.currentSrc = 'episode-2';
  app.context.reportMediaStatus(true);
  assert.equal(app.messages.at(-1).title, 'Netflix', 'old episode title is cleared on navigation');
});

test('page-world Media Session title fills in when isolated metadata is missing', () => {
  const app = player({ mainTitle: 'Episode from page', pageTitle: 'Netflix' });
  app.context.reportMediaStatus(true);
  assert.equal(app.messages.at(-1).title, 'Episode from page');
});

test('ended media reports stopped and unchanged idle snapshots are suppressed except on request', () => {
  const app = player({ pageTitle: 'A video' });
  app.video.ended = true;
  app.context.reportMediaStatus();
  assert.equal(app.messages.at(-1).playing, false);
  const count = app.messages.length;
  app.context.reportMediaStatus();
  assert.equal(app.messages.length, count);
  app.context.reportMediaStatus(true);
  assert.equal(app.messages.length, count + 1, 'reconnect always gets a complete snapshot');
});
