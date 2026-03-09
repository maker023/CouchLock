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
 */
(function () {
  'use strict';

  // ── Platform Detection ──

  var host = window.location.hostname;
  var platform = 'unknown';

  if (host.indexOf('netflix.com') !== -1) platform = 'netflix';
  else if (host.indexOf('max.com') !== -1 || host.indexOf('hbomax.com') !== -1) platform = 'hbo';
  else if (host.indexOf('youtube.com') !== -1) platform = 'youtube';
  else if (host.indexOf('disneyplus.com') !== -1) platform = 'disney';
  else if (host.indexOf('hulu.com') !== -1) platform = 'hulu';

  // ── Selector Strategies ──
  // Each action has an ordered array of strategies.
  // Each strategy: { type: 'selector'|'aria'|'key', value: ... }
  // First match wins.

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
        { type: 'selector', value: '[data-testid="player- advancement-play-pause"]' },
        { type: 'selector', value: 'button[aria-label="Play"], button[aria-label="Pause"]' },
        { type: 'key', value: { key: ' ', code: 'Space' } }
      ],
      seekForward: [
        { type: 'selector', value: '[data-testid="player- advancement-forward"]' },
        { type: 'key', value: { key: 'ArrowRight', code: 'ArrowRight' } }
      ],
      seekBack: [
        { type: 'selector', value: '[data-testid="player- advancement-back"]' },
        { type: 'key', value: { key: 'ArrowLeft', code: 'ArrowLeft' } }
      ],
      skipIntro: [
        { type: 'aria', value: 'Skip Intro' },
        { type: 'selector', value: 'button[class*="skip"]' }
      ],
      nextEpisode: [
        { type: 'aria', value: 'Next Episode' },
        { type: 'selector', value: '[data-testid="player-next-up"]' }
      ],
      fullscreen: [
        { type: 'aria', value: 'Full Screen' },
        { type: 'key', value: { key: 'f', code: 'KeyF' } }
      ],
      mute: [
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

  function getKeyCode(key) {
    var codes = {
      ' ': 32, 'Enter': 13, 'Escape': 27, 'Backspace': 8, 'Tab': 9,
      'ArrowLeft': 37, 'ArrowUp': 38, 'ArrowRight': 39, 'ArrowDown': 40,
      'f': 70, 'F': 70, 'k': 75, 'K': 75, 'j': 74, 'J': 74,
      'l': 76, 'L': 76, 'm': 77, 'M': 77, 'N': 78
    };
    return codes[key] || key.charCodeAt(0);
  }

  // ── Get Current Platform Strategies ──

  function getStrategies() {
    return S[platform] || S.universal;
  }

  // ── Media Status Reporting ──

  function reportMediaStatus() {
    var vid = document.querySelector('video');
    if (!vid) return;

    var title = '';
    // Platform-specific title extraction
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

    chrome.runtime.sendMessage({
      type: 'mediaStatus',
      platform: platform,
      title: title.trim(),
      playing: !vid.paused,
      currentTime: vid.currentTime,
      duration: vid.duration || 0
    });
  }

  // Poll media status every 2 seconds
  var statusInterval = setInterval(reportMediaStatus, 2000);

  // ── Message Handler ──

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.action) return;

    if (msg.action === 'cmd') {
      var strats = getStrategies();
      var command = msg.command;
      var success = false;

      if (strats[command]) {
        success = execStrategy(strats[command]);
      }

      // Special commands not in strategy table
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

      chrome.runtime.sendMessage({ type: 'cmdResult', command: command, success: success });
      sendResponse({ success: success });
      return true;
    }

    // Fallback mouse events (when debugger not available)
    if (msg.action === 'mouse') {
      var target = document.elementFromPoint(msg.x, msg.y) || document.body;
      if (msg.mouseType === 'mousePressed') {
        target.dispatchEvent(new MouseEvent('mousedown', { clientX: msg.x, clientY: msg.y, button: msg.button === 'right' ? 2 : 0, bubbles: true }));
      }
      if (msg.mouseType === 'mouseReleased') {
        target.dispatchEvent(new MouseEvent('mouseup', { clientX: msg.x, clientY: msg.y, button: msg.button === 'right' ? 2 : 0, bubbles: true }));
        target.dispatchEvent(new MouseEvent('click', { clientX: msg.x, clientY: msg.y, button: msg.button === 'right' ? 2 : 0, bubbles: true }));
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
    clearInterval(statusInterval);
  });

})();
