/**
 * CouchLock — Web Push sender (runs in the extension service worker)
 *
 * The extension is its own push "application server": it signs requests with
 * a VAPID key and encrypts each payload for the phone (RFC 8291 aes128gcm), then
 * hands the sealed blob to the phone's push service (Apple, Google, Mozilla).
 * The push service only routes it; it can't read it. WebCrypto only, no libraries.
 *
 * Public API:
 *   CouchPush.createVapidKeys()                  → Promise<{ publicKey, privateJwk }>
 *   CouchPush.encrypt(keys, plaintext[, fixed])  → Promise<Uint8Array>  (aes128gcm body)
 *   CouchPush.vapidAuth(endpoint, vapid, subject)→ Promise<string>      (Authorization header)
 *   CouchPush.send(subscription, payload, vapid, options) → Promise<{ ok, status, gone, reason }>
 *
 * subscription — PushSubscription.toJSON(): { endpoint, keys: { p256dh, auth } }
 * vapid        — { publicKey: base64url raw P-256 point, privateJwk }
 */
var CouchPush = (function () {
  'use strict';

  var RECORD_SIZE = 4096;
  var JWT_LIFETIME = 12 * 60 * 60; // seconds; push services reject more than 24h
  var DEFAULT_SUBJECT = 'https://maker023.github.io/CouchLock/';

  // ── Encoding ──

  function concat() {
    var total = 0;
    var i;
    for (i = 0; i < arguments.length; i++) total += arguments[i].length;
    var out = new Uint8Array(total);
    var offset = 0;
    for (i = 0; i < arguments.length; i++) {
      out.set(arguments[i], offset);
      offset += arguments[i].length;
    }
    return out;
  }

  function utf8(s) {
    return new TextEncoder().encode(s);
  }

  function toBase64Url(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function fromBase64Url(s) {
    var b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // Uncompressed P-256 point (0x04 || x || y) ↔ JWK coordinates.
  function pointToJwk(point, d) {
    var jwk = { kty: 'EC', crv: 'P-256', x: toBase64Url(point.slice(1, 33)), y: toBase64Url(point.slice(33, 65)), ext: true };
    if (d) jwk.d = d;
    return jwk;
  }

  // ── HKDF ──

  function hkdf(salt, ikm, info, length) {
    return crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']).then(function (key) {
      return crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: salt, info: info }, key, length * 8);
    }).then(function (bits) {
      return new Uint8Array(bits);
    });
  }

  // ── VAPID ──

  function createVapidKeys() {
    return crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']).then(function (pair) {
      return Promise.all([
        crypto.subtle.exportKey('raw', pair.publicKey),
        crypto.subtle.exportKey('jwk', pair.privateKey)
      ]);
    }).then(function (keys) {
      return { publicKey: toBase64Url(new Uint8Array(keys[0])), privateJwk: keys[1] };
    });
  }

  // ES256 JWT for the push service's origin. WebCrypto's ECDSA signature is
  // already the raw r||s form JWS expects.
  function vapidAuth(endpoint, vapid, subject) {
    var header = toBase64Url(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
    var claims = toBase64Url(utf8(JSON.stringify({
      aud: new URL(endpoint).origin,
      exp: Math.floor(Date.now() / 1000) + JWT_LIFETIME,
      sub: subject || DEFAULT_SUBJECT
    })));
    var unsigned = header + '.' + claims;
    return crypto.subtle.importKey('jwk', vapid.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']).then(function (key) {
      return crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8(unsigned));
    }).then(function (signature) {
      return 'vapid t=' + unsigned + '.' + toBase64Url(new Uint8Array(signature)) + ', k=' + vapid.publicKey;
    });
  }

  // ── Payload encryption (RFC 8291 / RFC 8188 aes128gcm, single record) ──

  // fixed: { salt, serverPublic, serverPrivate } — test vectors only. Real sends
  // use a fresh salt and a one-off ECDH key pair per message.
  function encrypt(keys, plaintext, fixed) {
    var phonePublic = fromBase64Url(keys.p256dh);
    var authSecret = fromBase64Url(keys.auth);
    var salt = fixed ? fromBase64Url(fixed.salt) : crypto.getRandomValues(new Uint8Array(16));
    var ecdh = { name: 'ECDH', namedCurve: 'P-256' };
    var serverPair;

    var pairReady = fixed
      ? crypto.subtle.importKey('jwk', pointToJwk(fromBase64Url(fixed.serverPublic), fixed.serverPrivate), ecdh, false, ['deriveBits'])
        .then(function (privateKey) { return { privateKey: privateKey, raw: fromBase64Url(fixed.serverPublic) }; })
      : crypto.subtle.generateKey(ecdh, true, ['deriveBits']).then(function (pair) {
        return crypto.subtle.exportKey('raw', pair.publicKey).then(function (raw) {
          return { privateKey: pair.privateKey, raw: new Uint8Array(raw) };
        });
      });

    return pairReady.then(function (pair) {
      serverPair = pair;
      return crypto.subtle.importKey('raw', phonePublic, ecdh, false, []);
    }).then(function (phoneKey) {
      return crypto.subtle.deriveBits({ name: 'ECDH', public: phoneKey }, serverPair.privateKey, 256);
    }).then(function (sharedSecret) {
      var keyInfo = concat(utf8('WebPush: info'), new Uint8Array([0]), phonePublic, serverPair.raw);
      return hkdf(authSecret, new Uint8Array(sharedSecret), keyInfo, 32);
    }).then(function (ikm) {
      return Promise.all([
        hkdf(salt, ikm, concat(utf8('Content-Encoding: aes128gcm'), new Uint8Array([0])), 16),
        hkdf(salt, ikm, concat(utf8('Content-Encoding: nonce'), new Uint8Array([0])), 12)
      ]);
    }).then(function (derived) {
      return crypto.subtle.importKey('raw', derived[0], 'AES-GCM', false, ['encrypt']).then(function (cek) {
        // 0x02 marks the final (and only) record; no padding.
        return crypto.subtle.encrypt({ name: 'AES-GCM', iv: derived[1] }, cek, concat(plaintext, new Uint8Array([2])));
      });
    }).then(function (cipher) {
      var header = new Uint8Array(21);
      header.set(salt);
      new DataView(header.buffer).setUint32(16, RECORD_SIZE);
      header[20] = serverPair.raw.length;
      return concat(header, serverPair.raw, new Uint8Array(cipher));
    });
  }

  // ── Send ──

  // options: { ttl (seconds), urgency, subject }. No Topic header: Apple's push
  // service rejects it (400 BadWebPushTopic). The notification tag in sw.js
  // replaces an older notification of the same kind instead.
  function send(subscription, payload, vapid, options) {
    options = options || {};
    var body;
    return encrypt(subscription.keys, utf8(JSON.stringify(payload))).then(function (encrypted) {
      body = encrypted;
      return vapidAuth(subscription.endpoint, vapid, options.subject);
    }).then(function (authorization) {
      var headers = {
        'Authorization': authorization,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        'TTL': String(options.ttl || 60),
        'Urgency': options.urgency || 'high'
      };
      return fetch(subscription.endpoint, { method: 'POST', headers: headers, body: body });
    }).then(function (response) {
      // 404/410: the phone dropped this subscription — stop using it.
      var result = { ok: response.ok, status: response.status, gone: response.status === 404 || response.status === 410, reason: '' };
      if (response.ok) return result;
      // Push services explain rejections in the body, e.g. Apple's {"reason":"BadJwtToken"}.
      return response.text().then(function (text) {
        result.reason = text.slice(0, 200);
        return result;
      }, function () {
        return result;
      });
    }).catch(function (err) {
      // Encryption or network failure: nothing reached the push service.
      return { ok: false, status: 0, gone: false, reason: err && err.message ? err.message : String(err) };
    });
  }

  return {
    createVapidKeys: createVapidKeys,
    encrypt: encrypt,
    vapidAuth: vapidAuth,
    send: send
  };
})();
