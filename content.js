/**
 * CouchLock — Content Script (IIFE)
 *
 * Injected per streaming platform at document_idle.
 * Receives commands from background.js via chrome.runtime.
 *
 * Responsibilities:
 *   - Platform detection
 *   - Media control strategies (per-platform DOM selectors + keyboard fallbacks)
 *   - Status reporting (playing, title, progress)
 *   - Fallback mouse/keyboard event dispatch (when debugger unavailable)
 *   - Cursor overlay rendering
 *   - Input focus detection (for keyboard overlay on PWA)
 *   - Skip Ad availability reporting (YouTube, manual only)
 */
(function () {
  'use strict';

  // ── Context Guard ──
  // When the extension reloads, the content script's context is invalidated.
  // All chrome.runtime calls will throw. We wrap sendMessage to catch this
  // and self-cleanup intervals to stop the errors.

  var contextValid = true;

  function isContextValid() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  function safeSendMessage(msg, callback) {
    if (!contextValid || !isContextValid()) {
      contextValid = false;
      clearAllIntervals();
      return;
    }
    try {
      chrome.runtime.sendMessage(msg, function (response) {
        if (chrome.runtime.lastError) {
          var errMsg = chrome.runtime.lastError.message || '';
          if (errMsg.indexOf('context invalidated') !== -1 || errMsg.indexOf('Extension context') !== -1) {
            contextValid = false;
            clearAllIntervals();
          }
        }
        if (callback) callback(response);
      });
    } catch (e) {
      contextValid = false;
      clearAllIntervals();
    }
  }

  var registeredIntervals = [];

  function safeSetInterval(fn, ms) {
    var id = setInterval(function () {
      if (!contextValid) {
        clearInterval(id);
        return;
      }
      fn();
    }, ms);
    registeredIntervals.push(id);
    return id;
  }

  function clearAllIntervals() {
    for (var i = 0; i < registeredIntervals.length; i++) {
      clearInterval(registeredIntervals[i]);
    }
    registeredIntervals = [];
  }

  // ── Cursor Overlay ──
  // Smoothed rendering via requestAnimationFrame.
  // Uses left/top for position (proven reliable across all sites)
  // with transform: translate(-50%,-50%) for centering only.
  // Exponential lerp smooths the movement across frames.

  var cursorEl = null;
  var cursorRipple = null;
  var cursorHideTimer = null;
  var cursorSize = 16;
  var cursorColor = '79,82,224';

  // Smoothing state
  var targetX = 0, targetY = 0;
  var smoothX = 0, smoothY = 0;
  var animating = false;
  var cursorVisible = false;
  var LERP = 0.35;

  function createCursorOverlay() {
    cursorEl = document.createElement('div');
    cursorEl.id = 'couchlock-cursor';
    cursorEl.style.cssText = buildCursorCSS();
    document.documentElement.appendChild(cursorEl);

    cursorRipple = document.createElement('div');
    cursorRipple.id = 'couchlock-ripple';
    cursorRipple.style.cssText = [
      'position:fixed',
      'width:40px',
      'height:40px',
      'border-radius:50%',
      'border:2px solid rgba(' + cursorColor + ',0.5)',
      'pointer-events:none',
      'z-index:2147483646',
      'transform:translate(-50%,-50%) scale(0)',
      'opacity:0',
      'display:none'
    ].join(';');
    document.documentElement.appendChild(cursorRipple);
  }

  function buildCursorCSS() {
    return [
      'position:fixed',
      'width:' + cursorSize + 'px',
      'height:' + cursorSize + 'px',
      'border-radius:50%',
      'background:rgba(' + cursorColor + ',0.85)',
      'box-shadow:0 0 ' + Math.round(cursorSize * 0.75) + 'px rgba(' + cursorColor + ',0.6),0 0 ' + Math.round(cursorSize * 2) + 'px rgba(' + cursorColor + ',0.2)',
      'pointer-events:none',
      'z-index:2147483647',
      'transform:translate(-50%,-50%)',
      'display:none',
      'left:0px',
      'top:0px'
    ].join(';');
  }

  function renderCursor() {
    smoothX += (targetX - smoothX) * LERP;
    smoothY += (targetY - smoothY) * LERP;

    cursorEl.style.left = smoothX.toFixed(1) + 'px';
    cursorEl.style.top = smoothY.toFixed(1) + 'px';

    var dx = targetX - smoothX;
    var dy = targetY - smoothY;
    if (dx * dx + dy * dy > 0.25) {
      requestAnimationFrame(renderCursor);
    } else {
      smoothX = targetX;
      smoothY = targetY;
      cursorEl.style.left = smoothX + 'px';
      cursorEl.style.top = smoothY + 'px';
      animating = false;
    }
  }

  function ensureCursorInDOM() {
    // SPA navigations (Netflix, YouTube, etc.) can remove our element from
    // the DOM while we still hold a JS reference to it.  Detect & recreate.
    if (cursorEl && !document.documentElement.contains(cursorEl)) {
      cursorEl = null;
      cursorRipple = null;
      cursorVisible = false;
    }
    if (!cursorEl) createCursorOverlay();
  }

  function moveCursor(x, y) {
    ensureCursorInDOM();

    targetX = x;
    targetY = y;

    if (!cursorVisible) {
      cursorVisible = true;
      smoothX = targetX;
      smoothY = targetY;
      cursorEl.style.display = 'block';
      cursorEl.style.left = smoothX + 'px';
      cursorEl.style.top = smoothY + 'px';
    }

    if (!animating) {
      animating = true;
      requestAnimationFrame(renderCursor);
    }

    if (cursorHideTimer) clearTimeout(cursorHideTimer);
    cursorHideTimer = setTimeout(function () {
      if (cursorEl) {
        cursorEl.style.display = 'none';
        cursorVisible = false;
      }
    }, 3000);
  }

  function clickFeedback(x, y) {
    if (!cursorRipple) return;
    cursorRipple.style.display = 'block';
    cursorRipple.style.transition = 'none';
    cursorRipple.style.left = x + 'px';
    cursorRipple.style.top = y + 'px';
    cursorRipple.style.transform = 'translate(-50%,-50%) scale(0)';
    cursorRipple.style.opacity = '1';
    void cursorRipple.offsetWidth;
    cursorRipple.style.transition = 'transform 300ms cubic-bezier(0.22,1,0.36,1), opacity 300ms cubic-bezier(0.22,1,0.36,1)';
    cursorRipple.style.transform = 'translate(-50%,-50%) scale(1)';
    cursorRipple.style.opacity = '0';
  }

  function updateCursorSettings(settings) {
    if (settings.size) cursorSize = settings.size;
    if (settings.color) cursorColor = settings.color;
    ensureCursorInDOM();
    if (cursorEl) {
      // Rebuild only the visual properties, preserve position and display state
      cursorEl.style.width = cursorSize + 'px';
      cursorEl.style.height = cursorSize + 'px';
      cursorEl.style.background = 'rgba(' + cursorColor + ',0.85)';
      cursorEl.style.boxShadow = '0 0 ' + Math.round(cursorSize * 0.75) + 'px rgba(' + cursorColor + ',0.6),0 0 ' + Math.round(cursorSize * 2) + 'px rgba(' + cursorColor + ',0.2)';
    }
    if (cursorRipple) {
      cursorRipple.style.borderColor = 'rgba(' + cursorColor + ',0.5)';
    }
  }

  // ── Platform Detection ──

  var host = window.location.hostname;
  var platform = 'unknown';

  if (host.indexOf('netflix.com') !== -1) platform = 'netflix';
  else if (host.indexOf('max.com') !== -1 || host.indexOf('hbomax.com') !== -1) platform = 'hbo';
  else if (host.indexOf('youtube.com') !== -1) platform = 'youtube';
  else if (host.indexOf('disneyplus.com') !== -1) platform = 'disney';
  else if (host.indexOf('hulu.com') !== -1) platform = 'hulu';
  else if (document.querySelector('video')) platform = 'universal';

  // ── Selector Strategies ──

  var S = {
    netflix: {
      playPause: [
        { type: 'selector', value: '[data-uia="control-play-pause-pause"], [data-uia="control-play-pause-play"]' },
        { type: 'selector', value: 'button.watch-video--play-pause-btn' },
        { type: 'key', value: { key: ' ', code: 'Space' } }
      ],
      seekForward: [
        { type: 'selector', value: '[data-uia="control-forward10"]' },
        { type: 'key', value: { key: 'ArrowRight', code: 'ArrowRight' } }
      ],
      seekBack: [
        { type: 'selector', value: '[data-uia="control-back10"]' },
        { type: 'key', value: { key: 'ArrowLeft', code: 'ArrowLeft' } }
      ],
      skipIntro: [
        { type: 'selector', value: '[data-uia="player-skip-intro"]' },
        { type: 'selector', value: '.skip-credits > a' }
      ],
      nextEpisode: [
        { type: 'selector', value: '[data-uia="next-episode-seamless-button"]' },
        { type: 'selector', value: '[data-uia="next-episode-seamless-button-draining"]' }
      ],
      fullscreen: [
        { type: 'selector', value: '[data-uia="control-fullscreen-enter"], [data-uia="control-fullscreen-exit"]' },
        { type: 'key', value: { key: 'f', code: 'KeyF' } }
      ],
      mute: [
        { type: 'selector', value: '[data-uia="control-mute-unmute"]' },
        { type: 'key', value: { key: 'm', code: 'KeyM' } }
      ]
    },

    hbo: {
      playPause: [
        { type: 'selector', value: '[data-testid="player-ux-play-pause-button"]' },
        { type: 'selector', value: '[data-focusid="playback_play"]' },
        { type: 'aria', value: 'Play' },
        { type: 'aria', value: 'Pause' },
        { type: 'key', value: { key: ' ', code: 'Space' } }
      ],
      seekForward: [
        { type: 'selector', value: '[data-testid="player-ux-skip-forward-button"]' },
        { type: 'selector', value: '[data-focusid="playback_ff"]' },
        { type: 'aria', value: 'Skip ahead 10 seconds' },
        { type: 'key', value: { key: 'ArrowRight', code: 'ArrowRight' } }
      ],
      seekBack: [
        { type: 'selector', value: '[data-testid="player-ux-skip-back-button"]' },
        { type: 'selector', value: '[data-focusid="playback_rw"]' },
        { type: 'aria', value: 'Skip back 10 seconds' },
        { type: 'key', value: { key: 'ArrowLeft', code: 'ArrowLeft' } }
      ],
      skipIntro: [
        { type: 'selector', value: '[data-testid="player-ux-skip-button"]' },
        { type: 'selector', value: 'button[class*="SkipButton"]' },
        { type: 'aria', value: 'Skip Intro' },
        { type: 'aria', value: 'Skip' }
      ],
      nextEpisode: [
        { type: 'aria', value: 'Next Episode' },
        { type: 'aria', value: 'Up Next' }
      ],
      fullscreen: [
        { type: 'selector', value: '[data-testid="player-ux-fullscreen-button"]' },
        { type: 'aria', value: 'Full Screen' },
        { type: 'aria', value: 'Exit Full Screen' },
        { type: 'key', value: { key: 'f', code: 'KeyF' } }
      ],
      mute: [
        { type: 'selector', value: '[data-testid="player-ux-volume-button"]' },
        { type: 'aria', value: 'Mute' },
        { type: 'aria', value: 'Unmute' },
        { type: 'key', value: { key: 'm', code: 'KeyM' } }
      ]
    },

    youtube: {
      playPause: [
        { type: 'selector', value: '.ytp-play-button' },
        { type: 'key', value: { key: 'k', code: 'KeyK' } }
      ],
      seekForward: [
        { type: 'key', value: { key: 'l', code: 'KeyL' } }
      ],
      seekBack: [
        { type: 'key', value: { key: 'j', code: 'KeyJ' } }
      ],
      skipAd: [
        { type: 'selector', value: '.ytp-skip-ad-button' },
        { type: 'selector', value: '.ytp-ad-skip-button' },
        { type: 'selector', value: '.ytp-ad-skip-button-modern' },
        { type: 'selector', value: 'button.ytp-ad-skip-button-modern' },
        { type: 'selector', value: '[id^="skip-button"]' },
        { type: 'selector', value: '.videoAdUiSkipButton' }
      ],
      skipIntro: [],
      nextEpisode: [
        { type: 'selector', value: '.ytp-next-button' },
        { type: 'key', value: { key: 'N', code: 'KeyN', modifiers: 1 } }
      ],
      fullscreen: [
        { type: 'selector', value: '.ytp-fullscreen-button' },
        { type: 'key', value: { key: 'f', code: 'KeyF' } }
      ],
      mute: [
        { type: 'selector', value: '.ytp-mute-button' },
        { type: 'key', value: { key: 'm', code: 'KeyM' } }
      ]
    },

    disney: {
      playPause: [
        { type: 'aria', value: 'Play' },
        { type: 'aria', value: 'Pause' },
        { type: 'key', value: { key: ' ', code: 'Space' } }
      ],
      seekForward: [
        { type: 'aria', value: 'Skip Forward' },
        { type: 'key', value: { key: 'ArrowRight', code: 'ArrowRight' } }
      ],
      seekBack: [
        { type: 'aria', value: 'Rewind' },
        { type: 'key', value: { key: 'ArrowLeft', code: 'ArrowLeft' } }
      ],
      skipIntro: [
        { type: 'selector', value: 'button[data-testid="skip-intro"]' },
        { type: 'aria', value: 'Skip Intro' }
      ],
      nextEpisode: [
        { type: 'aria', value: 'Next Episode' }
      ],
      fullscreen: [
        { type: 'aria', value: 'Full screen' },
        { type: 'aria', value: 'Exit full screen' },
        { type: 'key', value: { key: 'f', code: 'KeyF' } }
      ],
      mute: [
        { type: 'aria', value: 'Mute' },
        { type: 'aria', value: 'Unmute' }
      ]
    },

    hulu: {
      playPause: [
        { type: 'selector', value: '[data-automationid="play-pause-button"]' },
        { type: 'key', value: { key: ' ', code: 'Space' } }
      ],
      seekForward: [
        { type: 'selector', value: '[data-automationid="forward-button"]' },
        { type: 'key', value: { key: 'ArrowRight', code: 'ArrowRight' } }
      ],
      seekBack: [
        { type: 'selector', value: '[data-automationid="back-button"]' },
        { type: 'key', value: { key: 'ArrowLeft', code: 'ArrowLeft' } }
      ],
      skipIntro: [
        { type: 'selector', value: 'button[class*="skip"]' }
      ],
      nextEpisode: [],
      fullscreen: [
        { type: 'selector', value: '[data-automationid="fullscreen-button"]' },
        { type: 'key', value: { key: 'f', code: 'KeyF' } }
      ],
      mute: [
        { type: 'key', value: { key: 'm', code: 'KeyM' } }
      ]
    },

    universal: {
      playPause: [
        { type: 'video', value: 'toggle' },
        { type: 'key', value: { key: ' ', code: 'Space' } }
      ],
      seekForward: [
        { type: 'video', value: 'forward' },
        { type: 'key', value: { key: 'ArrowRight', code: 'ArrowRight' } }
      ],
      seekBack: [
        { type: 'video', value: 'back' },
        { type: 'key', value: { key: 'ArrowLeft', code: 'ArrowLeft' } }
      ],
      skipIntro: [],
      nextEpisode: [],
      fullscreen: [
        { type: 'key', value: { key: 'f', code: 'KeyF' } }
      ],
      mute: [
        { type: 'video', value: 'mute' },
        { type: 'key', value: { key: 'm', code: 'KeyM' } }
      ]
    }
  };

  // ── Strategy Executor ──

  function execStrategy(strategies) {
    if (!strategies) return false;

    for (var i = 0; i < strategies.length; i++) {
      var s = strategies[i];

      if (s.type === 'selector') {
        var el = document.querySelector(s.value);
        if (el) {
          el.click();
          return true;
        }
      }

      if (s.type === 'aria') {
        var buttons = document.querySelectorAll('button, [role="button"]');
        for (var j = 0; j < buttons.length; j++) {
          var label = buttons[j].getAttribute('aria-label') || '';
          if (label.toLowerCase().indexOf(s.value.toLowerCase()) !== -1) {
            buttons[j].click();
            return true;
          }
        }
      }

      if (s.type === 'key') {
        var target = document.activeElement || document.body;
        var video = document.querySelector('video');
        if (video) target = video;

        var kd = new KeyboardEvent('keydown', {
          key: s.value.key,
          code: s.value.code,
          keyCode: getKeyCode(s.value.key),
          which: getKeyCode(s.value.key),
          bubbles: true,
          cancelable: true
        });
        target.dispatchEvent(kd);

        var ku = new KeyboardEvent('keyup', {
          key: s.value.key,
          code: s.value.code,
          keyCode: getKeyCode(s.value.key),
          which: getKeyCode(s.value.key),
          bubbles: true,
          cancelable: true
        });
        target.dispatchEvent(ku);
        return true;
      }

      if (s.type === 'video') {
        var vid = document.querySelector('video');
        if (!vid) continue;

        if (s.value === 'toggle') {
          if (vid.paused) vid.play(); else vid.pause();
          return true;
        }
        if (s.value === 'forward') {
          vid.currentTime = Math.min(vid.duration, vid.currentTime + 10);
          return true;
        }
        if (s.value === 'back') {
          vid.currentTime = Math.max(0, vid.currentTime - 10);
          return true;
        }
        if (s.value === 'mute') {
          vid.muted = !vid.muted;
          return true;
        }
      }
    }

    return false;
  }

  // Check if a strategy's target exists (without clicking)
  function checkStrategyExists(strategies) {
    if (!strategies) return false;
    for (var i = 0; i < strategies.length; i++) {
      var s = strategies[i];
      if (s.type === 'selector') {
        var el = document.querySelector(s.value);
        if (el && el.offsetParent !== null) return true;
      }
      if (s.type === 'aria') {
        var buttons = document.querySelectorAll('button, [role="button"]');
        for (var j = 0; j < buttons.length; j++) {
          var label = buttons[j].getAttribute('aria-label') || '';
          if (label.toLowerCase().indexOf(s.value.toLowerCase()) !== -1) {
            if (buttons[j].offsetParent !== null) return true;
          }
        }
      }
    }
    return false;
  }

  function getKeyCode(key) {
    var codes = {
      ' ': 32, 'Enter': 13, 'Escape': 27, 'Backspace': 8, 'Tab': 9,
      'ArrowLeft': 37, 'ArrowUp': 38, 'ArrowRight': 39, 'ArrowDown': 40,
      'f': 70, 'F': 70, 'k': 75, 'K': 75, 'j': 74, 'J': 74,
      'l': 76, 'L': 76, 'm': 77, 'M': 77, 'N': 78
    };
    return codes[key] || key.charCodeAt(0);
  }

  function getStrategies() {
    return S[platform] || S.universal;
  }

  // ── Skip Ad Availability Reporting (YouTube only, NOT automated) ──

  var lastSkipAdAvailable = false;

  function checkSkipAdAvailability() {
    if (platform !== 'youtube') return;

    var strats = getStrategies();
    var available = checkStrategyExists(strats.skipAd);

    if (available !== lastSkipAdAvailable) {
      lastSkipAdAvailable = available;
      safeSendMessage({
        type: 'skipAdAvailable',
        available: available
      });
    }
  }

  // Poll every 500ms to detect when skip button appears
  if (platform === 'youtube') {
    safeSetInterval(checkSkipAdAvailability, 500);
  }

  // ── Input Focus Detection ──

  var lastFocusedInput = false;

  document.addEventListener('focusin', function (e) {
    var el = e.target;
    var tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable) {
      lastFocusedInput = true;
      safeSendMessage({
        type: 'inputFocused',
        inputType: el.type || 'text',
        tagName: tag,
        value: el.value || el.textContent || ''
      });
    }
  }, true);

  document.addEventListener('focusout', function (e) {
    var el = e.target;
    var tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable) {
      lastFocusedInput = false;
      safeSendMessage({
        type: 'inputBlurred'
      });
    }
  }, true);

  // ── Media Status Reporting ──

  function reportMediaStatus() {
    var vid = document.querySelector('video');
    if (!vid) return;

    var title = '';
    if (platform === 'netflix') {
      var titleEl = document.querySelector('[data-uia="video-title"]') || document.querySelector('.ellipsize-text');
      if (titleEl) title = titleEl.textContent;
    } else if (platform === 'youtube') {
      var ytTitle = document.querySelector('#movie_player .ytp-title-link') || document.querySelector('h1.ytd-watch-metadata yt-formatted-string');
      if (ytTitle) title = ytTitle.textContent;
    } else {
      var docTitle = document.title;
      if (docTitle) title = docTitle;
    }

    // Also check skip intro availability for platforms that support it
    var strats = getStrategies();
    var skipIntroAvailable = checkStrategyExists(strats.skipIntro);

    safeSendMessage({
      type: 'mediaStatus',
      platform: platform,
      title: title.trim(),
      playing: !vid.paused,
      currentTime: vid.currentTime,
      duration: vid.duration || 0,
      skipIntroAvailable: skipIntroAvailable
    });
  }

  var statusInterval = safeSetInterval(reportMediaStatus, 2000);

  // ── Message Handler ──

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!contextValid) return;
    if (!msg || !msg.action) return;

    if (msg.action === 'cursorMove') {
      moveCursor(msg.x, msg.y);
      return;
    }

    if (msg.action === 'cursorClick') {
      clickFeedback(msg.x, msg.y);
      return;
    }

    if (msg.action === 'cursorSettings') {
      updateCursorSettings(msg);
      return;
    }

    if (msg.action === 'getViewport') {
      safeSendMessage({
        type: 'viewport',
        w: window.innerWidth,
        h: window.innerHeight
      });
      return;
    }

    if (msg.action === 'requestMediaStatus') {
      reportMediaStatus();
      return;
    }

    if (msg.action === 'seek') {
      var vid = document.querySelector('video');
      if (vid && msg.time !== undefined) {
        vid.currentTime = msg.time;
        safeSendMessage({ type: 'cmdResult', command: 'seek', success: true });
      } else {
        safeSendMessage({ type: 'cmdResult', command: 'seek', success: false });
      }
      return;
    }

    if (msg.action === 'swipe') {
      // Fallback for when CDP is not available — simulate arrow key for reels
      var keyName = msg.direction === 'up' ? 'ArrowDown' : 'ArrowUp';
      document.dispatchEvent(new KeyboardEvent('keydown', { key: keyName, code: keyName, bubbles: true }));
      setTimeout(function () {
        document.dispatchEvent(new KeyboardEvent('keyup', { key: keyName, code: keyName, bubbles: true }));
      }, 50);
      return;
    }

    if (msg.action === 'cmd') {
      var strats = getStrategies();
      var command = msg.command;
      var success = false;

      if (strats[command]) {
        success = execStrategy(strats[command]);
      }

      // Special: skipAd uses the skipAd strategy array
      if (command === 'skipAd') {
        success = execStrategy(strats.skipAd);
      }

      if (command === 'volumeUp') {
        var vid = document.querySelector('video');
        if (vid) { vid.volume = Math.min(1, vid.volume + 0.1); success = true; }
      }
      if (command === 'volumeDown') {
        var vid2 = document.querySelector('video');
        if (vid2) { vid2.volume = Math.max(0, vid2.volume - 0.1); success = true; }
      }
      if (command === 'brightness') {
        var level = msg.data && msg.data.level !== undefined ? msg.data.level : 1;
        document.documentElement.style.filter = 'brightness(' + level + ')';
        success = true;
      }

      safeSendMessage({ type: 'cmdResult', command: command, success: success });
      sendResponse({ success: success });
      return true;
    }

    // Mouse events — all input routed through content script
    if (msg.action === 'mouse') {
      var target = document.elementFromPoint(msg.x, msg.y) || document.body;
      var btnCode = msg.button === 'right' ? 2 : 0;
      if (msg.mouseType === 'mousePressed') {
        target.dispatchEvent(new MouseEvent('mousedown', { clientX: msg.x, clientY: msg.y, button: btnCode, bubbles: true, cancelable: true }));
      }
      if (msg.mouseType === 'mouseReleased') {
        target.dispatchEvent(new MouseEvent('mouseup', { clientX: msg.x, clientY: msg.y, button: btnCode, bubbles: true, cancelable: true }));
        // Use element.click() for trusted click — works on buttons, links, Next Episode, etc.
        // Fall back to dispatchEvent for right-clicks (context menu)
        if (btnCode === 0) {
          target.click();
        } else {
          target.dispatchEvent(new MouseEvent('contextmenu', { clientX: msg.x, clientY: msg.y, button: 2, bubbles: true, cancelable: true }));
        }
      }
      if (msg.mouseType === 'mouseMoved') {
        target.dispatchEvent(new MouseEvent('mousemove', { clientX: msg.x, clientY: msg.y, bubbles: true }));
      }
    }

    if (msg.action === 'scroll') {
      window.scrollBy(msg.deltaX || 0, msg.deltaY || 0);
    }

    if (msg.action === 'key') {
      var kTarget = document.activeElement || document.body;
      var kEvt = new KeyboardEvent(msg.keyType === 'keyDown' ? 'keydown' : 'keyup', {
        key: msg.key,
        code: msg.code,
        bubbles: true,
        cancelable: true
      });
      kTarget.dispatchEvent(kEvt);
    }
  });

  // ── Cleanup ──

  window.addEventListener('beforeunload', function () {
    clearAllIntervals();
  });

})();
