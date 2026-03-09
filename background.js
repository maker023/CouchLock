/**
 * CouchLock — Background Service Worker (MV3)
 *
 * Responsibilities:
 *   - Session generation (token + session ID)
 *   - WebSocket relay connection via CouchTransport
 *   - Message routing: phone → content script, content script → phone
 *   - Cursor state tracking (x, y position)
 *   - chrome.debugger attachment for trusted input events
 *   - Tab management commands
 */
importScripts('transport.js');

(function () {
  'use strict';

  // ── Session State ──
  var session = null;   // { id, token, created }
  var paired = false;
  var debugTabId = null; // tab with debugger attached
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
      case 'ping':
        CouchTransport.send({ type: 'pong', ts: Date.now() });
        break;
    }
  });

  function handleHello(msg) {
    if (msg.token === session.token) {
      paired = true;
      CouchTransport.send({ type: 'ready', ts: Date.now() });
      broadcastToPopup({ type: 'status', status: connStatus, paired: true });
      attachDebugger();
    }
  }

  // ── Debugger (Trusted Input Events) ──

  function attachDebugger() {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (tabs.length === 0) return;
      var tabId = tabs[0].tabId || tabs[0].id;
      if (debugTabId === tabId) return;

      if (debugTabId !== null) {
        try { chrome.debugger.detach({ tabId: debugTabId }); } catch (e) { /* ignore */ }
      }

      chrome.debugger.attach({ tabId: tabId }, '1.3', function () {
        if (chrome.runtime.lastError) {
          // debugger attach failed — fall back to content script events
          debugTabId = null;
          return;
        }
        debugTabId = tabId;

        // Get viewport size
        chrome.debugger.sendCommand({ tabId: tabId }, 'Runtime.evaluate', {
          expression: 'JSON.stringify({ w: window.innerWidth, h: window.innerHeight })'
        }, function (result) {
          if (result && result.result && result.result.value) {
            try {
              var vp = JSON.parse(result.result.value);
              viewportW = vp.w;
              viewportH = vp.h;
              cursorX = Math.round(viewportW / 2);
              cursorY = Math.round(viewportH / 2);
            } catch (e) { /* ignore */ }
          }
        });
      });
    });
  }

  // Listen for tab changes to reattach debugger
  chrome.tabs.onActivated.addListener(function () {
    if (paired) attachDebugger();
  });

  // ── Input Dispatch ──

  function dispatchMouse(type, x, y, button, clickCount) {
    if (debugTabId === null) {
      // Fallback: send to content script
      sendToContentScript({
        action: 'mouse',
        mouseType: type,
        x: x,
        y: y,
        button: button || 'left',
        clickCount: clickCount || 0
      });
      return;
    }

    chrome.debugger.sendCommand({ tabId: debugTabId }, 'Input.dispatchMouseEvent', {
      type: type,
      x: x,
      y: y,
      button: button || 'none',
      clickCount: clickCount || 0
    }, function () {
      if (chrome.runtime.lastError) {
        // Debugger detached — reattach on next action
        debugTabId = null;
      }
    });
  }

  function dispatchKey(type, key, code, modifiers) {
    if (debugTabId === null) {
      sendToContentScript({
        action: 'key',
        keyType: type,
        key: key,
        code: code,
        modifiers: modifiers || 0
      });
      return;
    }

    var params = {
      type: type,
      key: key,
      code: code,
      modifiers: modifiers || 0
    };

    // For printable characters, add text and unmodifiedText
    if (type === 'keyDown' && key.length === 1) {
      params.text = key;
      params.unmodifiedText = key;
    }

    chrome.debugger.sendCommand({ tabId: debugTabId }, 'Input.dispatchKeyEvent', params, function () {
      if (chrome.runtime.lastError) {
        debugTabId = null;
      }
    });
  }

  function dispatchScroll(x, y, deltaX, deltaY) {
    if (debugTabId === null) {
      sendToContentScript({ action: 'scroll', deltaX: deltaX, deltaY: deltaY });
      return;
    }

    chrome.debugger.sendCommand({ tabId: debugTabId }, 'Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: x,
      y: y,
      deltaX: deltaX,
      deltaY: deltaY
    });
  }

  // ── Command Handlers ──

  function handleMouseMove(msg) {
    var dx = msg.dx || 0;
    var dy = msg.dy || 0;
    var sensitivity = msg.sensitivity || 1;

    cursorX = Math.max(0, Math.min(viewportW, cursorX + dx * sensitivity));
    cursorY = Math.max(0, Math.min(viewportH, cursorY + dy * sensitivity));

    dispatchMouse('mouseMoved', Math.round(cursorX), Math.round(cursorY));
  }

  function handleClick(msg) {
    var x = Math.round(cursorX);
    var y = Math.round(cursorY);
    dispatchMouse('mousePressed', x, y, 'left', 1);
    dispatchMouse('mouseReleased', x, y, 'left', 1);
  }

  function handleRightClick(msg) {
    var x = Math.round(cursorX);
    var y = Math.round(cursorY);
    dispatchMouse('mousePressed', x, y, 'right', 1);
    dispatchMouse('mouseReleased', x, y, 'right', 1);
  }

  function handleScroll(msg) {
    var dx = msg.dx || 0;
    var dy = msg.dy || 0;
    dispatchScroll(Math.round(cursorX), Math.round(cursorY), dx, dy);
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

  function handleCommand(msg) {
    // Media and utility commands → content script
    sendToContentScript({ action: 'cmd', command: msg.action, data: msg.data });
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
        if (paired) attachDebugger();
      });
    }
  }

  // ── Content Script Communication ──

  function sendToContentScript(msg) {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (tabs.length > 0) {
        chrome.tabs.sendMessage(tabs[0].id, msg, function () {
          // Ignore errors (content script may not be injected)
          if (chrome.runtime.lastError) { /* ignore */ }
        });
      }
    });
  }

  // Listen for messages FROM content script (status updates, etc.)
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg.type === 'getSession') {
      sendResponse({ session: session, paired: paired, status: connStatus });
      return true;
    }

    if (msg.type === 'newSession') {
      createSession();
      sendResponse({ session: session });
      return true;
    }

    if (msg.type === 'mediaStatus') {
      // Forward media status to phone
      CouchTransport.send({
        type: 'media_status',
        platform: msg.platform,
        title: msg.title,
        playing: msg.playing,
        currentTime: msg.currentTime,
        duration: msg.duration
      });
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

  // ── Init ──

  // Restore session from storage on service worker wake
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
