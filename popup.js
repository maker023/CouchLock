/**
 * CouchLock — Popup Script (IIFE)
 *
 * Renders QR code for pairing, displays connection status.
 * Communicates with background.js via chrome.runtime.
 */
(function () {
  'use strict';

  // ── PWA Base URL — change this when deploying ──
  var PWA_URL = 'https://localhost:8080/pwa/';

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

  // ── QR Code Generation ──

  function renderQR(session) {
    if (!session) return;

    var url = PWA_URL + '?t=' + session.token + '&s=' + session.id;
    var ctx = qrCanvas.getContext('2d');

    // Use qrcode-generator if available
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
      // Fallback: show URL as text
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, 160, 160);
      ctx.fillStyle = '#0A0B10';
      ctx.font = '9px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('QR lib not loaded', 80, 70);
      ctx.fillText('Open PWA manually:', 80, 85);
      ctx.font = '7px monospace';

      // Word wrap the URL
      var words = url.split('');
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
    chrome.runtime.sendMessage({ type: 'getSession' }, function (response) {
      if (chrome.runtime.lastError) {
        // Background not ready, create new session
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

  // Listen for status updates from background
  chrome.runtime.onMessage.addListener(function (msg) {
    if (msg.type === 'status') {
      setStatus(msg.status, msg.paired);
    }
  });

  // ── Start ──
  init();

})();
