/**
 * CouchLock — Popup Script (IIFE)
 *
 * Renders QR code for pairing, displays connection status.
 * While open, makes this laptop discoverable to nearby phones (CouchDiscovery)
 * and asks the user to confirm each pairing request.
 * Syncs theme and stickers from PWA.
 * Communicates with background.js via chrome.runtime.
 */
(function () {
  'use strict';

  // ── PWA Base URL — change this when deploying ──
  var PWA_URL = 'https://maker023.github.io/CouchLock/';

  // ── DOM References ──
  var statusDot = document.getElementById('status-dot');
  var statusText = document.getElementById('status-text');
  var unpairedEl = document.getElementById('unpaired');
  var pairedEl = document.getElementById('paired');
  var pairedSession = document.getElementById('paired-session');
  var qrCanvas = document.getElementById('qr-canvas');
  var btnNewSession = document.getElementById('btn-new-session');
  var btnCopyLink = document.getElementById('btn-copy-link');
  var btnDisconnect = document.getElementById('btn-disconnect');
  var btnForget = document.getElementById('btn-forget');
  var pairedTitle = document.getElementById('paired-title');
  var requestEl = document.getElementById('request');
  var requestTitle = document.getElementById('request-title');
  var requestCode = document.getElementById('request-code');
  var btnAllow = document.getElementById('btn-allow');
  var btnDecline = document.getElementById('btn-decline');

  // ── State ──
  var currentSession = null;
  var lastStatus = 'disconnected';
  var lastPaired = false;
  var pendingRequest = null;
  var discoveryHost = null;

  // ── Status Display ──

  function setStatus(status, isPaired) {
    lastStatus = status;
    lastPaired = isPaired;
    statusDot.className = 'status-dot';

    // A pairing request takes over the popup until it's answered.
    if (pendingRequest) {
      requestEl.classList.remove('hidden');
      unpairedEl.classList.add('hidden');
      pairedEl.classList.add('hidden');
    } else {
      requestEl.classList.add('hidden');
    }

    var hasPhone = !!(currentSession && currentSession.pairedAt);
    var paused = !!(currentSession && currentSession.paused);

    if (hasPhone) {
      if (!pendingRequest) {
        unpairedEl.classList.add('hidden');
        pairedEl.classList.remove('hidden');
      }
      pairedSession.textContent = paused ? 'Tap Reconnect on your phone to continue' : 'Session: ' + currentSession.id;
      pairedTitle.textContent = paused ? 'Phone disconnected' : (isPaired ? 'Phone connected' : 'Phone paired');
      btnDisconnect.classList.toggle('hidden', paused);

      if (status !== 'connected') {
        statusDot.classList.add('connecting');
        statusText.textContent = 'Connecting to relay...';
      } else if (isPaired) {
        statusDot.classList.add('connected');
        statusText.textContent = 'Connected';
      } else {
        statusText.textContent = paused ? 'Disconnected' : 'Waiting for phone...';
      }
    } else {
      if (!pendingRequest) {
        unpairedEl.classList.remove('hidden');
        pairedEl.classList.add('hidden');
      }

      if (status === 'connected') {
        statusDot.classList.add('connecting');
        statusText.textContent = 'Waiting for phone...';
      } else if (status === 'connecting' || status === 'reconnecting') {
        statusDot.classList.add('connecting');
        statusText.textContent = 'Connecting to relay...';
      } else if (status === 'failed') {
        statusText.textContent = 'Connection failed';
      } else {
        statusText.textContent = 'Disconnected';
      }
    }
  }

  // ── Theme Sync ──

  function applyTheme(theme) {
    if (!theme) return;
    var root = document.documentElement;

    // Compute hex from accent RGB
    var parts = theme.accent.split(',');
    var r = parseInt(parts[0], 10);
    var g = parseInt(parts[1], 10);
    var b = parseInt(parts[2], 10);
    var accentHex = '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toUpperCase();

    root.style.setProperty('--void', theme.voidHex);
    root.style.setProperty('--void-rgb', theme.voidRgb);
    root.style.setProperty('--ink', theme.inkHex);
    root.style.setProperty('--accent', accentHex);
    root.style.setProperty('--accent-rgb', theme.accent);
    root.style.setProperty('--ui-rgb', theme.ui);
  }

  function loadTheme() {
    chrome.storage.local.get('theme', function (data) {
      if (data && data.theme) {
        applyTheme(data.theme);
      }
    });
  }

  // ── Sticker Rendering ──

  function renderStickers(stickers) {
    var layer = document.getElementById('sticker-layer-global');
    if (!layer) return;
    layer.innerHTML = '';

    if (!stickers || stickers.length === 0) return;

    for (var i = 0; i < stickers.length; i++) {
      var s = stickers[i];
      var wrap = document.createElement('div');
      wrap.className = 'popup-sticker-wrap';
      wrap.style.left = s.x + '%';
      wrap.style.top = s.y + '%';
      wrap.style.width = s.width + '%';
      wrap.style.zIndex = s.zIndex;

      // Resolve src — data URLs are absolute, file paths need PWA prefix
      var stickerSrc = (s.src.indexOf('data:') === 0) ? s.src : PWA_URL + s.src;

      // Shadow layer
      var shadow = document.createElement('img');
      shadow.className = 'popup-sticker-shadow';
      shadow.src = stickerSrc;
      shadow.alt = '';
      shadow.draggable = false;
      wrap.appendChild(shadow);

      // Sticker image
      var img = document.createElement('img');
      img.src = stickerSrc;
      img.alt = '';
      img.draggable = false;
      img.style.position = 'relative';
      img.style.zIndex = '1';
      wrap.appendChild(img);

      layer.appendChild(wrap);
    }
  }

  function loadStickers() {
    chrome.storage.local.get('stickers', function (data) {
      if (data && data.stickers) {
        renderStickers(data.stickers);
      }
    });
  }

  // ── QR Code Generation ──

  function renderQR(session) {
    if (!session) return;

    var url = PWA_URL + '?t=' + session.token + '&s=' + session.id;
    var ctx = qrCanvas.getContext('2d');

    if (typeof qrcode !== 'undefined') {
      var qr = qrcode(0, 'M');
      qr.addData(url);
      qr.make();

      var size = qr.getModuleCount();
      var cellSize = Math.floor(144 / size);
      var offset = Math.floor((160 - size * cellSize) / 2);

      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, 160, 160);
      ctx.fillStyle = '#0A0B10';

      for (var r = 0; r < size; r++) {
        for (var c = 0; c < size; c++) {
          if (qr.isDark(r, c)) {
            ctx.fillRect(offset + c * cellSize, offset + r * cellSize, cellSize, cellSize);
          }
        }
      }
    } else {
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, 160, 160);
      ctx.fillStyle = '#0A0B10';
      ctx.font = '9px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('QR lib not loaded', 80, 70);
      ctx.fillText('Open PWA manually:', 80, 85);
      ctx.font = '7px monospace';

      var line = '';
      var y = 100;
      for (var i = 0; i < url.length; i++) {
        line += url[i];
        if (line.length > 28 || i === url.length - 1) {
          ctx.fillText(line, 80, y);
          y += 10;
          line = '';
        }
      }
    }
  }

  // ── Nearby Pairing ──

  function deviceName() {
    var os = navigator.userAgentData && navigator.userAgentData.platform
      ? navigator.userAgentData.platform
      : navigator.platform;
    return os ? 'Chrome on ' + os : 'Chrome';
  }

  function startDiscovery() {
    var code = CouchDiscovery.newCode();
    var codeText = code.slice(0, 3) + ' ' + code.slice(3);
    Array.prototype.forEach.call(document.querySelectorAll('.pairing-code'), function (el) {
      el.textContent = codeText;
    });

    discoveryHost = CouchDiscovery.host({
      name: deviceName(),
      code: code,
      onRequest: function (request) {
        pendingRequest = request;
        requestTitle.textContent = request.name + ' wants to connect';
        requestCode.textContent = request.code;
        setStatus(lastStatus, lastPaired);
        btnAllow.focus();
      }
    });
    window.addEventListener('pagehide', function () {
      if (pendingRequest) pendingRequest.decline();
      discoveryHost.stop();
    });
  }

  function answerRequest(allow) {
    if (!pendingRequest) return;
    if (allow && currentSession) {
      pendingRequest.accept({ token: currentSession.token, sessionId: currentSession.id });
    } else {
      pendingRequest.decline();
    }
    pendingRequest = null;
    setStatus(lastStatus, lastPaired);
  }

  // ── Init ──

  function init() {
    loadTheme();
    loadStickers();

    chrome.runtime.sendMessage({ type: 'getSession' }, function (response) {
      if (chrome.runtime.lastError) {
        requestNewSession();
        return;
      }

      if (response && response.session) {
        currentSession = response.session;
        renderQR(currentSession);
        setStatus(response.status, response.paired);
      } else {
        requestNewSession();
      }
    });
    startDiscovery();
  }

  function requestNewSession() {
    chrome.runtime.sendMessage({ type: 'newSession' }, function (response) {
      if (response && response.session) {
        currentSession = response.session;
        renderQR(currentSession);
        setStatus('connecting', false);
      }
    });
  }

  // ── Event Listeners ──

  btnNewSession.addEventListener('click', function () {
    requestNewSession();
  });

  btnCopyLink.addEventListener('click', function () {
    if (!currentSession) return;
    var url = PWA_URL + '?t=' + currentSession.token + '&s=' + currentSession.id;
    navigator.clipboard.writeText(url).then(function () {
      btnCopyLink.textContent = 'Copied';
      setTimeout(function () { btnCopyLink.textContent = 'Copy Pairing Link'; }, 1800);
    }).catch(function () {
      btnCopyLink.textContent = 'Copy failed';
      setTimeout(function () { btnCopyLink.textContent = 'Copy Pairing Link'; }, 1800);
    });
  });

  // Disconnect keeps the pairing; the phone can come back with one tap.
  btnDisconnect.addEventListener('click', function () {
    chrome.runtime.sendMessage({ type: 'pausePhone' }, function (response) {
      if (response && response.session) {
        currentSession = response.session;
        setStatus(lastStatus, false);
      }
    });
  });

  // Forget rotates the token: every paired phone has to pair again.
  btnForget.addEventListener('click', function () {
    requestNewSession();
  });

  btnAllow.addEventListener('click', function () { answerRequest(true); });
  btnDecline.addEventListener('click', function () { answerRequest(false); });

  // Listen for status, theme, and sticker updates from background
  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg.type === 'status') {
      if (msg.session) {
        if (!currentSession || msg.session.token !== currentSession.token) renderQR(msg.session);
        currentSession = msg.session;
      }
      setStatus(msg.status, msg.paired);
    }
    if (msg.type === 'theme_update') {
      applyTheme(msg.theme);
    }
    if (msg.type === 'sticker_update') {
      renderStickers(msg.stickers);
    }
  });

  // ── Start ──
  init();

})();
