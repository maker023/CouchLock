/**
 * CouchLock — Popup Script (IIFE)
 *
 * Renders QR code for pairing, displays connection status.
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
  var btnDisconnect = document.getElementById('btn-disconnect');

  // ── State ──
  var currentSession = null;

  // ── Status Display ──

  function setStatus(status, isPaired) {
    statusDot.className = 'status-dot';

    if (isPaired) {
      statusDot.classList.add('connected');
      statusText.textContent = 'Connected';
      unpairedEl.classList.add('hidden');
      pairedEl.classList.remove('hidden');
      if (currentSession) {
        pairedSession.textContent = 'Session: ' + currentSession.id;
      }
    } else {
      unpairedEl.classList.remove('hidden');
      pairedEl.classList.add('hidden');

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

  btnDisconnect.addEventListener('click', function () {
    requestNewSession();
  });

  // Listen for status, theme, and sticker updates from background
  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg.type === 'status') {
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
