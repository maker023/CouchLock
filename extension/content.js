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
 *   - Up-next and "still watching?" detection (drives phone notifications)
 *   - Player fullscreen (lifted into the top layer above the page)
 */
(function () {
  'use strict';

  // ── Re-injection Guard ──
  // The background injects this script into tabs that were open before the
  // extension was installed or reloaded. Retire any earlier copy first so two
  // instances never drive the same page.
  if (typeof window.__couchlockTeardown === 'function') window.__couchlockTeardown();

  var teardownTasks = [];

  function listen(target, type, fn, capture) {
    target.addEventListener(type, fn, capture);
    teardownTasks.push(function () { target.removeEventListener(type, fn, capture); });
  }

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
  // The cursor lives in the browser's top layer (a manual popover) so it stays
  // visible above fullscreen and lifted players, which no z-index can beat.

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

  // Undo the UA popover styles (centred, bordered, opaque box).
  var POPOVER_RESET = ['inset:auto', 'margin:0', 'padding:0', 'overflow:visible'];

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
    ].concat(POPOVER_RESET, ['background:transparent']).join(';');
    document.documentElement.appendChild(cursorRipple);
    promoteCursor();
  }

  function supportsTopLayer() {
    return typeof HTMLElement.prototype.showPopover === 'function';
  }

  // Re-open the cursor popovers so they sit above anything added to the top
  // layer after them (a lifted player, a native fullscreen element).
  function promoteCursor() {
    if (!supportsTopLayer()) return;
    [cursorEl, cursorRipple].forEach(function (el) {
      if (!el || !el.isConnected) return;
      try {
        if (!el.hasAttribute('popover')) el.setAttribute('popover', 'manual');
        if (el.matches(':popover-open')) el.hidePopover();
        el.showPopover();
      } catch (e) { /* Popover refused (e.g. element detached mid-call) — z-index still applies. */ }
    });
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
      'display:none'
    ].concat(POPOVER_RESET, ['border:0', 'left:0px', 'top:0px']).join(';');
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
  else if (host === 'star.gr' || host.endsWith('.star.gr')) platform = 'star';

  // Players are often mounted after document_idle. Pick the playing, visible
  // media element each time instead of locking onto the first video in the DOM.
  function activeVideo() {
    var videos = document.querySelectorAll('video');
    var best = null;
    var bestScore = 0;
    for (var i = 0; i < videos.length; i++) {
      var video = videos[i];
      var rect = video.getBoundingClientRect();
      var visible = rect.width > 0 && rect.height > 0 && getComputedStyle(video).visibility !== 'hidden';
      // A hidden preview must not outrank the full-size player when it pauses.
      var score = (visible ? 100 : 0) + (!video.paused && !video.ended ? 10 : 0) +
        (video.readyState > 0 ? 1 : 0) + (visible ? Math.min(50, Math.sqrt(rect.width * rect.height) / 20) : 0);
      if (score > bestScore) { best = video; bestScore = score; }
    }
    return best;
  }

  function currentPlatform() {
    return platform === 'unknown' && activeVideo() ? 'universal' : platform;
  }

  // ── Player Fullscreen ──
  // The background puts the browser window into fullscreen; here the player is
  // lifted into the top layer (a manual popover). Top-layer elements are laid
  // out against the viewport and painted above everything, so ancestors with
  // transforms, overflow clipping or their own stacking contexts can't trap or
  // cover the player — which is what left the old position:fixed version stuck
  // behind the page. A player inside an iframe fills its frame, then each parent
  // frame lifts the <iframe> holding it.

  var KNOWN_PLAYERS = '.video_container, .live__playerContainer, #movie_player, .watch-video, [data-testid="player"]';
  var LIFT_STYLES = [
    ['position', 'fixed'], ['inset', '0'], ['width', '100vw'], ['height', '100vh'],
    ['max-width', 'none'], ['max-height', 'none'], ['margin', '0'], ['padding', '0'],
    ['min-width', '0'], ['min-height', '0'], ['box-sizing', 'border-box'], ['overflow', 'hidden'],
    ['border', '0'], ['transform', 'none'], ['z-index', '2147483645'], ['background', 'black']
  ];
  var FILL_STYLES = [
    ['width', '100%'], ['height', '100%'], ['max-width', 'none'], ['max-height', 'none'],
    ['min-width', '0'], ['min-height', '0'], ['padding', '0'], ['margin', '0'], ['box-sizing', 'border-box'],
    ['left', '0'], ['top', '0'], ['object-fit', 'contain']
  ];
  var CONTAINER_GROWTH = 1.25; // an ancestor this much larger than the video is page layout, not player

  var lifted = []; // [{ el, style, popover, open }] in lift order
  var expansionToken = null;

  function applyStyles(el, styles) {
    var saved = { el: el, style: el.getAttribute('style') };
    styles.forEach(function (p) { el.style.setProperty(p[0], p[1], 'important'); });
    return saved;
  }

  function restoreStyles(saved) {
    if (saved.style === null) saved.el.removeAttribute('style');
    else saved.el.setAttribute('style', saved.style);
  }

  function lift(el, styles, toTopLayer) {
    if (lifted.some(function (state) { return state.el === el; })) return;
    var state = applyStyles(el, styles);
    state.popover = el.getAttribute('popover');
    state.wasOpen = supportsTopLayer() && state.popover !== null && el.matches(':popover-open');
    if (toTopLayer && supportsTopLayer()) {
      try {
        if (state.popover === null) el.setAttribute('popover', 'manual');
        el.showPopover();
        state.open = true;
      } catch (e) { /* Already open or refused — the fixed styles still cover most pages. */ }
    }
    lifted.push(state);
  }

  // Walk up from the video while the ancestor is about the video's size: that
  // wrapper holds the site's own controls and overlays.
  function playerContainer(video) {
    var known = video.closest(KNOWN_PLAYERS);
    if (known) return known;
    var rect = video.getBoundingClientRect();
    var area = Math.max(1, rect.width * rect.height);
    var best = video;
    var el = video.parentElement;
    while (el && el !== document.body && el !== document.documentElement) {
      var r = el.getBoundingClientRect();
      if (r.width * r.height > area * CONTAINER_GROWTH) break;
      best = el;
      el = el.parentElement;
    }
    return best;
  }

  function isLifted() {
    return lifted.length > 0;
  }

  function restorePlayer() {
    while (lifted.length) {
      var state = lifted.pop();
      if (state.open && !state.wasOpen) {
        try { state.el.hidePopover(); } catch (e) { /* already closed */ }
      }
      if (state.popover === null) state.el.removeAttribute('popover');
      restoreStyles(state);
    }
  }

  function notifyPlayerExpanded() {
    if (window !== window.top) {
      window.parent.postMessage({ type: 'couchlock-expand-frame', token: expansionToken }, '*');
    } else {
      safeSendMessage({ type: 'playerExpanded', token: expansionToken });
    }
  }

  function expandPlayer(token) {
    if (!token || token !== expansionToken) return;
    // The user went native fullscreen on the laptop: the remote's press means "exit".
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(function () {});
      safeSendMessage({ type: 'playerRestored' });
      return;
    }
    if (isLifted()) { notifyPlayerExpanded(); return; }
    var video = activeVideo();
    if (!video) {
      safeSendMessage({ type: 'playerExpandFailed', token: token, reason: 'no_media' });
      return;
    }
    var player = playerContainer(video);
    lift(player, LIFT_STYLES, true);
    // Fixed-size wrappers between a known player and its video otherwise keep
    // the picture small even though the outer player covers the viewport.
    var inner = video;
    while (inner && inner !== player) {
      lift(inner, FILL_STYLES, false);
      inner = inner.parentElement;
    }
    promoteCursor();
    notifyPlayerExpanded();
  }

  // Match the actual sending window, including cross-origin nested players.
  // Only a background-authorized fullscreen operation arms this listener.
  function expandChildFrame(event) {
    if (!expansionToken || !event.data || event.data.type !== 'couchlock-expand-frame' ||
        event.data.token !== expansionToken) return;
    var frames = document.querySelectorAll('iframe, frame');
    for (var i = 0; i < frames.length; i++) {
      if (frames[i].contentWindow !== event.source) continue;
      lift(frames[i], LIFT_STYLES, true);
      promoteCursor();
      notifyPlayerExpanded();
      return;
    }
  }

  listen(window, 'message', expandChildFrame);

  // Parent frames can receive the preparation broadcast after their child has
  // already posted its expansion request. Retry the idempotent frame lift for
  // a short, bounded window so process scheduling cannot lose the handoff.
  function retryFrameExpansion(token, attempts) {
    if (!contextValid || window === window.top || expansionToken !== token || !isLifted() || !attempts) return;
    notifyPlayerExpanded();
    setTimeout(function () { retryFrameExpansion(token, attempts - 1); }, 100);
  }

  listen(document, 'keydown', function (event) {
    if (event.key === 'Escape' && isLifted()) {
      restorePlayer();
      safeSendMessage({ type: 'playerRestored' });
    }
  });

  listen(document, 'fullscreenchange', promoteCursor);

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
        { type: 'selector', value: '[data-uia="next-episode-seamless-button-draining"]' },
        { type: 'selector', value: '[data-uia="control-next"]' }
      ],
      // Only shown over the credits, unlike the control-bar next button.
      upNext: [
        { type: 'selector', value: '[data-uia="next-episode-seamless-button"]' },
        { type: 'selector', value: '[data-uia="next-episode-seamless-button-draining"]' }
      ],
      stillWatching: [
        { type: 'selector', value: '[data-uia="interrupt-autoplay-continue"]' }
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
      // The autoplay countdown's "play now" button is only laid out while it counts down.
      upNext: [
        { type: 'selector', value: '.ytp-autonav-endscreen-upnext-play-button' }
      ],
      stillWatching: [
        { type: 'selector', value: 'ytd-popup-container yt-confirm-dialog-renderer #confirm-button button' },
        { type: 'selector', value: 'ytd-popup-container yt-confirm-dialog-renderer #confirm-button' }
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
      mute: [
        { type: 'key', value: { key: 'm', code: 'KeyM' } }
      ]
    },

    star: {
      playPause: [{ type: 'video', value: 'toggle' }, { type: 'key', value: { key: ' ', code: 'Space' } }],
      seekForward: [{ type: 'video', value: 'forward' }, { type: 'key', value: { key: 'ArrowRight', code: 'ArrowRight' } }],
      seekBack: [{ type: 'video', value: 'back' }, { type: 'key', value: { key: 'ArrowLeft', code: 'ArrowLeft' } }],
      skipIntro: [],
      nextEpisode: [{ type: 'starNext' }],
      mute: [{ type: 'video', value: 'mute' }, { type: 'key', value: { key: 'm', code: 'KeyM' } }]
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
      mute: [
        { type: 'video', value: 'mute' },
        { type: 'key', value: { key: 'm', code: 'KeyM' } }
      ]
    }
  };

  // ── Strategy Executor ──

  function usableControl(el) {
    if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true' ||
        el.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    var rect = el.getBoundingClientRect();
    var style = getComputedStyle(el);
    // offsetParent is null for fixed-position and top-layer controls too.
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }

  function strategyControl(strategy) {
    var elements = document.querySelectorAll(strategy.type === 'selector' ? strategy.value : 'button, [role="button"]');
    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      if (strategy.type === 'aria' && (el.getAttribute('aria-label') || '').toLowerCase().indexOf(strategy.value.toLowerCase()) === -1) continue;
      if (usableControl(el)) return el;
    }
    return null;
  }

  function starNextURL() {
    var container = document.querySelector('[data-plugin-kwik]');
    if (!container) return '';
    try {
      var next = JSON.parse(container.getAttribute('data-plugin-kwik')).Kwik.NextVideo;
      if (!next) return '';
      var url = new URL(next, window.location.href);
      return url.origin === window.location.origin && url.pathname.indexOf('/tv/') === 0 ? url.href : '';
    } catch (e) { return ''; }
  }

  function execStrategy(strategies, command) {
    if (!strategies) return false;

    for (var i = 0; i < strategies.length; i++) {
      var s = strategies[i];

      if (s.type === 'selector' || s.type === 'aria') {
        var el = strategyControl(s);
        if (el) {
          el.click();
          return true;
        }
      }

      if (s.type === 'key') {
        // A site's own controls may change. Use its active HTML video before
        // falling back to synthetic keys, which many players ignore. Netflix's
        // player errors out when its video is seeked directly, so it keeps keys.
        var fallbackVideo = activeVideo();
        var fallbackAction = {
          playPause: 'toggle', seekForward: 'forward', seekBack: 'back', mute: 'mute'
        }[command];
        if (platform === 'netflix' && (command === 'seekForward' || command === 'seekBack')) fallbackAction = null;
        if (fallbackVideo && fallbackAction) {
          return execStrategy([{ type: 'video', value: fallbackAction }], command);
        }
        var target = document.activeElement || document.body;
        var video = activeVideo();
        if (video) target = video;

        var kd = new KeyboardEvent('keydown', {
          key: s.value.key,
          code: s.value.code,
          keyCode: getKeyCode(s.value.key),
          which: getKeyCode(s.value.key),
          shiftKey: !!(s.value.modifiers & 1),
          bubbles: true,
          cancelable: true
        });
        target.dispatchEvent(kd);

        var ku = new KeyboardEvent('keyup', {
          key: s.value.key,
          code: s.value.code,
          keyCode: getKeyCode(s.value.key),
          which: getKeyCode(s.value.key),
          shiftKey: !!(s.value.modifiers & 1),
          bubbles: true,
          cancelable: true
        });
        target.dispatchEvent(ku);
        return true;
      }

      if (s.type === 'video') {
        var vid = activeVideo();
        if (!vid) continue;

        if (s.value === 'toggle') {
          if (vid.paused) playVideo(vid, command);
          else vid.pause();
          return true;
        }
        if (s.value === 'forward') {
          vid.currentTime = Math.min(Number.isFinite(vid.duration) ? vid.duration : vid.currentTime + 10, vid.currentTime + 10);
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

      if (s.type === 'starNext') {
        var nextURL = starNextURL();
        if (nextURL) { window.location.assign(nextURL); return true; }
      }
    }

    return false;
  }

  // Browsers refuse unmuted play() until the page has had a real click or key
  // press, and the remote's synthetic events don't count. Tell the phone so
  // the user knows what to do instead of the button silently doing nothing.
  function playVideo(vid, command) {
    vid.play().catch(function (err) {
      var blocked = err && err.name === 'NotAllowedError';
      safeSendMessage({ type: 'cmdResult', command: command, success: false, reason: blocked ? 'blocked' : 'no_control' });
    });
  }

  // Check if a strategy's target exists (without clicking)
  function checkStrategyExists(strategies) {
    if (!strategies) return false;
    for (var i = 0; i < strategies.length; i++) {
      var s = strategies[i];
      if ((s.type === 'selector' || s.type === 'aria') && strategyControl(s)) return true;
      if (s.type === 'starNext' && starNextURL()) return true;
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
    return S[currentPlatform()] || S.universal;
  }

  // ── Input Focus Detection ──

  var lastFocusedInput = false;

  listen(document, 'focusin', function (e) {
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

  listen(document, 'focusout', function (e) {
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

  var titleKey = '';
  var cachedTitle = '';
  var pageSessionTitle = '';
  var titleRequestedAt = 0;
  var titleRequestPending = false;
  var lastStatusJSON = '';
  var lastStatusAt = 0;
  var statusTimer = null;

  function descriptiveTitle(title) {
    title = (typeof title === 'string' ? title : '').replace(/\s+/g, ' ').trim();
    return /^(netflix|youtube|disney\+?|hbo( max)?|max|hulu|star( tv)?|video player)$/i.test(title) ? '' : title;
  }

  function mediaTitle(vid) {
    var key = window.location.href + '|' + (vid ? vid.currentSrc || vid.src || '' : '');
    if (key !== titleKey || !vid) {
      titleKey = key;
      cachedTitle = '';
      pageSessionTitle = '';
      titleRequestedAt = 0;
    }
    var title = '';
    if (platform === 'netflix') {
      var titleEl = document.querySelector('[data-uia="video-title"]') || document.querySelector('.ellipsize-text');
      if (titleEl) title = titleEl.textContent;
    } else if (platform === 'youtube') {
      var ytTitle = document.querySelector('#movie_player .ytp-title-link') || document.querySelector('h1.ytd-watch-metadata yt-formatted-string');
      if (ytTitle) title = ytTitle.textContent;
    }
    title = descriptiveTitle(title);

    // Player overlays can be absent while playing. Media Session metadata and
    // page metadata remain available without pausing to reveal the controls.
    var metadata = navigator.mediaSession && navigator.mediaSession.metadata;
    var pageTitle = document.querySelector('meta[property="og:title"]') || document.querySelector('meta[name="twitter:title"]');
    title = title || descriptiveTitle(metadata && metadata.title) || pageSessionTitle ||
      descriptiveTitle(pageTitle && pageTitle.content) || descriptiveTitle(document.title);
    if (title) cachedTitle = title;

    // Page-owned Media Session metadata can be absent in the isolated world.
    // Ask only while needed, and never let an old episode's reply rename a new one.
    if (vid && !title && !titleRequestPending && Date.now() - titleRequestedAt > 5000) {
      titleRequestedAt = Date.now();
      titleRequestPending = true;
      safeSendMessage({ type: 'requestMediaTitle' }, function (response) {
        titleRequestPending = false;
        if (key !== titleKey || !response || response.url !== window.location.href) return;
        pageSessionTitle = descriptiveTitle(response.title);
        if (pageSessionTitle) scheduleMediaStatus();
      });
    }
    return cachedTitle || (document.title || '').trim();
  }

  function reportMediaStatus(force) {
    var vid = activeVideo();
    var detectedPlatform = platform === 'unknown' && vid ? 'universal' : platform;

    // Also check skip intro availability for platforms that support it
    var strats = S[detectedPlatform] || S.universal;
    var skipIntroAvailable = checkStrategyExists(strats.skipIntro);

    var rect = vid ? vid.getBoundingClientRect() : null;
    var status = {
      type: 'mediaStatus',
      platform: vid ? detectedPlatform : 'unknown',
      title: mediaTitle(vid),
      mediaKey: titleKey,
      playing: vid ? !vid.paused && !vid.ended : false,
      ended: vid ? vid.ended : false,
      mediaArea: rect ? Math.round(rect.width * rect.height) : 0,
      currentTime: vid ? vid.currentTime : 0,
      duration: vid && Number.isFinite(vid.duration) ? vid.duration : 0,
      skipIntroAvailable: skipIntroAvailable,
      skipAdAvailable: checkStrategyExists(strats.skipAd),
      nextEpisodeAvailable: checkStrategyExists(strats.nextEpisode) || (detectedPlatform === 'youtube' && !!vid),
      upNext: checkStrategyExists(strats.upNext),
      stillWatching: checkStrategyExists(strats.stillWatching)
    };
    var json = JSON.stringify(status);
    if (force !== true && json === lastStatusJSON && Date.now() - lastStatusAt < 10000) return;
    lastStatusJSON = json;
    lastStatusAt = Date.now();
    safeSendMessage(status);
  }

  function scheduleMediaStatus() {
    if (statusTimer !== null) return;
    statusTimer = setTimeout(function () {
      statusTimer = null;
      if (contextValid) reportMediaStatus();
    }, 40);
  }

  var statusInterval = safeSetInterval(reportMediaStatus, 1000);
  ['play', 'pause', 'ended', 'loadedmetadata', 'emptied', 'seeked', 'durationchange'].forEach(function (type) {
    listen(document, type, function (event) {
      if (event.target && event.target.tagName === 'VIDEO') scheduleMediaStatus();
    }, true);
  });
  teardownTasks.push(function () { clearTimeout(statusTimer); });

  // ── Message Handler ──

  var MEDIA_COMMANDS = ['playPause', 'seekForward', 'seekBack', 'mute', 'volumeUp', 'volumeDown'];

  function onMessage(msg, sender, sendResponse) {
    if (!contextValid) return;
    if (!msg || !msg.action) return;

    if (msg.action === 'preparePlayerExpand') {
      expansionToken = msg.token;
      sendResponse({ ready: true });
      return;
    }

    if (msg.action === 'playerExpand') {
      expandPlayer(msg.token);
      if (window !== window.top) retryFrameExpansion(msg.token, 10);
      return;
    }

    if (msg.action === 'playerRestore') {
      expansionToken = null;
      restorePlayer();
      return;
    }

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
      reportMediaStatus(true);
      return;
    }

    if (msg.action === 'seek') {
      var vid = activeVideo();
      if (platform === 'netflix') {
        safeSendMessage({ type: 'cmdResult', command: 'seek', success: false, reason: 'unsupported' });
      } else if (vid && msg.time !== undefined) {
        if (!Number.isFinite(msg.time)) return;
        vid.currentTime = Math.max(0, Number.isFinite(vid.duration) ? Math.min(vid.duration, msg.time) : msg.time);
        scheduleMediaStatus();
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
      var reason;

      if (strats[command]) {
        success = execStrategy(strats[command], command);
      }

      if (command === 'volumeUp') {
        var vid = activeVideo();
        if (vid) { vid.volume = Math.min(1, vid.volume + 0.1); success = true; }
      }
      if (command === 'volumeDown') {
        var vid2 = activeVideo();
        if (vid2) { vid2.volume = Math.max(0, vid2.volume - 0.1); success = true; }
      }
      if (command === 'brightness') {
        var level = msg.data && msg.data.level !== undefined ? msg.data.level : 1;
        document.documentElement.style.filter = 'brightness(' + level + ')';
        success = true;
      }

      if (!success) {
        reason = MEDIA_COMMANDS.indexOf(command) !== -1 && !activeVideo() ? 'no_media' : 'no_control';
      }
      safeSendMessage({ type: 'cmdResult', command: command, success: success, reason: reason });
      scheduleMediaStatus();
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
        // element.click() runs the target's click handlers — works on buttons, links, Next Episode, etc.
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
  }

  chrome.runtime.onMessage.addListener(onMessage);
  reportMediaStatus();

  // ── Cleanup ──

  listen(window, 'beforeunload', function () {
    restorePlayer();
    clearAllIntervals();
  });

  window.__couchlockTeardown = function () {
    restorePlayer();
    clearAllIntervals();
    teardownTasks.forEach(function (task) { task(); });
    teardownTasks = [];
    [cursorEl, cursorRipple].forEach(function (el) {
      if (el && el.parentNode) el.parentNode.removeChild(el);
    });
    try { chrome.runtime.onMessage.removeListener(onMessage); } catch (e) { /* context already gone */ }
    contextValid = false;
  };

})();
