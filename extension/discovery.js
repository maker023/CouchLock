/**
 * CouchLock Discovery — find and pair with a nearby laptop without scanning a QR.
 * Used by both the extension popup (host) and the PWA (finder). Requires transport.js.
 *
 * Rendezvous: devices on the same WiFi share one public IP, so both sides derive
 * the same broker topic from it. A 6-digit code shown in the popup is a second
 * rendezvous for networks where that doesn't hold (VPN, guest networks).
 *
 * The topic is NOT a secret — anyone can listen. Security comes from the exchange:
 *   1. Laptop announces an ECDH public key; phone replies with its own.
 *   2. Laptop commits to a nonce (hash), phone sends its nonce, laptop reveals.
 *   3. Both derive the same 4-digit code from keys + nonces. The user confirms the
 *      match on the laptop, which then sends the session token encrypted with the
 *      ECDH secret. Committing before revealing stops an attacker from grinding
 *      keys until the codes match — they get one 1-in-10,000 guess per attempt.
 *
 * Public API:
 *   CouchDiscovery.host({ name, code, onRequest(req) }) → { stop() }
 *     req = { name, code, accept(payload), decline() }
 *   CouchDiscovery.find({ name, code, onHost(host), onError(reason) }) → { pair(hostId, onCode) → Promise<payload>, stop() }
 *     Without code: searches the local network. With code: pairs with the code's host.
 *   CouchDiscovery.newCode() → '123456'
 */
var CouchDiscovery = (function () {
  'use strict';

  var IP_URL = 'https://api.ipify.org?format=json'; // IPv4-only so both sides see the router's address
  var TOPIC_SALT = 'couchlock-discovery-v1';
  var ANNOUNCE_MS = 1500;
  var PAIR_TIMEOUT = 120000;
  var CODE_DIGITS = 6;
  var SAS_DIGITS = 4;

  // ── Helpers ──

  function utf8(s) {
    return new TextEncoder().encode(s);
  }

  function toB64(bytes) {
    return btoa(String.fromCharCode.apply(null, new Uint8Array(bytes)));
  }

  function fromB64(s) {
    var bin = atob(s);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function toHex(bytes) {
    var arr = new Uint8Array(bytes);
    var hex = '';
    for (var i = 0; i < arr.length; i++) hex += ('0' + arr[i].toString(16)).slice(-2);
    return hex;
  }

  function sha256(bytes) {
    return crypto.subtle.digest('SHA-256', bytes);
  }

  function randomHex(byteCount) {
    return toHex(crypto.getRandomValues(new Uint8Array(byteCount)));
  }

  function newCode() {
    var n = crypto.getRandomValues(new Uint32Array(1))[0] % Math.pow(10, CODE_DIGITS);
    return ('000000' + n).slice(-CODE_DIGITS);
  }

  function topicFor(kind, secret) {
    return sha256(utf8(TOPIC_SALT + '|' + kind + '|' + secret)).then(function (hash) {
      return 'cld/' + toHex(hash).slice(0, 24);
    });
  }

  function publicIp() {
    return fetch(IP_URL, { cache: 'no-store' }).then(function (res) {
      if (!res.ok) throw new Error('ip lookup failed');
      return res.json();
    }).then(function (data) {
      if (!data || !data.ip) throw new Error('ip lookup failed');
      return data.ip;
    });
  }

  // ── Key exchange ──

  function generateKeys() {
    return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']).then(function (pair) {
      return crypto.subtle.exportKey('raw', pair.publicKey).then(function (raw) {
        return { privateKey: pair.privateKey, pub: toB64(raw) };
      });
    });
  }

  function sharedSecret(privateKey, peerPub) {
    return crypto.subtle.importKey('raw', fromB64(peerPub), { name: 'ECDH', namedCurve: 'P-256' }, false, [])
      .then(function (peerKey) {
        return crypto.subtle.deriveBits({ name: 'ECDH', public: peerKey }, privateKey, 256);
      });
  }

  function commitment(hostPub, phonePub, hostNonce) {
    return sha256(utf8('commit|' + hostPub + '|' + phonePub + '|' + hostNonce)).then(toHex);
  }

  function confirmCode(hostPub, phonePub, phoneNonce, hostNonce) {
    return sha256(utf8('sas|' + hostPub + '|' + phonePub + '|' + phoneNonce + '|' + hostNonce)).then(function (hash) {
      var n = new DataView(hash).getUint32(0) % Math.pow(10, SAS_DIGITS);
      return ('0000' + n).slice(-SAS_DIGITS);
    });
  }

  function sessionKey(secret, phoneNonce, hostNonce) {
    var salt = utf8('key|' + phoneNonce + '|' + hostNonce);
    var material = new Uint8Array(secret.byteLength + salt.length);
    material.set(new Uint8Array(secret));
    material.set(salt, secret.byteLength);
    return sha256(material).then(function (raw) {
      return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    });
  }

  function seal(key, payload) {
    var iv = crypto.getRandomValues(new Uint8Array(12));
    return crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, utf8(JSON.stringify(payload))).then(function (cipher) {
      return { iv: toB64(iv), data: toB64(cipher) };
    });
  }

  function open(key, box) {
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(box.iv) }, key, fromB64(box.data)).then(function (plain) {
      return JSON.parse(new TextDecoder().decode(plain));
    });
  }

  // Plain-text broker channel on one topic.
  function channel(topic, onMessage, onReady) {
    var client = CouchTransport.createClient();
    client.onMessage(function (msg) {
      if (msg && typeof msg === 'object') onMessage(msg);
    });
    client.onStatus(function (status) {
      if (status === 'connected' && onReady) onReady();
    });
    client.connect({ topic: topic, plain: true });
    return client;
  }

  // ── Host (laptop popup) ──

  function host(options) {
    var hostId = randomHex(8);
    var keys = null;
    var channels = [];
    var pending = {};   // phone id → exchange state
    var prompting = false;
    var stopped = false;
    var announceTimer = null;

    function announce(ch) {
      ch.send({ t: 'announce', id: hostId, name: options.name, pub: keys.pub });
    }

    function announceAll() {
      channels.forEach(announce);
    }

    function handle(ch, msg) {
      if (msg.to !== undefined && msg.to !== hostId) return;

      if (msg.t === 'probe') {
        announce(ch);
        return;
      }

      if (msg.t === 'req' && typeof msg.pub === 'string' && typeof msg.from === 'string') {
        if (prompting || pending[msg.from]) return;
        var nonce = randomHex(16);
        var state = { pub: msg.pub, name: String(msg.name || 'Phone').slice(0, 40), nonce: nonce, created: Date.now() };
        pending[msg.from] = state;
        commitment(keys.pub, state.pub, nonce).then(function (c) {
          ch.send({ t: 'commit', to: msg.from, from: hostId, c: c });
        });
        return;
      }

      if (msg.t === 'nonce' && !prompting && pending[msg.from] && typeof msg.n === 'string' && !pending[msg.from].phoneNonce) {
        var st = pending[msg.from];
        if (Date.now() - st.created > PAIR_TIMEOUT) { delete pending[msg.from]; return; }
        st.phoneNonce = msg.n;
        ch.send({ t: 'reveal', to: msg.from, from: hostId, n: st.nonce });
        prompting = true;
        Promise.all([
          confirmCode(keys.pub, st.pub, st.phoneNonce, st.nonce),
          sharedSecret(keys.privateKey, st.pub).then(function (secret) {
            return sessionKey(secret, st.phoneNonce, st.nonce);
          })
        ]).then(function (results) {
          if (stopped) return;
          var key = results[1];
          var settled = false;
          function finish() {
            settled = true;
            prompting = false;
            delete pending[msg.from];
          }
          options.onRequest({
            name: st.name,
            code: results[0],
            accept: function (payload) {
              if (settled) return;
              finish();
              seal(key, payload).then(function (box) {
                ch.send({ t: 'grant', to: msg.from, from: hostId, iv: box.iv, data: box.data });
              });
            },
            decline: function () {
              if (settled) return;
              finish();
              ch.send({ t: 'deny', to: msg.from, from: hostId });
            }
          });
        }).catch(function () {
          prompting = false;
          delete pending[msg.from];
        });
      }
    }

    function listen(topic) {
      var ch = channel(topic, function (msg) { handle(ch, msg); }, function () { announce(ch); });
      channels.push(ch);
    }

    generateKeys().then(function (k) {
      if (stopped) return;
      keys = k;
      topicFor('code', options.code).then(function (topic) {
        if (!stopped) listen(topic);
      });
      publicIp().then(function (ip) {
        return topicFor('ip', ip);
      }).then(function (topic) {
        if (!stopped) listen(topic);
      }).catch(function () {
        // No public IP (offline, blocked) — the code still works.
      });
      announceTimer = setInterval(announceAll, ANNOUNCE_MS);
    });

    return {
      stop: function () {
        stopped = true;
        clearInterval(announceTimer);
        channels.forEach(function (ch) { ch.disconnect(); });
        channels = [];
      }
    };
  }

  // ── Finder (phone) ──

  function find(options) {
    var phoneId = randomHex(8);
    var keys = null;
    var ch = null;
    var hosts = {};
    var exchange = null;
    var stopped = false;
    var probeTimer = null;

    function fail(reason) {
      if (exchange) {
        exchange.reject(new Error(reason));
        clearTimeout(exchange.timer);
        exchange = null;
      }
    }

    function handle(msg) {
      if (msg.t === 'announce' && typeof msg.id === 'string' && typeof msg.pub === 'string') {
        if (!hosts[msg.id]) {
          hosts[msg.id] = { id: msg.id, name: String(msg.name || 'Laptop').slice(0, 40), pub: msg.pub };
          if (options.onHost) options.onHost({ id: msg.id, name: hosts[msg.id].name });
        }
        return;
      }
      if (!exchange || msg.to !== phoneId || msg.from !== exchange.host.id) return;

      if (msg.t === 'commit' && typeof msg.c === 'string' && !exchange.commit) {
        exchange.commit = msg.c;
        ch.send({ t: 'nonce', to: exchange.host.id, from: phoneId, n: exchange.nonce });
        return;
      }

      if (msg.t === 'reveal' && exchange.commit && !exchange.key && typeof msg.n === 'string') {
        var ex = exchange;
        commitment(ex.host.pub, keys.pub, msg.n).then(function (expected) {
          if (expected !== ex.commit) throw new Error('mismatch');
          return Promise.all([
            confirmCode(ex.host.pub, keys.pub, ex.nonce, msg.n),
            sharedSecret(keys.privateKey, ex.host.pub).then(function (secret) {
              return sessionKey(secret, ex.nonce, msg.n);
            })
          ]);
        }).then(function (results) {
          if (ex !== exchange) return;
          ex.key = results[1];
          ex.onCode(results[0]);
        }).catch(function () {
          if (ex === exchange) fail('mismatch');
        });
        return;
      }

      if (msg.t === 'grant' && exchange.key) {
        var granted = exchange;
        open(granted.key, msg).then(function (payload) {
          if (granted !== exchange) return;
          clearTimeout(granted.timer);
          exchange = null;
          granted.resolve(payload);
        }).catch(function () {
          if (granted === exchange) fail('mismatch');
        });
        return;
      }

      if (msg.t === 'deny') fail('denied');
    }

    function probe() {
      if (ch) ch.send({ t: 'probe', from: phoneId });
    }

    var topicReady = options.code
      ? topicFor('code', options.code)
      : publicIp().then(function (ip) { return topicFor('ip', ip); });

    Promise.all([generateKeys(), topicReady]).then(function (results) {
      if (stopped) return;
      keys = results[0];
      ch = channel(results[1], handle, probe);
      probeTimer = setInterval(probe, ANNOUNCE_MS * 2);
    }).catch(function () {
      if (options.onError) options.onError('network');
    });

    return {
      pair: function (hostId, onCode) {
        var target = hosts[hostId];
        if (!target || !keys || !ch) return Promise.reject(new Error('unknown'));
        fail('superseded');
        return new Promise(function (resolve, reject) {
          exchange = {
            host: target,
            nonce: randomHex(16),
            onCode: onCode,
            resolve: resolve,
            reject: reject,
            timer: setTimeout(function () { fail('timeout'); }, PAIR_TIMEOUT)
          };
          ch.send({ t: 'req', to: hostId, from: phoneId, pub: keys.pub, name: options.name });
        });
      },
      stop: function () {
        stopped = true;
        clearInterval(probeTimer);
        fail('stopped');
        if (ch) ch.disconnect();
        ch = null;
      }
    };
  }

  return {
    host: host,
    find: find,
    newCode: newCode
  };
})();
