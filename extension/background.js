/**
 * CouchLock — Background Service Worker (MV3)
 *
 * Responsibilities:
 *   - Session generation (token + session ID)
 *   - WebSocket relay connection via CouchTransport
 *   - Message routing: phone → content script, content script → phone
 *   - Cursor state tracking (x, y position)
 *   - Tab management commands
 *   - Active tab filtering for media status
 *   - Input focus relay for keyboard overlay
 *   - Cursor settings relay
 *   - Fullscreen toggle via chrome.windows API
 */
importScripts('transport.js');

(function () {
  'use strict';

  // ── PWA Base URL ──
  var PWA_URL = 'https://maker023.github.io/CouchLock/';

  // ── Session State ──
  var session = null;   // { id, token, created }
  var paired = false;
  var activeTabId = null; // currently active tab
  var cursorX = 0;
  var cursorY = 0;
  var viewportW = 1920;
  var viewportH = 1080;
  var connStatus = 'disconnected';

  // ── Session Management ──

  function generateToken() {
    var bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    var hex = '';
    for (var i = 0; i < bytes.length; i++) {
      hex += ('0' + bytes[i].toString(16)).slice(-2);
    }
    return hex;
  }

  function generateSessionId() {
    var bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    var id = '';
    for (var i = 0; i < bytes.length; i++) {
      id += bytes[i].toString(36);
    }
    return id.slice(0, 12);
  }

  function createSession() {
    session = {
      id: generateSessionId(),
      token: generateToken(),
      created: Date.now()
    };
    paired = false;
    cursorX = Math.round(viewportW / 2);
    cursorY = Math.round(viewportH / 2);

    chrome.storage.session.set({ session: session });

    CouchTransport.connect({
      token: session.token,
      sessionId: session.id
    });

    return session;
  }

  function getSession() {
    return session;
  }

  // ── Active Tab Tracking ──

  function updateActiveTab() {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (tabs.length > 0) {
        activeTabId = tabs[0].id;
      }
    });
  }

  chrome.tabs.onActivated.addListener(function (info) {
    activeTabId = info.tabId;
    // Request viewport dimensions from the new active tab
    if (paired) {
      requestViewport();
    }
  });

  // Init active tab
  updateActiveTab();

  // ── Viewport ──
  // Content script reports viewport dimensions so cursor stays in bounds.

  function requestViewport() {
    sendToContentScript({ action: 'getViewport' });
  }

  // ── Transport Handlers ──

  CouchTransport.onStatus(function (status) {
    connStatus = status;
    broadcastToPopup({ type: 'status', status: status, paired: paired });
  });

  CouchTransport.onMessage(function (msg) {
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'hello':
        handleHello(msg);
        break;
      case 'mousemove':
        handleMouseMove(msg);
        break;
      case 'click':
        handleClick(msg);
        break;
      case 'doubleclick':
        handleDoubleClick(msg);
        break;
      case 'rightclick':
        handleRightClick(msg);
        break;
      case 'scroll':
        handleScroll(msg);
        break;
      case 'keydown':
        handleKeyDown(msg);
        break;
      case 'keyup':
        handleKeyUp(msg);
        break;
      case 'keychar':
        handleKeyChar(msg);
        break;
      case 'cmd':
        handleCommand(msg);
        break;
      case 'tab_list':
        handleTabList();
        break;
      case 'tab_switch':
        handleTabSwitch(msg);
        break;
      case 'tab_reload':
        handleTabReload(msg);
        break;
      case 'tab_new':
        handleTabNew();
        break;
      case 'tab_close':
        handleTabClose(msg);
        break;
      case 'tab_navigate':
        handleTabNavigate(msg);
        break;
      case 'swipe':
        handleSwipe(msg);
        break;
      case 'cursor_settings':
        handleCursorSettings(msg);
        break;
      case 'theme_update':
        handleThemeUpdate(msg);
        break;
      case 'sticker_update':
        handleStickerUpdate(msg);
        break;
      case 'tips_pref':
        handleTipsPref(msg);
        break;
      case 'request_media_status':
        sendToContentScript({ action: 'requestMediaStatus' });
        break;
      case 'ping':
        CouchTransport.send({ type: 'pong', ts: Date.now() });
        break;
      case 'session_close':
        handleSessionClose();
        break;
    }
  });

  function handleSessionClose() {
    paired = false;
    stopKeepalive();
    broadcastToPopup({ type: 'status', status: connStatus, paired: false });
    CouchTransport.send({ type: 'session_closed' });
    createSession();
  }

  // ── Service-worker keepalive ──
  // MV3 service workers are killed after ~30s idle, which drops the broker
  // connection. While a session is active we keep a periodic alarm so the worker
  // is woken and the connection re-established promptly. (Active WebSocket traffic
  // — the ~24s MQTT ping — is the primary keepalive on modern Chrome; the alarm is
  // the safety net for when the worker was terminated anyway.)
  var KEEPALIVE_ALARM = 'couchlock-keepalive';

  function startKeepalive() {
    chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  }

  function stopKeepalive() {
    chrome.alarms.clear(KEEPALIVE_ALARM);
  }

  function ensureConnected() {
    if (session && !CouchTransport.isConnected()) {
      CouchTransport.reconnectNow();
    }
  }

  chrome.alarms.onAlarm.addListener(function (alarm) {
    if (alarm.name === KEEPALIVE_ALARM) {
      ensureConnected();
    }
  });

  function handleHello(msg) {
    if (msg.token === session.token) {
      paired = true;
      CouchTransport.send({ type: 'ready', ts: Date.now() });
      broadcastToPopup({ type: 'status', status: connStatus, paired: true });
      requestViewport();
      startKeepalive();
      maybeOpenTips();
    }
  }

  // Open the tips/welcome page once, ever. The "shown" flag is persisted in
  // chrome.storage.local so it survives service-worker restarts — the old
  // in-memory flag re-fired the tab on every re-pair. Gated by the user's
  // "Show tips on connect" preference (default on).
  function maybeOpenTips() {
    chrome.storage.local.get(['tipsEnabled', 'tipsShown'], function (data) {
      var enabled = (data.tipsEnabled !== false); // default true
      if (enabled && !data.tipsShown) {
        chrome.storage.local.set({ tipsShown: true });
        chrome.tabs.create({ url: PWA_URL + 'success.html' });
      }
    });
  }

  function handleTipsPref(msg) {
    var enabled = !!msg.enabled;
    var update = { tipsEnabled: enabled };
    // Re-enabling means "show me the tips again" → allow one more open.
    if (enabled) update.tipsShown = false;
    chrome.storage.local.set(update);
  }

  // ── Input Dispatch (all via content script) ──

  function dispatchMouse(type, x, y, button, clickCount) {
    sendToContentScript({
      action: 'mouse',
      mouseType: type,
      x: x,
      y: y,
      button: button || 'left',
      clickCount: clickCount || 0
    });
  }

  function dispatchKey(type, key, code, modifiers) {
    sendToContentScript({
      action: 'key',
      keyType: type,
      key: key,
      code: code,
      modifiers: modifiers || 0
    });
  }

  function dispatchScroll(deltaX, deltaY) {
    sendToContentScript({ action: 'scroll', deltaX: deltaX, deltaY: deltaY });
  }

  // ── Command Handlers ──

  function handleMouseMove(msg) {
    var dx = msg.dx || 0;
    var dy = msg.dy || 0;
    var sensitivity = msg.sensitivity || 1;

    var scaledDx = dx * sensitivity;
    var scaledDy = dy * sensitivity;

    // Dead zone: ignore sub-pixel jitter (touch sensor noise)
    if (Math.abs(scaledDx) < 0.5 && Math.abs(scaledDy) < 0.5) return;

    cursorX = Math.max(0, Math.min(viewportW, cursorX + scaledDx));
    cursorY = Math.max(0, Math.min(viewportH, cursorY + scaledDy));

    var x = Math.round(cursorX);
    var y = Math.round(cursorY);

    dispatchMouse('mouseMoved', x, y);
    // Content script gets floats for smooth sub-pixel rendering
    sendToContentScript({ action: 'cursorMove', x: cursorX, y: cursorY });
  }

  function handleClick(msg) {
    var x = Math.round(cursorX);
    var y = Math.round(cursorY);
    dispatchMouse('mousePressed', x, y, 'left', 1);
    dispatchMouse('mouseReleased', x, y, 'left', 1);
    sendToContentScript({ action: 'cursorClick', x: x, y: y });
  }

  function handleDoubleClick(msg) {
    var x = Math.round(cursorX);
    var y = Math.round(cursorY);
    dispatchMouse('mousePressed', x, y, 'left', 1);
    dispatchMouse('mouseReleased', x, y, 'left', 1);
    dispatchMouse('mousePressed', x, y, 'left', 2);
    dispatchMouse('mouseReleased', x, y, 'left', 2);
    sendToContentScript({ action: 'cursorClick', x: x, y: y });
  }

  function handleRightClick(msg) {
    var x = Math.round(cursorX);
    var y = Math.round(cursorY);
    dispatchMouse('mousePressed', x, y, 'right', 1);
    dispatchMouse('mouseReleased', x, y, 'right', 1);
    sendToContentScript({ action: 'cursorClick', x: x, y: y });
  }

  function handleScroll(msg) {
    var dx = msg.dx || 0;
    var dy = msg.dy || 0;
    dispatchScroll(dx, dy);
  }

  function handleKeyDown(msg) {
    dispatchKey('keyDown', msg.key, msg.code, msg.modifiers);
  }

  function handleKeyUp(msg) {
    dispatchKey('keyUp', msg.key, msg.code, msg.modifiers);
  }

  function handleKeyChar(msg) {
    dispatchKey('keyDown', msg.key, msg.code, 0);
    dispatchKey('keyUp', msg.key, msg.code, 0);
  }

  // ── Swipe gestures (reels navigation) ──

  function handleSwipe(msg) {
    var dir = msg.direction;
    sendToContentScript({ action: 'swipe', direction: dir });
  }

  // ── Command Router ──

  function handleCommand(msg) {
    var command = msg.action;

    // Browser back/forward: use chrome.tabs.goBack/goForward
    if (command === 'browserBack') {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        if (tabs.length > 0) {
          chrome.tabs.goBack(tabs[0].id);
        }
      });
      return;
    }
    if (command === 'browserForward') {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        if (tabs.length > 0) {
          chrome.tabs.goForward(tabs[0].id);
        }
      });
      return;
    }

    // Fullscreen: toggle browser fullscreen via chrome.windows API
    // This gives F11-equivalent fullscreen without the debugger bar.
    // Also tell the content script to click the platform's fullscreen button
    // for proper video-player fullscreen on sites that support it.
    if (command === 'fullscreen') {
      chrome.windows.getCurrent(function (win) {
        var newState = win.state === 'fullscreen' ? 'normal' : 'fullscreen';
        chrome.windows.update(win.id, { state: newState }, function () {
          if (chrome.runtime.lastError) { /* ignore */ }
        });
      });
      // Also attempt platform-native fullscreen via content script
      sendToContentScript({ action: 'cmd', command: 'fullscreen', data: msg.data });
      return;
    }

    // Seek: set video.currentTime directly via content script
    if (command === 'seek') {
      sendToContentScript({ action: 'seek', time: msg.data && msg.data.time !== undefined ? msg.data.time : 0 });
      return;
    }

    // Everything else (playPause, skipAd, skipIntro, nextEpisode, mute, volume, etc.)
    // goes straight to the content script which has per-platform selector strategies
    sendToContentScript({ action: 'cmd', command: command, data: msg.data });
  }

  function handleTabList() {
    chrome.tabs.query({ currentWindow: true }, function (tabs) {
      var list = tabs.map(function (t) {
        return { id: t.id, title: t.title, url: t.url, active: t.active };
      });
      CouchTransport.send({ type: 'tab_list_result', tabs: list });
    });
  }

  function handleTabSwitch(msg) {
    if (msg.tabId) {
      chrome.tabs.update(msg.tabId, { active: true }, function () {
        if (chrome.runtime.lastError) return;
        activeTabId = msg.tabId;
        setTimeout(handleTabList, 300);
      });
    }
  }

  function handleTabReload(msg) {
    var tabId = msg.tabId || activeTabId;
    if (tabId) {
      chrome.tabs.reload(tabId, {}, function () {
        if (chrome.runtime.lastError) return;
        setTimeout(handleTabList, 500);
      });
    }
  }

  function handleTabNew() {
    chrome.tabs.create({}, function (tab) {
      if (chrome.runtime.lastError) return;
      activeTabId = tab.id;
      setTimeout(handleTabList, 300);
    });
  }

  function handleTabClose(msg) {
    if (!msg.tabId) return;
    chrome.tabs.remove(msg.tabId, function () {
      if (chrome.runtime.lastError) return;
      setTimeout(handleTabList, 300);
    });
  }

  function handleTabNavigate(msg) {
    var query = msg.query || '';
    if (!query) return;

    var url;
    if (query.indexOf('.') !== -1 && query.indexOf(' ') === -1) {
      if (query.indexOf('://') === -1) {
        url = 'https://' + query;
      } else {
        url = query;
      }
    } else {
      url = 'https://www.google.com/search?q=' + encodeURIComponent(query);
    }

    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (tabs.length > 0) {
        chrome.tabs.update(tabs[0].id, { url: url }, function () {
          if (chrome.runtime.lastError) return;
          setTimeout(handleTabList, 500);
        });
      }
    });
  }

  function handleCursorSettings(msg) {
    sendToContentScript({
      action: 'cursorSettings',
      size: msg.size,
      color: msg.color
    });
  }

  function handleThemeUpdate(msg) {
    if (msg.theme) {
      chrome.storage.local.set({ theme: msg.theme });
      broadcastToPopup({ type: 'theme_update', theme: msg.theme });
    }
  }

  function handleStickerUpdate(msg) {
    if (msg.stickers) {
      chrome.storage.local.set({ stickers: msg.stickers });
      broadcastToPopup({ type: 'sticker_update', stickers: msg.stickers });
    }
  }

  // ── Content Script Communication ──

  function sendToContentScript(msg) {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (tabs.length > 0) {
        chrome.tabs.sendMessage(tabs[0].id, msg, function () {
          if (chrome.runtime.lastError) { /* ignore */ }
        });
      }
    });
  }

  // Listen for messages FROM content script
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg.type === 'getSession') {
      sendResponse({ session: session, paired: paired, status: connStatus });
      return true;
    }

    if (msg.type === 'newSession') {
      if (paired) {
        CouchTransport.send({ type: 'session_closed' });
      }
      createSession();
      sendResponse({ session: session });
      return true;
    }

    if (msg.type === 'viewport') {
      if (msg.w && msg.h) {
        viewportW = msg.w;
        viewportH = msg.h;
        cursorX = Math.round(viewportW / 2);
        cursorY = Math.round(viewportH / 2);
      }
    }

    if (msg.type === 'mediaStatus') {
      if (sender.tab && sender.tab.id !== activeTabId) return;

      CouchTransport.send({
        type: 'media_status',
        platform: msg.platform,
        title: msg.title,
        playing: msg.playing,
        currentTime: msg.currentTime,
        duration: msg.duration,
        skipIntroAvailable: msg.skipIntroAvailable || false
      });
    }

    if (msg.type === 'skipAdAvailable') {
      CouchTransport.send({
        type: 'skip_ad_available',
        available: msg.available
      });
    }

    if (msg.type === 'inputFocused') {
      CouchTransport.send({
        type: 'input_focused',
        inputType: msg.inputType,
        tagName: msg.tagName,
        value: msg.value
      });
    }

    if (msg.type === 'inputBlurred') {
      CouchTransport.send({ type: 'input_blurred' });
    }

    if (msg.type === 'cmdResult') {
      CouchTransport.send({
        type: 'cmd_result',
        command: msg.command,
        success: msg.success
      });
    }
  });

  // ── Popup Communication ──

  function broadcastToPopup(msg) {
    chrome.runtime.sendMessage(msg).catch(function () {
      // Popup not open, ignore
    });
  }

  // ── Live Tab Updates ──

  chrome.tabs.onCreated.addListener(function () {
    if (paired) setTimeout(handleTabList, 300);
  });

  chrome.tabs.onRemoved.addListener(function () {
    if (paired) setTimeout(handleTabList, 300);
  });

  chrome.tabs.onUpdated.addListener(function (tabId, changeInfo) {
    if (paired && changeInfo.title) {
      setTimeout(handleTabList, 300);
    }
  });

  chrome.tabs.onActivated.addListener(function () {
    if (paired) setTimeout(handleTabList, 300);
  });

  // ── Init ──

  chrome.storage.session.get('session', function (data) {
    if (data && data.session) {
      session = data.session;
      CouchTransport.connect({
        token: session.token,
        sessionId: session.id
      });
    }
  });

})();
