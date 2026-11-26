/* 音声で日報：画面の動き
   1. 話す：ブラウザの音声認識で文字にする（使えない機種はキーボードのマイク）
   2. 日報を送信する：社員名・日報の日付・日時・文字起こしを、この携帯から Gmail で直接送る（Gmail API）
      初回は Google アカウントでログインし「メールの送信」を許可する。サーバーや Apps Script は通さない
      電波がないときは携帯に保存し（まだ送れていない日報）、電波が戻ったら送る
   要約と Excel への記録は、メールを受け取ったパソコンのサーバー（mail-worker.mjs）が行う。
   設定（config.js）：window.GOOGLE_CLIENT_ID（Google Cloud の OAuth クライアント ID）、window.REPORT_TO（宛先のはじめの値） */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var MAX_SEC = 90;
  var SCOPE = 'https://www.googleapis.com/auth/gmail.send';
  var store = {
    get: function (k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
  // 宛先：携帯で登録したもの → なければ config.js の値
  if (!store.get('report_to') && window.REPORT_TO) store.set('report_to', window.REPORT_TO);

  function show(text, kind) {
    var m = $('msg'); m.textContent = text; m.className = 'msg show ' + (kind || 'info');
    m.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function hideMsg() { $('msg').className = 'msg'; }

  // ---------- 社員名・送り先 ----------
  function validMail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s); }
  function showWho() { $('who').textContent = store.get('employee') || '（未登録）'; }
  function openSettings() {
    $('employee').value = store.get('employee');
    $('report-to').value = store.get('report_to');
    $('google-hint').hidden = false;
    $('settings').hidden = false; $('settings').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  $('open-settings').onclick = openSettings;
  $('save-settings').onclick = function () {
    var name = $('employee').value.trim();
    var to = $('report-to').value.trim();
    if (!name) { show('社員名を入れてください。', 'err'); return; }
    if (!validMail(to)) { show('日報の送り先のメールアドレスを確かめてください。', 'err'); return; }
    store.set('employee', name); store.set('report_to', to); showWho(); $('settings').hidden = true;
    show(name + ' さんで登録しました。', 'good');
  };
  showWho();
  if (!store.get('employee') || !store.get('report_to')) openSettings();

  // ---------- 1. 話す ----------
  var ta = $('transcript');
  ta.value = store.get('draft_transcript');
  function keep() { store.set('draft_transcript', ta.value); }
  ['input', 'change', 'keyup', 'compositionend', 'blur'].forEach(function (ev) { ta.addEventListener(ev, keep); });

  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var rec = null, recording = false, startAt = 0, tick = null, base = '';
  if (!SR) { $('rec').hidden = true; $('timer').hidden = true; }

  function setTimer() {
    var s = Math.floor((Date.now() - startAt) / 1000);
    $('timer').textContent = Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
    if (s >= MAX_SEC) stopRec();
  }
  function startRec() {
    rec = new SR();
    rec.lang = 'ja-JP'; rec.continuous = true; rec.interimResults = true;
    base = ta.value ? ta.value.replace(/\s*$/, '') + '\n' : '';
    rec.onresult = function (e) {
      var fin = '', mid = '';
      for (var i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) fin += e.results[i][0].transcript; else mid += e.results[i][0].transcript;
      }
      if (fin) { base += fin; ta.value = base; keep(); }
      $('interim').textContent = mid;
    };
    rec.onspeechstart = hideMsg;
    rec.onerror = function (e) {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      show('「話す」ボタンが使えません（' + e.error + '）。下の欄をタップして、キーボードのマイクで話してください。', 'err');
      stopRec();
    };
    rec.onend = function () { if (recording) { try { rec.start(); } catch (e) { stopRec(); } } };
    try { rec.start(); } catch (e) { show('音声認識を始められませんでした。キーボードのマイクで話してください。', 'err'); return; }
    recording = true; startAt = Date.now(); tick = setInterval(setTimer, 250);
    $('rec').textContent = '止める'; $('rec').classList.add('on'); $('rec').setAttribute('aria-pressed', 'true');
    show('聞き取り中です。話してください。', 'info');
  }
  function stopRec() {
    recording = false; clearInterval(tick);
    if (rec) { try { rec.stop(); } catch (e) {} }
    $('rec').textContent = '話す'; $('rec').classList.remove('on'); $('rec').setAttribute('aria-pressed', 'false');
    $('interim').textContent = '';
  }
  $('rec').onclick = function () { if (recording) stopRec(); else startRec(); };

  // ---------- 日報の日付（はじめは今日。変えられる） ----------
  function today() {
    var d = new Date(), p = function (n) { return ('0' + n).slice(-2); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  var dateTouched = false; // 自分で変えたら、自動で今日に戻さない
  $('report-date').value = today();
  $('report-date').max = today();
  $('report-date').addEventListener('change', function () { dateTouched = true; });
  // アプリを開いたまま日をまたいだら、今日に直す
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') { $('report-date').max = today(); if (!dateTouched) $('report-date').value = today(); }
  });

  // ---------- Google ログイン（Gmail の送信の許可） ----------
  // 許可（アクセストークン）は1時間ほど使える。携帯の中（sessionStorage）に期限つきで覚えておく
  var token = null, tokenExp = 0, tokenClient = null;
  try { var t = JSON.parse(sessionStorage.getItem('gmail_token') || 'null'); if (t && t.exp > Date.now()) { token = t.token; tokenExp = t.exp; } } catch (e) {}
  function hasToken() { return token && tokenExp - 60000 > Date.now(); }
  function getToken() {
    if (hasToken()) return Promise.resolve(token);
    return new Promise(function (resolve, reject) {
      if (!window.GOOGLE_CLIENT_ID) return reject(new Error('送信の設定（Google のクライアント ID）がまだです。管理者に連絡してください。'));
      if (!window.google || !google.accounts || !google.accounts.oauth2) return reject(new Error('Google のログイン画面を読み込めませんでした。電波を確かめてください。'));
      tokenClient = tokenClient || google.accounts.oauth2.initTokenClient({ client_id: window.GOOGLE_CLIENT_ID, scope: SCOPE, callback: function () {} });
      tokenClient.callback = function (r) {
        if (r.error || !r.access_token) return reject(new Error('Google のログイン・送信の許可ができませんでした（' + (r.error || '不明') + '）。'));
        if (google.accounts.oauth2.hasGrantedAllScopes && !google.accounts.oauth2.hasGrantedAllScopes(r, SCOPE)) return reject(new Error('「メールの送信」にチェックを入れて許可してください。'));
        token = r.access_token; tokenExp = Date.now() + Number(r.expires_in || 3600) * 1000;
        try { sessionStorage.setItem('gmail_token', JSON.stringify({ token: token, exp: tokenExp })); } catch (e) {}
        resolve(token);
      };
      tokenClient.error_callback = function (e) { reject(new Error(e && e.type === 'popup_closed' ? 'Google のログイン画面が閉じられました。もう一度送信してください。' : 'Google のログイン画面を開けませんでした。')); };
      tokenClient.requestAccessToken({ prompt: store.get('google_ok') ? '' : 'consent' });
    });
  }

  // ---------- 日報メールを作る（件名・本文は mail-worker.mjs が読む形） ----------
  function b64(str) { // UTF-8 の文字列 → base64
    var bytes = new TextEncoder().encode(str), bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function mime(r) {
    var subject = '日報 ' + r.employee + ' ' + r.created;
    var body = '社員名：' + r.employee + '\n日報の日付：' + r.report_date + '\n日時：' + r.created + '\n\n【音声入力】\n' + r.transcript + '\n';
    var msg = [
      'To: ' + r.to,
      'Subject: =?UTF-8?B?' + b64(subject) + '?=',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      'X-Nippo-Id: ' + r.id,
      '',
      b64(body).replace(/.{76}/g, '$&\r\n')
    ].join('\r\n');
    return b64(msg).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); // Gmail API は base64url
  }
  function sendOne(r) {
    return getToken().then(function (tk) {
      return fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + tk, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw: mime(r) })
      }).then(function (res) {
        if (res.ok) { store.set('google_ok', '1'); return; }
        if (res.status === 401) { token = null; tokenExp = 0; try { sessionStorage.removeItem('gmail_token'); } catch (e) {} }
        return res.json().catch(function () { return {}; }).then(function (j) {
          var e = new Error(res.status === 401 ? 'Google の許可が切れました。もう一度送信してください。' : '送信できませんでした（' + res.status + (j.error && j.error.message ? '：' + j.error.message : '') + '）。');
          e.keep = true; throw e;
        });
      }, function () { var e = new Error('電波がないため送れませんでした。'); e.offline = true; e.keep = true; throw e; });
    });
  }

  // ---------- まだ送れていない日報（携帯に保存） ----------
  function outbox() { try { return JSON.parse(store.get('outbox') || '[]'); } catch (e) { return []; } }
  function setOutbox(list) { if (list.length) store.set('outbox', JSON.stringify(list)); else store.del('outbox'); showOutbox(); }
  function showOutbox() { var n = outbox().length; $('outbox').hidden = !n; $('outbox-count').textContent = n; }
  var flushing = false;
  // 保存した日報を古い順に送る。interactive が false のときは、ログイン画面を出さない（許可があるときだけ送る）
  function flush(interactive) {
    var list = outbox();
    if (flushing || !list.length) return Promise.resolve(0);
    if (!interactive && !hasToken()) return Promise.resolve(0);
    flushing = true; var sent = 0;
    function next() {
      var l = outbox(); if (!l.length) return Promise.resolve();
      return sendOne(l[0]).then(function () { setOutbox(outbox().filter(function (x) { return x.id !== l[0].id; })); sent++; return next(); });
    }
    return next().then(function () { return sent; }, function (e) { e.sent = sent; throw e; })
      .then(function (n) { flushing = false; return n; }, function (e) { flushing = false; throw e; });
  }
  $('outbox-send').onclick = function () {
    var btn = this; btn.disabled = true;
    flush(true).then(function (n) { show('保存していた日報を ' + n + ' 件送信しました。', 'good'); },
      function (e) { show((e.sent ? e.sent + ' 件送信しました。' : '') + e.message + '（日報は保存したままです）', 'err'); })
      .then(function () { btn.disabled = false; });
  };
  window.addEventListener('online', function () {
    flush(false).then(function (n) { if (n) show('電波が戻ったので、保存していた日報を ' + n + ' 件送信しました。', 'good'); }, function () {});
  });
  showOutbox();

  // ---------- 2. 日報を送信する ----------
  function now() {
    var d = new Date(), p = function (n) { return ('0' + n).slice(-2); };
    return today() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function clearForm() {
    ta.value = ''; store.del('draft_transcript'); $('timer').textContent = '0:00';
    $('report-date').value = today(); dateTouched = false; // 次の日報は今日に戻す
  }
  $('mail').onclick = function () {
    if (recording) stopRec();
    var name = store.get('employee'), to = store.get('report_to');
    if (!name || !to) { openSettings(); show('先に社員名と日報の送り先を登録してください。', 'err'); return; }
    var text = ta.value.trim();
    if (!text) { show('文字起こしが空です。話してから押してください。', 'err'); return; }
    if (text.length > 4000) { show('長すぎます（4000字まで）。', 'err'); return; }
    var reportDate = $('report-date').value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) { show('日報の日付を選んでください。', 'err'); return; }
    if (reportDate > today()) { show('日報の日付が未来になっています。確かめてください。', 'err'); return; }
    var r = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), employee: name, to: to, created: now(), report_date: reportDate, transcript: text };

    // 電波がないときは、ログイン画面を出さずに保存する
    if (navigator.onLine === false) {
      setOutbox(outbox().concat([r])); clearForm();
      show(reportDate + ' の日報を携帯に保存しました。電波が戻ったら送ります（送れないときは「今すぐ送る」）。', 'info');
      return;
    }
    var btn = this; btn.disabled = true; btn.textContent = '送信しています…';
    sendOne(r).then(function () {
      clearForm();
      show(reportDate + ' の日報を送信しました。おつかれさまでした。', 'good');
      flush(false).catch(function () {}); // 保存していた日報があれば続けて送る
    }, function (e) {
      if (e.offline) { // 送れなかった日報は保存して、文字起こしは消す
        setOutbox(outbox().concat([r])); clearForm();
        show(reportDate + ' の日報を携帯に保存しました。電波が戻ったら送ります（送れないときは「今すぐ送る」）。', 'info');
      } else {
        show(e.message + '（話した内容は残っています）', 'err');
      }
    }).then(function () { btn.disabled = false; btn.textContent = '日報を送信する'; });
  };

  // ---------- アプリとして使う（ホーム画面に追加） ----------
  var standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  var ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var android = /Android/.test(navigator.userAgent);
  var deferred = null;
  function showInstall() {
    if (standalone || store.get('install_closed')) return;
    $('install').hidden = false;
    $('install-ios').hidden = !ios;
    $('install-android').hidden = !android || !!deferred;
    $('install-btn').hidden = !deferred;
  }
  // Android の Chrome（https のとき）は、ボタン1つで追加できる
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferred = e; showInstall(); });
  $('install-btn').onclick = function () {
    if (!deferred) return;
    deferred.prompt();
    deferred.userChoice.then(function () { deferred = null; $('install').hidden = true; });
  };
  $('install-close').onclick = function () { store.set('install_closed', '1'); $('install').hidden = true; };
  if (ios || android) showInstall();

  // 電波がないときでも開けるように（https で公開したときに働く）
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
})();
