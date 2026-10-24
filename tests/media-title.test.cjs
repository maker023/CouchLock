const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const content = fs.readFileSync(path.join(__dirname, '..', 'extension', 'content.js'), 'utf8');
const source = content.slice(content.indexOf('  function mediaTitle('), content.indexOf('  var statusInterval ='));

function player(options = {}) {
  const messages = [];
  const video = { paused: false, currentTime: 120, duration: 1800 };
  const context = {
    platform: options.platform || 'netflix',
    document: {
      title: options.pageTitle || '',
      querySelector(selector) {
        if (selector.includes('meta[')) return options.metaTitle ? { content: options.metaTitle } : null;
        return options.overlayTitle ? { textContent: options.overlayTitle } : null;
      }
    },
    navigator: options.sessionTitle ? { mediaSession: { metadata: { title: options.sessionTitle } } } : {},
    activeVideo() { return video; }, currentPlatform() { return options.platform || 'netflix'; },
    getStrategies() { return {}; }, checkStrategyExists() { return false; },
    safeSendMessage(msg) { messages.push(msg); }
  };
  vm.runInNewContext(source, context);
  context.reportMediaStatus();
  return { message: messages.at(-1), video };
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
