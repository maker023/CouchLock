/**
 * CouchLock Transport Layer
 * Minimal MQTT 3.1.1 client over WebSocket + AES-GCM encryption.
 * Used by both extension (background.js) and PWA (index.html).
 *
 * Public API:
 *   CouchTransport.connect(config)   → Promise
 *   CouchTransport.send(data)        → void
 *   CouchTransport.onMessage(fn)     → void
 *   CouchTransport.disconnect()      → void
 *   CouchTransport.isConnected()     → boolean
 *   CouchTransport.onStatus(fn)      → void  (status callback)
 *
 * Config: { broker, token, sessionId }
 *   broker    — WSS URL (default: wss://broker.hivemq.com:8884/mqtt)
 *   token     — 32-byte hex session token (used as encryption key + topic hash)
 *   sessionId — unique session identifier
 */
var CouchTransport = (function () {
  'use strict';

  var BROKER_URL = 'wss://broker.hivemq.com:8884/mqtt';
  var KEEPALIVE = 30; // seconds
  var RECONNECT_DELAY = 2000;
  var MAX_RECONNECT = 10;

  var ws = null;
  var connected = false;
  var topic = '';
  var cryptoKey = null;
  var messageCallback = null;
  var statusCallback = null;
  var pingTimer = null;
  var reconnectTimer = null;
  var reconnectCount = 0;
  var config = null;
  var packetId = 1;
  var destroyed = false;

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

  function setStatus(s) {
    if (statusCallback) statusCallback(s);
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

  // ── MQTT 3.1.1 Packet Builders ──

  function buildConnect(clientId) {
    var proto = [0x00, 0x04].concat(str2bytes('MQTT')); // protocol name
    var level = [0x04]; // protocol level 3.1.1
    var flags = [0x02]; // clean session
    var keepalive = [KEEPALIVE >> 8, KEEPALIVE & 0xFF];
    var idBytes = str2bytes(clientId);
    var idLen = [idBytes.length >> 8, idBytes.length & 0xFF];

    var varHeader = proto.concat(level, flags, keepalive);
    var payload = idLen.concat(idBytes);
    var remaining = varHeader.concat(payload);

    return u8([0x10].concat(encodeLength(remaining.length), remaining));
  }

  function buildSubscribe(topicStr) {
    var id = [(packetId >> 8) & 0xFF, packetId & 0xFF];
    packetId = (packetId + 1) & 0xFFFF || 1;

    var topicBytes = str2bytes(topicStr);
    var topicLen = [topicBytes.length >> 8, topicBytes.length & 0xFF];
    var qos = [0x00]; // QoS 0

    var remaining = id.concat(topicLen, topicBytes, qos);
    return u8([0x82].concat(encodeLength(remaining.length), remaining));
  }

  function buildPublish(topicStr, payload) {
    var topicBytes = str2bytes(topicStr);
    var topicLen = [topicBytes.length >> 8, topicBytes.length & 0xFF];

    var payloadBytes = Array.from(payload);
    var remaining = topicLen.concat(Array.from(topicBytes), payloadBytes);

    return u8([0x30].concat(encodeLength(remaining.length), remaining));
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

    return {
      type: type,
      data: bytes.slice(offset, offset + len),
      totalLength: offset + len
    };
  }

  // ── Connection ──

  function hashTopic(token) {
    return crypto.subtle.digest('SHA-256', hex2bytes(token)).then(function (hash) {
      return 'cl/' + bytes2hex(new Uint8Array(hash)).slice(0, 16);
    });
  }

  function startPing() {
    stopPing();
    pingTimer = setInterval(function () {
      if (ws && ws.readyState === 1) {
        ws.send(buildPingreq());
      }
    }, KEEPALIVE * 1000 * 0.8);
  }

  function stopPing() {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  }

  function stopReconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnect() {
    if (destroyed) return;
    if (reconnectCount >= MAX_RECONNECT) {
      setStatus('failed');
      return;
    }
    reconnectCount++;
    setStatus('reconnecting');
    reconnectTimer = setTimeout(function () {
      doConnect();
    }, RECONNECT_DELAY);
  }

  function doConnect() {
    if (destroyed) return;
    setStatus('connecting');

    var broker = (config && config.broker) || BROKER_URL;
    var clientId = 'cl_' + Math.random().toString(36).slice(2, 10);

    try {
      ws = new WebSocket(broker, ['mqtt']);
    } catch (e) {
      scheduleReconnect();
      return;
    }
    ws.binaryType = 'arraybuffer';

    var buf = new ArrayBuffer(0);

    ws.onopen = function () {
      ws.send(buildConnect(clientId));
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
      while (buf.byteLength > 0) {
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

  function handlePacket(pkt) {
    switch (pkt.type) {
      case 2: // CONNACK
        if (pkt.data[1] === 0) {
          connected = true;
          reconnectCount = 0;
          ws.send(buildSubscribe(topic));
          startPing();
          setStatus('connected');
        } else {
          setStatus('auth_failed');
        }
        break;

      case 3: // PUBLISH
        var topicLen = (pkt.data[0] << 8) | pkt.data[1];
        var payload = pkt.data.slice(2 + topicLen);
        if (cryptoKey && messageCallback) {
          decrypt(cryptoKey, payload).then(function (plaintext) {
            try {
              var msg = JSON.parse(plaintext);
              messageCallback(msg);
            } catch (e) {
              // Ignore malformed messages
            }
          }).catch(function () {
            // Decryption failed — wrong key or corrupted, ignore
          });
        }
        break;

      case 9:  // SUBACK
      case 13: // PINGRESP
        break;
    }
  }

  // ── Public API ──

  function connect(cfg) {
    config = cfg;
    destroyed = false;
    reconnectCount = 0;

    return hashTopic(cfg.token).then(function (t) {
      topic = t;
      return deriveKey(cfg.token);
    }).then(function (key) {
      cryptoKey = key;
      doConnect();
    });
  }

  function send(data) {
    if (!connected || !ws || !cryptoKey) return;
    var json = JSON.stringify(data);
    encrypt(cryptoKey, json).then(function (encrypted) {
      if (ws && ws.readyState === 1) {
        ws.send(buildPublish(topic, encrypted));
      }
    });
  }

  function onMessage(fn) {
    messageCallback = fn;
  }

  function onStatus(fn) {
    statusCallback = fn;
  }

  function disconnect() {
    destroyed = true;
    stopPing();
    stopReconnect();
    if (ws) {
      try { ws.send(buildDisconnect()); } catch (e) { /* ignore */ }
      ws.close();
      ws = null;
    }
    connected = false;
    cryptoKey = null;
    setStatus('disconnected');
  }

  function isConnected() {
    return connected;
  }

  return {
    connect: connect,
    send: send,
    onMessage: onMessage,
    onStatus: onStatus,
    disconnect: disconnect,
    isConnected: isConnected
  };
})();
