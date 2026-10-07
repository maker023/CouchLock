/**
 * CouchLock — Background Service Worker (MV3)
 *
 * Responsibilities:
 *   - Session generation (token + session ID), persisted pairing state
 *   - WebSocket relay connection via CouchTransport (+ online/offline presence)
 *   - Message routing: phone → content script, content script → phone
 *   - Content script (re-)injection for tabs opened before install/reload
 *   - Cursor state tracking (x, y position)
 *   - Tab management commands
 *   - Active tab filtering for media status
 *   - Input focus relay for keyboard overlay
 *   - Cursor settings relay
 *   - Player fullscreen (window fullscreen + player lifted above the page)
 *   - Netflix seeking through the page's own player API
 */
importScripts('transport.js');

(function () {
  'use strict';

  // ── PWA Base URL ──
  var PWA_URL = 'https://maker023.github.io/CouchLock/';

  // ── Session State ──
  var session = null;   // { id, token, created, pairedAt, paused }
  var paired = false;
  var activeTabId = null; // currently active tab
  var mediaFrameId = null; // frame containing the active HTML media element
  var mediaPlaying = false;
  var mediaPlatform = 'unknown';
  var cursorX = 0;
  var cursorY = 0;
  var viewportW = 1920;
  var viewportH = 1080;
  var connStatus = 'disconnected';
  var fullscreenTab = null; // { tabId, windowId, prevState } while the remote holds fullscreen
  var injecting = {};       // tabId → Promise<boolean>
  var sessionReady;
  var resolveSessionReady;
  sessionReady = new Promise(function (resolve) { resolveSessionReady = resolve; });

  var RECEIVER_MISSING = 'Receiving end does not exist';
  var MEDIA_COMMANDS = ['playPause', 'seekForward', 'seekBack', 'mute', 'volumeUp', 'volumeDown'];

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

  function connectSession() {
    CouchTransport.connect({ token: session.token, sessionId: session.id, presence: 'announce' });
    startKeepalive();
  }

  function saveSession() {
    chrome.storage.local.set({ session: session });
  }

  // Replaces the pairing. Phones holding the old token see it as revoked.
  function createSession() {
    if (session) CouchTransport.disconnect('x');
    session = {
      id: generateSessionId(),
      token: generateToken(),
      created: Date.now()
    };
    paired = false;
    cursorX = Math.round(viewportW / 2);
    cursorY = Math.round(viewportH / 2);

    saveSession();
    connectSession();
    broadcastToPopup({ type: 'status', status: connStatus, paired: false, session: session });

    return session;
  }

  // ── Active Tab Tracking ──
  // The remote drives the active tab of the window the user last focused (a
  // laptop + TV setup is two windows). Commands and media status follow the same
  // rule, so status never comes from one tab while commands land on another.
  var TARGET_TAB = { active: true, lastFocusedWindow: true };

  function withActiveTab(fn) {
    chrome.tabs.query(TARGET_TAB, function (tabs) {
      if (tabs.length > 0) fn(tabs[0]);
    });
  }

  function retarget() {
    withActiveTab(function (tab) {
      if (tab.id === activeTabId) return;
      activeTabId = tab.id;
      mediaFrameId = null;
      mediaPlaying = false;
      mediaPlatform = 'unknown';
      if (paired) {
        requestViewport();
        sendToContentScript({ action: 'requestMediaStatus' }, null);
        setTimeout(handleTabList, 300);
      }
    });
  }

  chrome.tabs.onActivated.addListener(function (info) {
    if (fullscreenTab && info.windowId === fullscreenTab.windowId && info.tabId !== fullscreenTab.tabId) exitFullscreen();
    retarget();
  });

  chrome.windows.onFocusChanged.addListener(function (windowId) {
    // NONE means Chrome lost focus to another app: keep driving the last window.
    if (windowId !== chrome.windows.WINDOW_ID_NONE) retarget();
  });

  retarget();

  // ── Viewport ──
  // Content script reports viewport dimensions so cursor stays in bounds.

  function requestViewport() {
    sendToContentScript({ action: 'getViewport' });
  }

  // ── Transport Handlers ──

  CouchTransport.onStatus(function (status) {
    connStatus = status;
    broadcastToPopup({ type: 'status', status: status, paired: paired, session: session });
    if (status === 'connected' && session) {
      CouchTransport.send({ type: 'session_available' });
    }
  });

  CouchTransport.onMessage(function (msg) {
    if (!msg || !msg.type) return;

    // A disconnected phone may only ask to come back.
    if (session && session.paused && msg.type !== 'hello') return;

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
        sendToContentScript({ action: 'requestMediaStatus' }, null);
        break;
      case 'ping':
        CouchTransport.send({ type: 'pong', ts: Date.now() });
        break;
      case 'session_close':
        handleSessionClose();
        break;
      case 'session_pause':
        pausePhone(false);
        break;
    }
  });

  function handleSessionClose() {
    paired = false;
    CouchTransport.send({ type: 'session_closed' }).then(function () {
      createSession();
    }).catch(createSession);
  }

  // "Disconnect" (popup or phone): the phone keeps its pairing but stays idle
  // until the user taps Reconnect on it. Only a popup disconnect tells the phone.
  function pausePhone(notifyPhone) {
    if (!session) return;
    paired = false;
    session.paused = true;
    saveSession();
    if (notifyPhone) CouchTransport.send({ type: 'session_paused' });
    broadcastToPopup({ type: 'status', status: connStatus, paired: false, session: session });
  }

  // ── Service-worker keepalive ──
  // MV3 service workers are killed after ~30s idle, which drops the broker
  // connection. While a session is active we keep a periodic alarm so the worker
  // is woken and the connection re-established promptly. The alarm also pings
  // the broker: after sleep/wake a socket can claim to be open while dead, and
  // the transport replaces it when the ping goes unanswered.
  var KEEPALIVE_ALARM = 'couchlock-keepalive';

  function startKeepalive() {
    chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  }

  chrome.alarms.onAlarm.addListener(function (alarm) {
    if (alarm.name === KEEPALIVE_ALARM && session) {
      CouchTransport.checkAlive();
    }
  });

  chrome.runtime.onStartup.addListener(function () {
    sessionReady.then(function () {
      if (session) {
        startKeepalive();
        CouchTransport.checkAlive();
      }
    });
  });

  function handleHello(msg) {
    if (session && msg.token === session.token) {
      paired = true;
      if (!session.pairedAt || session.paused) {
        session.pairedAt = session.pairedAt || Date.now();
        session.paused = false;
        saveSession();
      }
      CouchTransport.send({ type: 'ready', ts: Date.now() });
      broadcastToPopup({ type: 'status', status: connStatus, paired: true, session: session });
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

  function reportCommand(command, success, reason) {
    CouchTransport.send({ type: 'cmd_result', command: command, success: success, reason: reason });
  }

  function mediaFrame() {
    return mediaFrameId === null ? 0 : mediaFrameId;
  }

  function handleCommand(msg) {
    var command = msg.action;
    var unreachable = function () { reportCommand(command, false, 'unreachable'); };

    // Browser back/forward: use chrome.tabs.goBack/goForward
    if (command === 'browserBack') {
      withActiveTab(function (tab) { chrome.tabs.goBack(tab.id); });
      return;
    }
    if (command === 'browserForward') {
      withActiveTab(function (tab) { chrome.tabs.goForward(tab.id); });
      return;
    }

    if (command === 'fullscreen') {
      if (fullscreenTab) exitFullscreen();
      else enterFullscreen();
      return;
    }

    // Netflix's player breaks when its <video> is seeked directly, so seek
    // through the page's own player API and fall back to its buttons.
    if (mediaPlatform === 'netflix' && (command === 'seek' || command === 'seekForward' || command === 'seekBack')) {
      var time = msg.data && msg.data.time !== undefined ? msg.data.time : 0;
      var seekArgs = command === 'seek' ? ['absolute', time] : ['relative', command === 'seekForward' ? 10 : -10];
      withActiveTab(function (tab) {
        netflixSeek(tab.id, mediaFrame(), seekArgs[0], seekArgs[1]).then(function (ok) {
          if (ok) reportCommand(command, true);
          else if (command === 'seek') reportCommand(command, false, 'unsupported');
          else sendToContentScript({ action: 'cmd', command: command, data: msg.data }, mediaFrame(), unreachable);
        });
      });
      return;
    }

    // Seek: set video.currentTime directly via content script
    if (command === 'seek') {
      sendToContentScript({ action: 'seek', time: msg.data && msg.data.time !== undefined ? msg.data.time : 0 }, mediaFrame(), unreachable);
      return;
    }

    // Everything else (playPause, skipAd, skipIntro, nextEpisode, mute, volume, etc.)
    // goes straight to the content script which has per-platform selector strategies
    sendToContentScript({ action: 'cmd', command: command, data: msg.data },
      command === 'nextEpisode' && mediaPlatform === 'star' ? 0 : mediaFrame(), unreachable);
  }

  // ── Fullscreen ──
  // requestFullscreen() needs a real user gesture, which a remote can't provide.
  // Instead the browser window goes fullscreen (no gesture needed) and the
  // content script lifts the player into the top layer so it covers the page.

  function saveFullscreenTab() {
    chrome.storage.session.set({ fullscreenTab: fullscreenTab });
  }

  function enterFullscreen() {
    withActiveTab(function (tab) {
      chrome.windows.get(tab.windowId, function (win) {
        if (chrome.runtime.lastError) return;
        fullscreenTab = { tabId: tab.id, windowId: tab.windowId, prevState: win.state };
        saveFullscreenTab();
        if (win.state !== 'fullscreen') chrome.windows.update(tab.windowId, { state: 'fullscreen' });
        deliver(tab.id, { action: 'playerExpand' }, mediaFrame(), function () {
          reportCommand('fullscreen', false, 'unreachable');
        }, true);
      });
    });
  }

  function exitFullscreen() {
    if (!fullscreenTab) return;
    var fs = fullscreenTab;
    fullscreenTab = null;
    saveFullscreenTab();
    chrome.tabs.sendMessage(fs.tabId, { action: 'playerRestore' }, function () {
      if (chrome.runtime.lastError) { /* tab gone or not scriptable */ }
    });
    if (fs.prevState !== 'fullscreen') {
      chrome.windows.update(fs.windowId, { state: fs.prevState }, function () {
        if (chrome.runtime.lastError) { /* window closed */ }
      });
    }
  }

  // ── Netflix ──

  function netflixSeek(tabId, frameId, mode, seconds) {
    return chrome.scripting.executeScript({
      target: { tabId: tabId, frameIds: [frameId] },
      world: 'MAIN',
      func: netflixPlayerSeek,
      args: [mode, seconds]
    }).then(function (results) {
      return !!(results && results[0] && results[0].result);
    }, function () {
      return false;
    });
  }

  // Runs inside the Netflix page (serialised by executeScript): keep it self-contained.
  function netflixPlayerSeek(mode, seconds) {
    try {
      var videoPlayer = window.netflix.appContext.state.playerApp.getAPI().videoPlayer;
      var ids = videoPlayer.getAllPlayerSessionIds();
      var id = ids.filter(function (s) { return s.indexOf('watch') === 0; })[0] || ids[ids.length - 1];
      if (!id) return false;
      var player = videoPlayer.getVideoPlayerBySessionId(id);
      var target = mode === 'absolute' ? seconds * 1000 : player.getCurrentTime() + seconds * 1000;
      player.seek(Math.max(0, Math.min(player.getDuration(), target)));
      return true;
    } catch (e) {
      return false;
    }
  }

  // ── Tabs ──

  function handleTabList() {
    chrome.tabs.query({ lastFocusedWindow: true }, function (tabs) {
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
        mediaFrameId = null;
        mediaPlaying = false;
        mediaPlatform = 'unknown';
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

    withActiveTab(function (tab) {
      chrome.tabs.update(tab.id, { url: url }, function () {
        if (chrome.runtime.lastError) return;
        setTimeout(handleTabList, 500);
      });
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

  // Chrome doesn't re-inject declared content scripts into tabs that were open
  // before the extension was installed or reloaded, so those tabs silently
  // ignore the remote. Inject on demand; pages Chrome won't let us script
  // (chrome://, the Web Store) resolve false.
  function injectContentScript(tabId) {
    if (!injecting[tabId]) {
      injecting[tabId] = chrome.scripting.executeScript({
        target: { tabId: tabId, allFrames: true },
        files: ['content.js']
      }).then(function () {
        return true;
      }, function () {
        return false;
      }).then(function (ok) {
        // Forget failures quickly so a navigation to a scriptable page can retry.
        setTimeout(function () { delete injecting[tabId]; }, ok ? 0 : 3000);
        return ok;
      });
    }
    return injecting[tabId];
  }

  function deliver(tabId, msg, frameId, onUnreachable, retry) {
    var options = frameId === null ? {} : { frameId: frameId === undefined ? 0 : frameId };
    chrome.tabs.sendMessage(tabId, msg, options, function () {
      var error = chrome.runtime.lastError;
      // "Message port closed" just means the content script didn't reply.
      if (!error || (error.message || '').indexOf(RECEIVER_MISSING) === -1) return;
      if (!retry) {
        if (onUnreachable) onUnreachable();
        return;
      }
      injectContentScript(tabId).then(function (ok) {
        if (ok) deliver(tabId, msg, frameId, onUnreachable, false);
        else if (onUnreachable) onUnreachable();
      });
    });
  }

  function sendToContentScript(msg, frameId, onUnreachable) {
    withActiveTab(function (tab) {
      deliver(tab.id, msg, frameId, onUnreachable, true);
    });
  }

  chrome.runtime.onInstalled.addListener(function () {
    chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] }, function (tabs) {
      tabs.forEach(function (tab) {
        if (!tab.discarded) injectContentScript(tab.id);
      });
    });
  });

  // Listen for messages FROM content script and popup
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg.type === 'getSession') {
      sessionReady.then(function () {
        sendResponse({ session: session, paired: paired, status: connStatus });
      });
      return true;
    }

    if (msg.type === 'newSession') {
      sessionReady.then(function () {
        function finish() {
          createSession();
          sendResponse({ session: session });
        }
        if (paired) CouchTransport.send({ type: 'session_closed' }).then(finish).catch(finish);
        else finish();
      });
      return true;
    }

    if (msg.type === 'pausePhone') {
      sessionReady.then(function () {
        pausePhone(true);
        sendResponse({ session: session });
      });
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

    if (msg.type === 'playerRestored') {
      // The user left fullscreen on the laptop (Esc); give the window back too.
      if (fullscreenTab && sender.tab && sender.tab.id === fullscreenTab.tabId) exitFullscreen();
    }

    // A frame asks its parent frame to lift the <iframe> holding it.
    if (msg.type === 'expandMyFrame' && sender.tab && sender.frameId) {
      chrome.tabs.sendMessage(sender.tab.id, { action: 'expandChildFrame', frameId: sender.frameId }, function () {
        if (chrome.runtime.lastError) { /* frame went away */ }
      });
    }

    if (msg.type === 'mediaStatus') {
      if (sender.tab && sender.tab.id !== activeTabId) return;
      var frameId = sender.frameId || 0;
      var hasMedia = msg.platform && msg.platform !== 'unknown';
      var reportedPlatform = msg.platform;
      if (hasMedia && reportedPlatform === 'universal' && sender.tab &&
          /^https:\/\/([^.]+\.)?star\.gr\//.test(sender.tab.url || '')) {
        reportedPlatform = 'star';
      }
      if (hasMedia) {
        // Keep a playing frame selected over an idle video in another frame.
        if (mediaFrameId !== null && mediaFrameId !== frameId && mediaPlaying && !msg.playing) return;
        mediaFrameId = frameId;
        mediaPlaying = !!msg.playing;
        mediaPlatform = reportedPlatform;
      } else if (mediaFrameId === frameId) {
        mediaFrameId = null;
        mediaPlaying = false;
        mediaPlatform = 'unknown';
      } else if (mediaFrameId !== null || frameId !== 0) {
        return;
      }

      CouchTransport.send({
        type: 'media_status',
        platform: reportedPlatform,
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
      reportCommand(msg.command, msg.success, msg.reason);
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

  chrome.tabs.onRemoved.addListener(function (tabId) {
    if (fullscreenTab && fullscreenTab.tabId === tabId) exitFullscreen();
    if (paired) setTimeout(handleTabList, 300);
  });

  chrome.tabs.onUpdated.addListener(function (tabId, changeInfo) {
    if (tabId === activeTabId && changeInfo.status === 'loading') {
      mediaFrameId = null;
      mediaPlaying = false;
      mediaPlatform = 'unknown';
    }
    if (paired && changeInfo.title) {
      setTimeout(handleTabList, 300);
    }
  });

  // ── Init ──

  chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  chrome.storage.session.get('fullscreenTab', function (data) {
    if (data && data.fullscreenTab) fullscreenTab = data.fullscreenTab;
  });
  chrome.storage.local.get('session', function (data) {
    if (data && data.session) {
      session = data.session;
      paired = !!session.pairedAt && !session.paused;
      connectSession();
      resolveSessionReady();
      return;
    }
    // Keep a pairing made before this update if Chrome has not restarted yet.
    chrome.storage.session.get('session', function (legacy) {
      if (legacy && legacy.session) {
        session = legacy.session;
        saveSession();
        connectSession();
      }
      resolveSessionReady();
    });
  });

})();
