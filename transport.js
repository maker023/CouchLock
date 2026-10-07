/**
 * CouchLock Transport Layer
 * Minimal MQTT 3.1.1 client over WebSocket + AES-GCM encryption.
 * Used by both extension (background.js, popup.js) and PWA (index.html).
 *
 * Public API (default client):
 *   CouchTransport.connect(config)       → Promise
 *   CouchTransport.send(data)            → Promise<boolean>
 *   CouchTransport.onMessage(fn)         → void
 *   CouchTransport.onStatus(fn)          → void  (status callback)
 *   CouchTransport.onPresence(fn)        → void  ('1' online, '0' offline, 'x' revoked)
 *   CouchTransport.disconnect(presence)  → void  (announcers publish presence first, default '0')
 *   CouchTransport.reconnectNow()        → void
 *   CouchTransport.checkAlive()          → void  (ping now; a silent socket is replaced)
 *   CouchTransport.isConnected()         → boolean
 *   CouchTransport.createClient()        → independent client with the same API
 *
 * Config: { broker, token, sessionId, presence } or { broker, topic, plain: true }
 *   broker    — WSS URL (default: wss://broker.hivemq.com:8884/mqtt)
 *   token     — 32-byte hex session token (used as encryption key + topic hash)
 *   sessionId — unique session identifier
 *   presence  — 'announce' (extension: retained online flag + last-will offline flag)
 *               or 'watch' (phone: subscribe to the laptop's presence flag)
 *   topic     — plain mode only: topic to subscribe and publish on
 *   plain     — messages are unencrypted JSON (pairing discovery handles its own crypto)
 */
var CouchTransport = (function () {
  'use strict';

  var BROKER_URL = 'wss://broker.hivemq.com:8884/mqtt';
  var KEEPALIVE = 30; // seconds
  var PING_TIMEOUT = 10000;   // a socket that doesn't answer a ping within this is dead (ms)
  var RECONNECT_BASE = 250;   // first retry fires fast (ms)
  var RECONNECT_MAX = 30000;  // keep retrying after longer outages

  // ── Helpers ──

  function u8(arr) { return new Uint8Array(arr); }

  function str2bytes(s) {
    var b = [];
    for (var i = 0; i < s.length; i++) b.push(s.charCodeAt(i));
    return b;
  }

  function bytes2str(arr) {
    var s = '';
    for (var i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
    return s;
  }

  function encodeUTF8(s) {
    var encoder = new TextEncoder();
    return encoder.encode(s);
  }

  function decodeUTF8(buf) {
    var decoder = new TextDecoder();
    return decoder.decode(buf);
  }

  function encodeLength(len) {
    var bytes = [];
    do {
      var b = len % 128;
      len = Math.floor(len / 128);
      if (len > 0) b = b | 0x80;
      bytes.push(b);
    } while (len > 0);
    return bytes;
  }

  function lengthPrefixed(bytes) {
    return [bytes.length >> 8, bytes.length & 0xFF].concat(Array.from(bytes));
  }

  function hex2bytes(hex) {
    var bytes = new Uint8Array(hex.length / 2);
    for (var i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
    }
    return bytes;
  }

  function bytes2hex(bytes) {
    var hex = '';
    for (var i = 0; i < bytes.length; i++) {
      hex += ('0' + bytes[i].toString(16)).slice(-2);
    }
    return hex;
  }

  // ── Crypto (AES-GCM via WebCrypto) ──

  function deriveKey(token) {
    var raw = hex2bytes(token);
    return crypto.subtle.importKey('raw', raw.slice(0, 32), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  function encrypt(key, plaintext) {
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var data = encodeUTF8(plaintext);
    return crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, data).then(function (cipher) {
      var cipherBytes = new Uint8Array(cipher);
      var out = new Uint8Array(iv.length + cipherBytes.length);
      out.set(iv);
      out.set(cipherBytes, iv.length);
      return out;
    });
  }

  function decrypt(key, data) {
    var iv = data.slice(0, 12);
    var cipher = data.slice(12);
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, cipher).then(function (plain) {
      return decodeUTF8(new Uint8Array(plain));
    });
  }

  function hashTopic(token) {
    return crypto.subtle.digest('SHA-256', hex2bytes(token)).then(function (hash) {
      return 'cl/' + bytes2hex(new Uint8Array(hash)).slice(0, 16);
    });
  }

  // ── MQTT 3.1.1 Packet Builders ──

  // will: { topic, payload } — published (retained) by the broker if we vanish without DISCONNECT.
  function buildConnect(clientId, will) {
    var proto = [0x00, 0x04].concat(str2bytes('MQTT')); // protocol name
    var level = [0x04]; // protocol level 3.1.1
    var flags = [will ? 0x26 : 0x02]; // clean session (+ will flag, will retain)
    var keepalive = [KEEPALIVE >> 8, KEEPALIVE & 0xFF];

    var varHeader = proto.concat(level, flags, keepalive);
    var payload = lengthPrefixed(str2bytes(clientId));
    if (will) payload = payload.concat(lengthPrefixed(str2bytes(will.topic)), lengthPrefixed(will.payload));
    var remaining = varHeader.concat(payload);

    return u8([0x10].concat(encodeLength(remaining.length), remaining));
  }

  function buildSubscribe(id, topics) {
    var remaining = [(id >> 8) & 0xFF, id & 0xFF];
    for (var i = 0; i < topics.length; i++) {
      remaining = remaining.concat(lengthPrefixed(str2bytes(topics[i])), [0x00]); // QoS 0
    }
    return u8([0x82].concat(encodeLength(remaining.length), remaining));
  }

  function buildPublish(topicStr, payload, retain) {
    var remaining = lengthPrefixed(str2bytes(topicStr)).concat(Array.from(payload));
    return u8([retain ? 0x31 : 0x30].concat(encodeLength(remaining.length), remaining));
  }

  function buildPingreq() {
    return u8([0xC0, 0x00]);
  }

  function buildDisconnect() {
    return u8([0xE0, 0x00]);
  }

  // ── MQTT Packet Parser ──

  function parsePacket(buf) {
    var bytes = new Uint8Array(buf);
    if (bytes.length < 2) return null;

    var type = bytes[0] >> 4;
    var offset = 1;
    var multiplier = 1;
    var len = 0;
    var b;

    do {
      if (offset >= bytes.length) return null;
      b = bytes[offset++];
      len += (b & 0x7F) * multiplier;
      multiplier *= 128;
    } while ((b & 0x80) !== 0);

    if (bytes.length < offset + len) return null;

    return {
      type: type,
      data: bytes.slice(offset, offset + len),
      totalLength: offset + len
    };
  }

  // ── Client ──

  function createClient() {
    var ws = null;
    var connected = false;
    var topic = '';
    var presenceTopic = '';
    var cryptoKey = null;
    var messageCallback = null;
    var statusCallback = null;
    var presenceCallback = null;
    var pingTimer = null;
    var pongTimer = null;
    var reconnectTimer = null;
    var reconnectCount = 0;
    var config = null;
    var packetId = 1;
    var destroyed = true;

    function setStatus(s) {
      if (statusCallback) statusCallback(s);
    }

    function announces() {
      return !!(config && config.presence === 'announce');
    }

    function sendPing() {
      if (!ws || ws.readyState !== 1) return;
      ws.send(buildPingreq());
      if (!pongTimer) pongTimer = setTimeout(dropSocket, PING_TIMEOUT);
    }

    function startPing() {
      stopPing();
      pingTimer = setInterval(sendPing, KEEPALIVE * 1000 * 0.8);
    }

    function stopPing() {
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
      if (pongTimer) {
        clearTimeout(pongTimer);
        pongTimer = null;
      }
    }

    function stopReconnect() {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    }

    function reconnectDelay() {
      // Capped exponential backoff with jitter. reconnectCount 0 → ~250ms,
      // then doubles up to 30 seconds. Jitter avoids a thundering herd.
      var exp = Math.min(reconnectCount, 7);
      var delay = Math.min(RECONNECT_BASE * Math.pow(2, exp), RECONNECT_MAX);
      return delay + Math.floor(Math.random() * 250);
    }

    function scheduleReconnect() {
      if (destroyed) return;
      stopReconnect();
      setStatus('reconnecting');
      reconnectTimer = setTimeout(doConnect, reconnectDelay());
      reconnectCount++;
    }

    // Detach and close the current socket without letting its onclose run.
    function releaseSocket() {
      stopPing();
      if (ws) {
        ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
        try { ws.close(); } catch (e) { /* already closed */ }
        ws = null;
      }
      connected = false;
    }

    // A socket that stops answering pings is dead even if it still reports open
    // (laptop sleep, WiFi change). Replace it instead of waiting for TCP to notice.
    function dropSocket() {
      pongTimer = null;
      releaseSocket();
      setStatus('disconnected');
      scheduleReconnect();
    }

    function doConnect() {
      if (destroyed) return;
      reconnectTimer = null;
      setStatus('connecting');

      var broker = (config && config.broker) || BROKER_URL;
      var clientId = 'cl_' + Math.random().toString(36).slice(2, 10);
      var will = announces() ? { topic: presenceTopic, payload: encodeUTF8('0') } : null;

      try {
        ws = new WebSocket(broker, ['mqtt']);
      } catch (e) {
        scheduleReconnect();
        return;
      }
      ws.binaryType = 'arraybuffer';

      var socket = ws;
      var buf = new ArrayBuffer(0);

      ws.onopen = function () {
        socket.send(buildConnect(clientId, will));
      };

      ws.onmessage = function (evt) {
        // Accumulate buffer
        var incoming = new Uint8Array(evt.data);
        var prev = new Uint8Array(buf);
        var combined = new Uint8Array(prev.length + incoming.length);
        combined.set(prev);
        combined.set(incoming, prev.length);
        buf = combined.buffer;

        // Parse all complete packets
        while (buf.byteLength > 0 && socket === ws) {
          var pkt = parsePacket(buf);
          if (!pkt) break;

          handlePacket(pkt);
          buf = buf.slice(pkt.totalLength);
        }
      };

      ws.onclose = function () {
        connected = false;
        stopPing();
        setStatus('disconnected');
        scheduleReconnect();
      };

      ws.onerror = function () {
        // onclose will fire after this
      };
    }

    function handlePublish(pkt) {
      var topicLen = (pkt.data[0] << 8) | pkt.data[1];
      var incomingTopic = bytes2str(pkt.data.slice(2, 2 + topicLen));
      var payload = pkt.data.slice(2 + topicLen);

      if (presenceTopic && incomingTopic === presenceTopic) {
        if (presenceCallback) presenceCallback(decodeUTF8(payload));
        return;
      }
      if (!messageCallback) return;

      if (config.plain) {
        try {
          messageCallback(JSON.parse(decodeUTF8(payload)));
        } catch (e) {
          // Ignore malformed messages
        }
        return;
      }
      if (!cryptoKey) return;
      decrypt(cryptoKey, payload).then(function (plaintext) {
        try {
          messageCallback(JSON.parse(plaintext));
        } catch (e) {
          // Ignore malformed messages
        }
      }).catch(function () {
        // Decryption failed — wrong key or corrupted, ignore
      });
    }

    function handlePacket(pkt) {
      switch (pkt.type) {
        case 2: // CONNACK
          if (pkt.data[1] === 0) {
            var topics = config.presence === 'watch' ? [topic, presenceTopic] : [topic];
            ws.send(buildSubscribe(packetId, topics));
            packetId = (packetId + 1) & 0xFFFF || 1;
          } else {
            setStatus('auth_failed');
          }
          break;

        case 3: // PUBLISH
          handlePublish(pkt);
          break;

        case 9: // SUBACK: publish only after this client can receive messages.
          connected = true;
          reconnectCount = 0;
          startPing();
          if (announces()) ws.send(buildPublish(presenceTopic, encodeUTF8('1'), true));
          setStatus('connected');
          break;

        case 13: // PINGRESP
          if (pongTimer) {
            clearTimeout(pongTimer);
            pongTimer = null;
          }
          break;
      }
    }

    // ── Public API ──

    function connect(cfg) {
      stopReconnect();
      releaseSocket();
      config = cfg;
      destroyed = false;
      reconnectCount = 0;
      cryptoKey = null;

      if (cfg.plain) {
        topic = cfg.topic;
        presenceTopic = '';
        doConnect();
        return Promise.resolve();
      }

      return hashTopic(cfg.token).then(function (t) {
        topic = t;
        presenceTopic = t + '/p';
        return deriveKey(cfg.token);
      }).then(function (key) {
        if (config !== cfg) return; // superseded by a newer connect()
        cryptoKey = key;
        doConnect();
      });
    }

    function send(data) {
      if (!connected || !ws || !config) return Promise.resolve(false);
      var json = JSON.stringify(data);
      var socket = ws;
      var outgoingTopic = topic;

      if (config.plain) {
        socket.send(buildPublish(outgoingTopic, encodeUTF8(json), false));
        return Promise.resolve(true);
      }
      if (!cryptoKey) return Promise.resolve(false);
      return encrypt(cryptoKey, json).then(function (encrypted) {
        if (socket === ws && socket.readyState === 1) {
          socket.send(buildPublish(outgoingTopic, encrypted, false));
          return true;
        }
        return false;
      });
    }

    function onMessage(fn) {
      messageCallback = fn;
    }

    function onStatus(fn) {
      statusCallback = fn;
    }

    function onPresence(fn) {
      presenceCallback = fn;
    }

    function disconnect(finalPresence) {
      destroyed = true;
      stopReconnect();
      if (ws) {
        try {
          if (connected && announces()) {
            ws.send(buildPublish(presenceTopic, encodeUTF8(finalPresence || '0'), true));
          }
          ws.send(buildDisconnect());
        } catch (e) { /* ignore */ }
      }
      releaseSocket();
      cryptoKey = null;
      setStatus('disconnected');
    }

    // Force an immediate reconnect (e.g. phone unlocked / tab foregrounded).
    // Tears down any stale socket without triggering the normal reconnect path,
    // resets backoff, and connects right away.
    function reconnectNow() {
      if (destroyed || !config || (!config.plain && !cryptoKey)) return;
      stopReconnect();
      releaseSocket();
      reconnectCount = 0;
      doConnect();
    }

    // Prove the socket is alive right now. Used after sleep/wake, when a socket
    // can report "open" long after the network under it has gone.
    function checkAlive() {
      if (destroyed || !config) return;
      if (connected && ws && ws.readyState === 1) sendPing();
      else if (!reconnectTimer) reconnectNow();
    }

    function isConnected() {
      return connected;
    }

    return {
      connect: connect,
      send: send,
      onMessage: onMessage,
      onStatus: onStatus,
      onPresence: onPresence,
      disconnect: disconnect,
      reconnectNow: reconnectNow,
      checkAlive: checkAlive,
      isConnected: isConnected
    };
  }

  var client = createClient();
  client.createClient = createClient;
  return client;
})();
