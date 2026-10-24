const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const popup = fs.readFileSync(path.join(__dirname, '..', 'extension', 'popup.js'), 'utf8');
const popupHtml = fs.readFileSync(path.join(__dirname, '..', 'extension', 'popup.html'), 'utf8');
const foregroundAlphas = Array.from((html + popupHtml).matchAll(/(?<![-\w])(?:color|stroke|fill):\s*rgba\(var\(--ui-rgb\),([\d.]+)\)/g), (m) => Number(m[1]));
const mutedAlpha = Math.min(...foregroundAlphas);
const definitions = html.slice(html.indexOf('  var THEMES = ['), html.indexOf('  // ── DOM'));
const functions = html.slice(html.indexOf('  function rgbToHex('), html.indexOf('  function buildThemeSwatches('));

function boot() {
  const vars = {};
  const messages = [];
  const stored = {};
  const root = { style: {
    getPropertyValue(key) { return vars[key] || ''; },
    setProperty(key, value) { vars[key] = value; }
  }, setAttribute(key, value) { vars[key] = value; } };
  const context = {
    invertedState: {}, currentThemeId: 'dark',
    document: { documentElement: root, querySelector() { return { setAttribute() {} }; } },
    $(selector) { return { style: {}, classList: { add() {}, remove() {} } }; },
    getComputedStyle() { return root.style; }, requestAnimationFrame(fn) { fn(); }, setTimeout() {},
    send(msg) { messages.push(msg); }, sendCursorSettings() {}, updateThemeSwatchUI() {},
    localStorage: { setItem(key, value) { stored[key] = value; } }
  };
  vm.createContext(context);
  vm.runInContext(definitions + functions, context);
  return { context, vars, messages, stored };
}

function rgb(hex) { return hex.match(/[a-f\d]{2}/gi).map((c) => parseInt(c, 16)); }
function luminance(color) {
  const c = color.map((v) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
}
function contrast(a, b) {
  const values = [luminance(a), luminance(b)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}
function blend(fg, bg, alpha) { return bg.map((v, i) => v + (fg[i] - v) * alpha); }

test('all fourteen palettes keep muted text and accents readable on both surfaces', () => {
  const { context } = boot();
  assert.equal(context.THEMES.length, 14);
  assert.equal(new Set(context.THEMES.map((t) => t.id)).size, 14);
  for (const theme of context.THEMES) {
    const ui = theme.ui.split(',').map(Number);
    const accent = theme.accent.split(',').map(Number);
    for (const surface of [theme.voidHex, theme.inkHex]) {
      const bg = rgb(surface);
      // Test the faintest normal text after alpha compositing, not the raw UI color.
      assert.ok(contrast(blend(ui, bg, mutedAlpha), bg) >= 4.5, theme.id + ' muted text on ' + surface);
      assert.ok(contrast(accent, bg) >= 4.5, theme.id + ' accent on ' + surface);
      // Active tabs/actions and sticker buttons use an accent-tinted surface.
      const tinted = blend(accent, bg, 0.15);
      assert.ok(contrast(accent, tinted) >= 4.5, theme.id + ' active text on ' + surface);
    }
  }
});

test('phone and popup select readable button foregrounds, including legacy payloads', () => {
  const { context } = boot();
  const popupVars = {};
  const popupContext = { document: { documentElement: { setAttribute(key, value) { popupVars[key] = value; }, style: {
    setProperty(key, value) { popupVars[key] = value; }
  } } } };
  vm.createContext(popupContext);
  vm.runInContext(popup.slice(popup.indexOf('  function onColor('), popup.indexOf('  function loadTheme(')), popupContext);
  for (const theme of context.THEMES) {
    context.applyTheme(theme.id);
    popupContext.applyTheme(context.getThemeColors(theme));
    assert.equal(popupVars['--primary-on'], context.onColor(theme.primaryHex));
    assert.equal(popupVars['data-appearance'], theme.appearance || 'aura');
    const fg = popupVars['--primary-on'].split(',').map(Number);
    assert.ok(contrast(fg, rgb(theme.primaryHex)) >= 4.5, theme.id + ' primary foreground');
    assert.ok(contrast(popupVars['--accent-on'].split(',').map(Number), theme.accent.split(',').map(Number)) >= 4.5);
    const legacy = { ...theme };
    delete legacy.primaryHex;
    popupContext.applyTheme(legacy);
    const accentHex = '#' + theme.accent.split(',').map((c) => Number(c).toString(16).padStart(2, '0')).join('');
    assert.equal(popupVars['--primary-on'], context.onColor(accentHex));
  }
});

test('inversion is rendered, persisted and synced identically, including reconnect sends', () => {
  const { context, vars, messages, stored } = boot();
  for (const theme of context.THEMES) {
    for (const inverted of [false, true]) {
      context.invertedState[theme.id] = inverted;
      context.applyTheme(theme.id);
      const sent = messages.at(-1).theme;
      assert.equal(sent.voidHex, vars['--void']);
      assert.equal(sent.inkHex, vars['--ink']);
      assert.equal(sent.voidRgb, rgb(sent.voidHex).join(','));
      assert.equal(sent.voidHex, inverted ? theme.inkHex : theme.voidHex);
      assert.equal(sent.primaryHex, vars['--primary']);
      assert.equal(sent.appearance, vars['data-appearance']);
      assert.equal(stored['couchlock-theme'], theme.id);
      assert.equal(JSON.parse(stored['couchlock-theme-inverted'])[theme.id], inverted);
      context.sendThemeToExtension(theme);
      assert.deepEqual(messages.at(-1).theme, sent);
    }
  }
});

test('retired blue/purple selections resolve to their new replacements', () => {
  const { context } = boot();
  assert.equal(context.getThemeById('nightindigo').id, 'newspaper');
  assert.equal(context.getThemeById('emo').id, 'pistachio');
  assert.equal(context.getThemeById('missing').id, 'dark');
});
