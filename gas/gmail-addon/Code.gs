// ============================================================
// アンシスに保存（Gmail アドオン） ver.2.2
//   ver.2.2：さらに速く
//            ・保存：ファイルを同時にアップロード（5MBまでのファイル。大きいものは1件ずつ）。フォルダの確認と同じファイルの確認も同時に
//            ・パネルを開く：アンシスへの問い合わせを2回にまとめ、保存済みの印の確認も同時に
//            ・10分以内に同じメールを開き直したら、覚えている候補で開く（「↻ 最新にする」で読み直し）
//   ver.2.1：速さの改善
//            ・保存：ドライブへの書き込みを1ファイル1回に（説明・保存済みの印も同時に）、同じファイルの確認はフォルダごとに1回
//            ・押印済みフォルダはまとめて探し、見つけた場所を6時間覚える
//            ・候補・添付一覧・保存済みの印を10分覚え、種類の切り替え・検索・「戻る」で探し直さない（メールを開き直すと最新に）
//            ・1回の操作は30秒が上限なので、20秒を過ぎたら区切って「続きを保存」ボタンを出す
//   ver.2.0：ファイル名をそろえる（頭に申請人名／会社名）・zip を展開して保存・アンシスの時系列に記録（case_events）
//   メールを開くと右のパネルに出る。
//   保存先の種類を選び、候補または検索で保存先を選んで、
//   チェックした添付をアンシスに登録済みのドライブフォルダへ保存する。
//     👤 申請人   → cases.drive_url（人材フォルダの直下）
//     🖊 押印書類 → 案件フォルダの「★在留資格申請書類／02 サイン・押印／4. 企業押印済」
//                   （人材フォルダ＝案件フォルダ／★人材資料／申請人名 なので、2つ上の案件フォルダから探す）
//                   （複数人を選べる。まとめて押印リンクの1本PDFを全員分に入れる用）
//     🏢 会社     → companies.drive_url（会社フォルダ）
//   開いている本人の権限で動く（ドライブの書き込み権限が要る）。
//   フォルダは新しく作らない（「4. 企業押印済」が無ければ止めて知らせる）。
//   保存したファイルには「どのメールの何番目の添付か」の印（appProperties）を付け、
//   メールを開き直すとパネルに「✅ 保存済み：保存先」と出す（ドライブの拡張サービス v3 を使う）。
//
// ■ 初期設定（スクリプトプロパティ）
//   SUPABASE_URL  = https://ehwlgbwpycglmopiqyty.supabase.co
//   SUPABASE_KEY  = Supabase の service_role キー（案件・会社を読むだけに使う）
//   ※ アドオンを使う人からはスクリプトプロパティは見えません。
// ============================================================

var SMALL_IMG_BYTES = 30 * 1024; // これより小さい画像は署名画像とみなして初期チェックを外す
var OSHIIN_STATUSES = ['企業押印返送待ち(送付済)', '★企業押印送付'];
var CASE_COLS = 'id,name,applicant,company,company_id,status,drive_url';
var CTX_SEC = 600;          // 候補・添付一覧を覚えておく秒数（10分）
var SAVE_BUDGET_MS = 20000; // 保存はこの時間を過ぎたら区切る（Gmail アドオンの1回の操作は30秒まで）
var FOLDER_MIME = 'application/vnd.google-apps.folder';
var MEMO_ = {};             // 1回の実行の中で、同じメール・スレッドを何度も読まないための控え
var PARALLEL_MAX_BYTES = 5 * 1024 * 1024; // 同時アップロードするのはこの大きさまで（大きいファイルは1件ずつ）
var PARALLEL_CHUNK = 10;                  // 一度に同時に送るファイル数
var DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
var DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id';

// ---------- 入口 ----------
function onHomepage(e) {
  return CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('アンシスに保存'))
    .addSection(CardService.newCardSection().addWidget(
      CardService.newTextParagraph().setText('メールを開くと、添付を人材フォルダ・押印済みフォルダ・会社フォルダへ保存できます。')))
    .build();
}

function onGmailMessage(e) {
  // 10分以内に開いたメールは、覚えている候補で開く（「↻ 最新にする」で読み直せる）
  var ctx = getCtx_(e, false);
  // 件名・本文に「押印」があれば、最初から押印書類を選んだ状態で開く
  return buildCard_(e, { mode: ctx.oshiin ? 'oshiin' : 'person', q: '' }, ctx);
}

// 「↻ 最新にする」：候補・添付・保存済みの印を読み直す（アンシスでフォルダを登録し直したあとなど）
function onRefresh(e) {
  var ctx = getCtx_(e, true);
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText('最新の情報にしました'))
    .setNavigation(CardService.newNavigation().updateCard(buildCard_(e, { mode: e.parameters.mode, q: '' }, ctx))).build();
}

// ---------- 開いているメールの情報（10分覚える） ----------
// { from, atts, saved, cands:{person, company, oshiin}, oshiin }
function ctxKey_(e) { return 'ctx22:' + e.gmail.messageId; }
function loadCtx_(e) {
  try { var v = CacheService.getUserCache().get(ctxKey_(e)); if (v) return JSON.parse(v); } catch (err) {}
  return null;
}
function saveCtx_(e, ctx) {
  try { CacheService.getUserCache().put(ctxKey_(e), JSON.stringify(ctx), CTX_SEC); } catch (err) { console.error('saveCtx_', err); }
}
function getCtx_(e, fresh) {
  var ctx = fresh ? null : loadCtx_(e);
  if (ctx) return ctx;
  var msg = getMessage_(e);
  var from = externalFrom_(msg);
  var ids = threadMsgs_(msg).map(function (m) { return m.getId(); });
  // 保存済みの印の確認は、アンシスへの1回目の問い合わせと同時に送る
  var g = guessAll_(from, msg, [{ key: 'saved', req: savedReq_(ids) }]);
  var saved = parseSaved_((g.extra || {}).saved);
  if (!saved) saved = savedMap_(ids); // うまく読めなかったときは前のやり方で
  ctx = {
    t: Date.now(),
    from: from,
    // 添付はスレッド全体から（最新の返信には添付が無く、前のメールに付いていることが多い）
    atts: listThreadAttachments_(msg),
    saved: saved,
    cands: { person: g.person, company: g.company, oshiin: g.oshiin },
    oshiin: /押印/.test(threadText_(msg))
  };
  saveCtx_(e, ctx);
  return ctx;
}

// ---------- カード ----------
function buildCard_(e, st, ctx) {
  ctx = ctx || getCtx_(e, false);
  var atts = ctx.atts || [];
  var savedMap = ctx.saved || {};
  var from = ctx.from || '';
  var cands = st.q ? searchTargets_(st.mode, st.q) : ((ctx.cands || {})[st.mode] || []);
  var multi = st.mode === 'oshiin';

  var card = CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('アンシスに保存').setSubtitle(from || ''));

  // 種類の切り替え
  var sw = CardService.newCardSection();
  sw.addWidget(CardService.newButtonSet()
    .addButton(modeBtn_('👤 申請人', 'person', st))
    .addButton(modeBtn_('🏢 会社', 'company', st))
    .addButton(modeBtn_('🖊 押印書類', 'oshiin', st)));
  if (multi) {
    sw.addWidget(CardService.newTextParagraph().setText(
      '<font color="#64748b">各人の「02 サイン・押印／4. 企業押印済」に入れます。複数人分が1つのPDFなら、全員にチェックしてください。</font>'));
  }
  var ageMin = ctx.t ? Math.floor((Date.now() - ctx.t) / 60000) : 0;
  sw.addWidget(CardService.newTextButton().setText('↻ 最新にする' + (ageMin >= 1 ? '（' + ageMin + '分前の候補）' : ''))
    .setOnClickAction(CardService.newAction().setFunctionName('onRefresh').setParameters({ mode: st.mode })));
  card.addSection(sw);

  // 候補
  var head = st.q ? '検索結果：' + st.q : (multi ? '候補（押印返送待ちの申請人）' : '候補（送り主・本文から）');
  var sec = CardService.newCardSection().setHeader(head);
  if (cands.length) {
    var sel = CardService.newSelectionInput()
      .setType(multi ? CardService.SelectionInputType.CHECK_BOX : CardService.SelectionInputType.RADIO_BUTTON)
      .setFieldName('target')
      .setTitle(st.mode === 'company' ? '保存する会社' : (multi ? '押印書類を入れる申請人（複数可）' : '保存する申請人'));
    cands.forEach(function (c, i) {
      var label = c.label + (c.sub ? '（' + c.sub + '）' : '') + (c.url ? '' : ' ⚠️フォルダ未登録');
      sel.addItem(label, c.kind + '|' + c.id, multi ? (st.q ? i === 0 : !!c.hit) : i === 0);
    });
    sec.addWidget(sel);
  } else {
    sec.addWidget(CardService.newTextParagraph().setText('候補が見つかりません。下で名前・会社名を検索してください。'));
  }
  // 打つと下に候補が出る（setSuggestionsAction）。選ぶか入力を終えると、その場で探し直す（setOnChangeAction）
  sec.addWidget(CardService.newTextInput().setFieldName('q').setTitle('名前・会社名で探す（2文字以上）').setValue(st.q || '')
    .setSuggestionsAction(CardService.newAction().setFunctionName('onSuggest').setParameters({ mode: st.mode }))
    .setOnChangeAction(CardService.newAction().setFunctionName('onSearch').setParameters({ mode: st.mode })));
  sec.addWidget(CardService.newTextButton().setText('🔍 探す')
    .setOnClickAction(CardService.newAction().setFunctionName('onSearch').setParameters({ mode: st.mode })));
  card.addSection(sec);

  // 添付
  var as = CardService.newCardSection().setHeader('保存する添付');
  if (!atts.length) {
    as.addWidget(CardService.newTextParagraph().setText('このメールには添付がありません。'));
  } else {
    var chk = CardService.newSelectionInput().setType(CardService.SelectionInputType.CHECK_BOX).setFieldName('atts');
    var anySaved = false;
    atts.forEach(function (a) {
      var sv = savedMap[a.key];
      if (sv) anySaved = true;
      chk.addItem(a.name + '（' + sizeLabel_(a.size) + '・' + a.date + (a.own ? '・大房から送信' : '') + '）' + (sv ? ' ✅保存済み：' + sv.join('・') : ''), a.key, !a.small && !sv && !a.own);
    });
    as.addWidget(chk);
    if (anySaved) {
      as.addWidget(CardService.newTextParagraph().setText(
        '<font color="#16a34a">✅ が付いた添付は、このアドオンで保存済みです（チェックを入れれば別の保存先にも入れられます）。</font>'));
    }
    var opt = CardService.newSelectionInput().setType(CardService.SelectionInputType.CHECK_BOX).setFieldName('opt')
      .addItem(st.mode === 'company' ? 'ファイル名の頭に会社名を付ける' : 'ファイル名の頭に申請人名を付ける（名前が入っていないときだけ）', 'name', true);
    if (atts.some(function (a) { return a.zip; })) opt.addItem('zip は展開して、中のファイルを保存する', 'unzip', true);
    opt.addItem('ファイル名の頭に受信日を付ける（例：20261110_）', 'date', false);
    as.addWidget(opt);
    as.addWidget(CardService.newTextButton().setText(multi ? '🖊 押印済みに保存' : '📁 フォルダに保存')
      .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
      .setOnClickAction(CardService.newAction().setFunctionName('onSave').setParameters({ mode: st.mode })));
  }
  card.addSection(as);
  return card.build();
}

function modeBtn_(text, mode, st) {
  var b = CardService.newTextButton().setText(text)
    .setOnClickAction(CardService.newAction().setFunctionName('onMode').setParameters({ mode: mode }));
  if (st.mode === mode) b.setTextButtonStyle(CardService.TextButtonStyle.FILLED);
  return b;
}

// ---------- 操作 ----------
function onMode(e) {
  return update_(buildCard_(e, { mode: e.parameters.mode, q: '' }));
}

function onSearch(e) {
  var q = (formVal_(e, 'q') || '').trim();
  return update_(buildCard_(e, { mode: e.parameters.mode, q: q }));
}

// 検索欄の入力中に出す候補（申請人名・会社名）
function onSuggest(e) {
  var q = String(formVal_(e, 'q') || '').trim();
  var list = [];
  if (q.length >= 2) {
    searchTargets_(e.parameters.mode, q).slice(0, 8).forEach(function (c) {
      var t = c.kind === 'case' ? c.label : c.label;
      if (list.indexOf(t) < 0) list.push(t);
    });
  }
  return CardService.newSuggestionsResponseBuilder().setSuggestions(CardService.newSuggestions().addSuggestions(list)).build();
}

// 保存結果の画面から戻る（保存済みの印が付いた状態で開き直す）
function onBack(e) {
  return CardService.newActionResponseBuilder()
    .setNavigation(CardService.newNavigation().popToRoot().updateCard(buildCard_(e, { mode: e.parameters.mode, q: '' }))).build();
}

function onSave(e) {
  var t0 = Date.now();
  var mode = e.parameters.mode;
  // 「続きを保存」ボタンから来たときは、前回の選択をそのまま使う
  var rs = null;
  try { rs = e.parameters.resume ? JSON.parse(e.parameters.resume) : null; } catch (err) {}
  var targets = rs ? rs.targets : formVals_(e, 'target');
  var picked = rs ? rs.picked : formVals_(e, 'atts');
  var opts = rs ? rs.opts : formVals_(e, 'opt');
  var useName = opts.indexOf('name') >= 0, useDate = opts.indexOf('date') >= 0, unzip = opts.indexOf('unzip') >= 0;
  if (!targets.length) return toast_('保存先を選んでください');
  if (!picked.length) return toast_('保存する添付にチェックを入れてください');

  getMessage_(e); // スレッド内のメールを読めるようにアクセストークンを設定
  var me = Session.getActiveUser().getEmail();
  var cache = {};
  function attOf(key) { // key = "メッセージID:添付番号"
    var mid = key.split(':')[0], i = Number(key.split(':')[1]);
    if (!cache[mid]) { var m = GmailApp.getMessageById(mid); cache[mid] = { m: m, atts: m.getAttachments({ includeInlineImages: true, includeAttachments: true }) }; }
    return { m: cache[mid].m, a: cache[mid].atts[i], mid: mid, i: i };
  }

  // 1) 保存先フォルダを決める（案件・会社はまとめて1回で問い合わせ。押印書類で同じ案件の人は、押印済みフォルダが同じなのでまとめる）
  var okNames = [], errs = [], saved = 0, skipped = 0, pending = 0, groups = [], gmap = {};
  var tlist = getTargets_(targets);
  targets.forEach(function (target, ti) {
    var t = tlist[ti];
    if (!t) { errs.push('（不明な保存先）'); return; }
    if (!t.url) { errs.push(t.label + '：フォルダ未登録'); return; }
    var fid = folderIdFromUrl_(t.url), f = null;
    if (!fid) { errs.push(t.label + '：フォルダを開けません'); return; }
    if (mode === 'oshiin') {
      f = findOshiinFolder_(fid);
      if (!f) { errs.push(t.label + '：「4. 企業押印済」が見つかりません'); return; }
    }
    var gid = f ? f.id : fid;
    var g = gmap[gid];
    if (!g) { g = gmap[gid] = { id: gid, url: f ? f.url : '', name: f ? f.name : '', known: !!f, names: [], targets: [], files: [] }; groups.push(g); }
    g.names.push(t.label); g.targets.push(t);
  });

  // 2) 保存するファイルを用意（zip はここで1回だけ展開する）
  var items = [];
  picked.forEach(function (key) {
    var x = attOf(key);
    if (!x.a) return;
    var blobs = (unzip && isZip_(x.a)) ? unzipBlobs_(x.a) : [x.a.copyBlob().setName(x.a.getName())];
    var date = useDate ? Utilities.formatDate(x.m.getDate(), 'Asia/Tokyo', 'yyyyMMdd') : '';
    var desc = 'Gmailから保存：' + x.m.getFrom() + ' / ' + x.m.getSubject() + ' / '
      + Utilities.formatDate(x.m.getDate(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm') + ' / 保存者 ' + me;
    blobs.forEach(function (b) {
      fixMime_(b);
      items.push({ x: x, blob: b, base: b.getName(), size: b.getBytes().length, date: date, desc: desc });
    });
  });

  // 3) フォルダの確認と「同じファイルがあるか」を、全部のフォルダの分まとめて同時に問い合わせる
  var token = ScriptApp.getOAuthToken();
  var icon = mode === 'oshiin' ? '🖊' : mode === 'company' ? '🏢' : '👤';
  var reqs = [], slots = [];
  groups.forEach(function (g) {
    var prefix = (useName && g.names.length === 1) ? g.names[0] : '';
    g.fileNames = items.map(function (it) { return tidyName_(it.base, prefix, it.date); });
    g.have = {}; g.haveOk = true;
    if (!g.known) { reqs.push(driveGetReq_(g.id, 'id,name,mimeType,webViewLink', token)); slots.push({ g: g, kind: 'info' }); }
    var list = uniq_(g.fileNames);
    for (var i = 0; i < list.length; i += 20) {
      reqs.push(driveListReq_("'" + g.id + "' in parents and trashed = false and (" + list.slice(i, i + 20).map(nameCond_).join(' or ') + ')', 'nextPageToken,files(name,size)', token));
      slots.push({ g: g, kind: 'have' });
    }
  });
  var resps = [];
  try { resps = reqs.length ? UrlFetchApp.fetchAll(reqs) : []; } catch (err) { console.error('fetchAll check', err); }
  slots.forEach(function (sl, i) {
    var r = resps[i], g = sl.g, j = null;
    try { if (r && r.getResponseCode() < 300) j = JSON.parse(r.getContentText()); } catch (err) {}
    if (sl.kind === 'info') {
      if (j && j.mimeType === FOLDER_MIME) { g.known = true; g.name = j.name; g.url = j.webViewLink || ('https://drive.google.com/drive/folders/' + j.id); }
      else if (!r) { var fi = folderInfo_(g.id); if (fi) { g.known = true; g.name = fi.name; g.url = fi.url; } } // まとめて聞けなかったときは1件ずつ
      return;
    }
    if (!j || j.nextPageToken) { g.haveOk = false; return; }
    (j.files || []).forEach(function (f) { (g.have[f.name] = g.have[f.name] || []).push(Number(f.size)); });
  });
  groups = groups.filter(function (g) {
    if (!g.known) { errs.push(g.names.join('・') + '：フォルダを開けません'); return false; }
    if (!g.haveOk) g.have = existingFiles_(g.id, g.fileNames); // うまく読めなかったときは前のやり方で
    okNames = okNames.concat(g.names);
    return true;
  });

  // 4) 保存するものを並べて、同時にアップロード（5MBまで）。大きいファイル・失敗したものは1件ずつ
  var jobs = [];
  groups.forEach(function (g) {
    var label = cutBytes_(icon + g.names.join('・'), 100);
    items.forEach(function (it, k) {
      var name = g.fileNames[k];
      if ((g.have[name] || []).indexOf(it.size) >= 0) { skipped++; return; }
      (g.have[name] = g.have[name] || []).push(it.size); // zip の中に同じ名前があっても二重にしない
      jobs.push({ g: g, it: it, name: name, props: { ansysMsg: it.x.mid, ansysAtt: String(it.x.i), ansysTo: label } });
    });
  });
  var newMarks = []; // 保存済みの印（覚えている一覧にも足す）
  function done(jb, id) {
    if (!id) { errs.push(jb.name + '：保存できませんでした'); return; }
    jb.g.files.push(jb.name);
    newMarks.push({ k: jb.it.x.mid + ':' + jb.it.x.i, to: jb.props.ansysTo });
    saved++;
  }
  function late() { return Date.now() - t0 > SAVE_BUDGET_MS; }
  var small = jobs.filter(function (jb) { return jb.it.size <= PARALLEL_MAX_BYTES; });
  var large = jobs.filter(function (jb) { return jb.it.size > PARALLEL_MAX_BYTES; });
  var retry = [];
  for (var c = 0; c < small.length; c += PARALLEL_CHUNK) {
    var chunk = small.slice(c, c + PARALLEL_CHUNK);
    if (late()) { pending += small.length - c; break; }
    var ups = [];
    try { ups = UrlFetchApp.fetchAll(chunk.map(function (jb) { return uploadReq_(jb.g.id, jb.it.blob, jb.name, jb.it.desc, jb.props, token); })); }
    catch (err) { console.error('fetchAll upload', err); }
    chunk.forEach(function (jb, i) {
      var r = ups[i], id = null;
      try { if (r && r.getResponseCode() < 300) id = JSON.parse(r.getContentText()).id; } catch (err) {}
      if (id) done(jb, id);
      else { if (r) console.error('upload', jb.name, r.getResponseCode(), r.getContentText().slice(0, 300)); retry.push(jb); }
    });
  }
  large.concat(retry).forEach(function (jb) {
    if (late()) { pending++; return; }
    done(jb, createFileFast_(jb.g.id, jb.it.blob, jb.name, jb.it.desc, jb.props));
  });

  // 5) アンシスの時系列に記録（保存できた分だけ）
  try { logSaveEvents_(groups, mode, me, attOf(picked[0]).m); } catch (err) { console.error('logSaveEvents_', err); }

  // 6) 覚えている一覧に保存済みの印を足す（「戻る」ですぐ ✅ が出るように）
  if (newMarks.length) {
    var ctx = loadCtx_(e);
    if (ctx) {
      ctx.saved = ctx.saved || {};
      newMarks.forEach(function (n) { var a = ctx.saved[n.k] = ctx.saved[n.k] || []; if (a.indexOf(n.to) < 0) a.push(n.to); });
      saveCtx_(e, ctx);
    }
  }

  var text = okNames.length
    ? '✅ ' + okNames.join('・') + ' に保存しました（' + saved + '件' + (skipped ? '、保存済み' + skipped + '件は省略' : '') + '）'
    : '保存できませんでした';
  if (pending) text += '<br><b>⏸ 時間がかかるため、ここで区切りました。残り' + pending + '件は「続きを保存」を押してください。</b>';
  if (errs.length) text += ' ⚠️ ' + errs.join(' ／ ');
  var savedNames = [];
  groups.forEach(function (g) { g.files.forEach(function (n) { if (savedNames.indexOf(n) < 0) savedNames.push(n); }); });
  if (savedNames.length) text += '<br><font color="#64748b">' + savedNames.slice(0, 8).join('<br>') + (savedNames.length > 8 ? '<br>ほか' + (savedNames.length - 8) + '件' : '') + '</font>';

  // 新しいタブは開かず、結果の画面に「フォルダを開く」ボタンを並べる
  var rsec = CardService.newCardSection();
  rsec.addWidget(CardService.newTextParagraph().setText(text));
  if (pending) {
    rsec.addWidget(CardService.newTextButton().setText('▶ 続きを保存').setTextButtonStyle(CardService.TextButtonStyle.FILLED)
      .setOnClickAction(CardService.newAction().setFunctionName('onSave')
        .setParameters({ mode: mode, resume: JSON.stringify({ targets: targets, picked: picked, opts: opts }) })));
  }
  groups.forEach(function (f) {
    rsec.addWidget(CardService.newTextButton().setText('📁 ' + f.names.join('・') + (mode === 'oshiin' ? '（' + f.name + '）' : '') + ' を開く')
      .setOpenLink(CardService.newOpenLink().setUrl(f.url)));
  });
  rsec.addWidget(CardService.newTextButton().setText('← 戻る').setTextButtonStyle(pending ? CardService.TextButtonStyle.TEXT : CardService.TextButtonStyle.FILLED)
    .setOnClickAction(CardService.newAction().setFunctionName('onBack').setParameters({ mode: mode })));
  var title = !okNames.length ? '保存できませんでした' : pending ? '⏸ 途中まで保存しました' : errs.length ? '⚠️ 一部保存しました' : '✅ 保存しました';
  var rc = CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle(title))
    .addSection(rsec).build();
  var nav = rs ? CardService.newNavigation().updateCard(rc) : CardService.newNavigation().pushCard(rc); // 続きのときは結果の画面を置き換える
  console.log('onSave ' + (Date.now() - t0) + 'ms saved=' + saved + ' skipped=' + skipped + ' pending=' + pending);
  return CardService.newActionResponseBuilder()
    .setNotification(CardService.newNotification().setText(okNames.length ? (pending ? '⏸ ' + saved + '件保存（残り' + pending + '件）' : '✅ ' + saved + '件保存しました') : '保存できませんでした'))
    .setNavigation(nav).build();
}

// ---------- ドライブ（速く書くための道具） ----------
// ドライブの REST API をまとめて同時に呼ぶための問い合わせ（UrlFetchApp.fetchAll 用）
function driveGetReq_(id, fields, token) {
  return { url: DRIVE_API + '/' + encodeURIComponent(id) + '?fields=' + encodeURIComponent(fields) + '&supportsAllDrives=true',
    headers: { Authorization: 'Bearer ' + (token || ScriptApp.getOAuthToken()) }, muteHttpExceptions: true };
}
function driveListReq_(q, fields, token) {
  return { url: DRIVE_API + '?q=' + encodeURIComponent(q) + '&fields=' + encodeURIComponent(fields)
      + '&pageSize=1000&corpora=allDrives&includeItemsFromAllDrives=true&supportsAllDrives=true',
    headers: { Authorization: 'Bearer ' + (token || ScriptApp.getOAuthToken()) }, muteHttpExceptions: true };
}
function nameCond_(n) { return "name = '" + String(n).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"; }
// 1ファイル分のアップロード（名前・説明・保存済みの印も同時に。multipart）
function uploadReq_(folderId, blob, name, desc, props, token) {
  var bd = 'ansys' + Utilities.getUuid().replace(/-/g, '');
  var meta = { name: name, parents: [folderId], description: desc, appProperties: props };
  var mt = blob.getContentType();
  if (mt) meta.mimeType = mt;
  var head = '--' + bd + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta)
    + '\r\n--' + bd + '\r\nContent-Type: ' + (mt || 'application/octet-stream') + '\r\n\r\n';
  var tail = '\r\n--' + bd + '--';
  var bytes = Utilities.newBlob('x').setDataFromString(head, 'UTF-8').getBytes()
    .concat(blob.getBytes(), Utilities.newBlob('x').setDataFromString(tail, 'UTF-8').getBytes());
  return { url: DRIVE_UPLOAD, method: 'post', contentType: 'multipart/related; boundary=' + bd, payload: bytes,
    headers: { Authorization: 'Bearer ' + (token || ScriptApp.getOAuthToken()) }, muteHttpExceptions: true };
}
// 保存済みの印の確認（スレッドのメールから保存したファイル）を、ほかの問い合わせと同時に送る用
function savedReq_(msgIds) {
  if (!msgIds || !msgIds.length) return null;
  var cond = msgIds.slice(-20).map(function (id) { return "appProperties has { key='ansysMsg' and value='" + id + "' }"; }).join(' or ');
  return driveListReq_('(' + cond + ') and trashed = false', 'nextPageToken,files(id,appProperties)');
}
// その答えを { "メッセージID:添付番号": [保存先, …] } に。読めなかったとき・続きがあるときは null（前のやり方で読み直す）
function parseSaved_(r) {
  if (!r) return null;
  try {
    if (r.getResponseCode() >= 300) { console.error('parseSaved_', r.getResponseCode(), r.getContentText().slice(0, 300)); return null; }
    var j = JSON.parse(r.getContentText());
    if (j.nextPageToken) return null;
    var map = {};
    (j.files || []).forEach(function (f) {
      var ap = f.appProperties || {};
      if (ap.ansysAtt == null) return;
      var k = ap.ansysMsg + ':' + ap.ansysAtt;
      (map[k] = map[k] || []);
      if (map[k].indexOf(ap.ansysTo) < 0) map[k].push(ap.ansysTo || '');
    });
    return map;
  } catch (err) { console.error('parseSaved_', err); return null; }
}
// フォルダの名前・URL（1回の問い合わせ）
function folderInfo_(id) {
  try {
    var f = Drive.Files.get(id, { fields: 'id,name,mimeType,webViewLink', supportsAllDrives: true });
    if (f.mimeType !== FOLDER_MIME) return null;
    return { id: f.id, name: f.name, url: f.webViewLink || ('https://drive.google.com/drive/folders/' + f.id) };
  } catch (err) { console.error('folderInfo_', id, err); return null; }
}
// フォルダの中に同じ名前のファイルがあるか、まとめて1回で調べる → { 名前: [サイズ, …] }
function existingFiles_(folderId, names) {
  var map = {};
  var list = uniq_(names);
  try {
    for (var i = 0; i < list.length; i += 20) {
      var cond = list.slice(i, i + 20).map(function (n) { return "name = '" + String(n).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"; }).join(' or ');
      var token = null;
      do {
        var r = Drive.Files.list({ q: "'" + folderId + "' in parents and trashed = false and (" + cond + ')',
          fields: 'nextPageToken, files(name,size)', pageSize: 1000, pageToken: token,
          corpora: 'allDrives', includeItemsFromAllDrives: true, supportsAllDrives: true });
        (r.files || []).forEach(function (f) { (map[f.name] = map[f.name] || []).push(Number(f.size)); });
        token = r.nextPageToken;
      } while (token);
    }
  } catch (err) {
    // うまく調べられないときは、1件ずつ確かめる（前のやり方）
    console.error('existingFiles_', err);
    try {
      var folder = DriveApp.getFolderById(folderId);
      list.forEach(function (n) { var it = folder.getFilesByName(n); while (it.hasNext()) (map[n] = map[n] || []).push(it.next().getSize()); });
    } catch (e2) {}
  }
  return map;
}
// 1ファイル1回で保存（名前・説明・保存済みの印を同時に）。うまくいかないときは前のやり方で保存する
function createFileFast_(folderId, blob, name, desc, props) {
  try {
    var res = { name: name, parents: [folderId], description: desc, appProperties: props };
    var mt = blob.getContentType();
    if (mt) res.mimeType = mt;
    var f = Drive.Files.create(res, blob, { supportsAllDrives: true, fields: 'id' });
    return f.id;
  } catch (err) {
    console.error('Drive.Files.create', name, err);
    try {
      var file = DriveApp.getFolderById(folderId).createFile(blob.copyBlob().setName(name)).setDescription(desc);
      markSaved_(file.getId(), props.ansysMsg, props.ansysAtt, props.ansysTo);
      return file.getId();
    } catch (e2) { console.error('createFile', name, e2); return null; }
  }
}
// zip から出したファイルは種類が空のことがあるので、拡張子から決める（ドライブでプレビューできるように）
function fixMime_(b) {
  var t = b.getContentType() || '';
  if (t && t !== 'application/octet-stream') return b;
  var ext = (String(b.getName() || '').match(/\.([A-Za-z0-9]+)$/) || ['', ''])[1].toLowerCase();
  var M = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', heic: 'image/heic', heif: 'image/heif',
    webp: 'image/webp', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', txt: 'text/plain', csv: 'text/csv',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', zip: 'application/zip' };
  if (M[ext]) b.setContentType(M[ext]);
  return b;
}

// ---------- ファイル名・zip ----------
function isZip_(a) {
  return /zip/i.test(a.getContentType() || '') || /\.zip$/i.test(a.getName() || '');
}
// zip の中身を取り出す（フォルダ・Mac の管理ファイルは除く）。展開できなければ zip のまま
function unzipBlobs_(a) {
  var base = String(a.getName() || 'zip').replace(/\.zip$/i, '');
  try {
    var out = [];
    Utilities.unzip(a.copyBlob().setContentType('application/zip')).forEach(function (b, i) {
      var n = String(b.getName() || '');
      if (!n || /\/$/.test(n) || /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db)/i.test(n)) return;
      n = n.split('/').pop();
      // Windows で作った zip の日本語名は文字化けすることがあるので、そのときは「zip名_番号」にする
      if (/�/.test(n) || !/\.[A-Za-z0-9]{2,5}$/.test(n)) {
        var ext = (n.match(/\.[A-Za-z0-9]{2,5}$/) || [''])[0];
        n = base + '_' + ('0' + (out.length + 1)).slice(-2) + ext;
      }
      out.push(b.setName(n));
    });
    return out.length ? out : [a.copyBlob().setName(a.getName())];
  } catch (err) {
    console.error('unzip', err);
    return [a.copyBlob().setName(a.getName())];
  }
}
// ファイル名をそろえる：使えない記号を _ に、頭に申請人名（会社名）・受信日。すでに名前が入っていれば付けない
function tidyName_(orig, prefix, date) {
  var n = String(orig || 'file').replace(/[\\\/:*?"<>|\r\n\t]/g, '_').trim();
  if (prefix) {
    var p = String(prefix).replace(/[\\\/:*?"<>|]/g, '_').trim();
    if (normText_(n).indexOf(normText_(p)) < 0) n = p + '_' + n;
  }
  if (date && n.indexOf(date) !== 0) n = date + '_' + n;
  return n;
}

// ---------- アンシスに記録 ----------
// case_events に「メールから保存」を残す（案件の 🗓 時系列に出る）。会社に保存したときは co_id で残す
function logSaveEvents_(groups, mode, me, msg) {
  var who = staffNameByEmail_(me);
  var rows = [];
  groups.forEach(function (g) {
    if (!g.files.length) return;
    var label = (mode === 'oshiin' ? '押印書類をメールから保存' : 'メールから保存') + '：' + g.files.slice(0, 3).join('、') + (g.files.length > 3 ? ' ほか' + (g.files.length - 3) + '件' : '');
    var meta = { files: g.files, folder: g.url, from: msg ? msg.getFrom() : '', subject: msg ? msg.getSubject() : '', by: me };
    g.targets.forEach(function (t) {
      rows.push({ case_id: t.kind === 'case' ? t.id : null, co_id: t.kind === 'company' ? t.id : null,
        kind: mode === 'oshiin' ? 'mail_oshiin' : 'mail_save', label: label, channel: 'mail', by_user: who, meta: meta });
    });
  });
  if (rows.length) sbInsert_('case_events', rows);
}
// メールアドレスからアンシスのユーザー名（見つからなければアドレスのまま）
function staffNameByEmail_(email) {
  var c = CacheService.getScriptCache(), ck = 'staffBy21:' + email;
  try { var v = c.get(ck); if (v) return v; } catch (e) {}
  var name = email;
  try { var r = sb_('users', 'select=name&email=eq.' + enc_(email) + '&limit=1'); if (r.length && r[0].name) name = r[0].name; } catch (e) {}
  try { c.put(ck, name, 21600); } catch (e) {}
  return name;
}
function sbInsert_(table, rows) {
  var p = PropertiesService.getScriptProperties();
  var base = (p.getProperty('SUPABASE_URL') || 'https://ehwlgbwpycglmopiqyty.supabase.co').replace(/\/$/, '');
  var key = String(p.getProperty('SUPABASE_KEY') || '').replace(/\s+/g, '');
  var headers = /^sb_/.test(key) ? { apikey: key } : { apikey: key, Authorization: 'Bearer ' + key };
  headers.Prefer = 'return=minimal';
  var res = UrlFetchApp.fetch(base + '/rest/v1/' + table, { method: 'post', contentType: 'application/json', headers: headers, payload: JSON.stringify(rows), muteHttpExceptions: true });
  if (res.getResponseCode() >= 300) console.error('insert', table, res.getContentText());
}

// ---------- 保存済みの印 ----------
// ファイルに appProperties で印を付ける（キー＋値で124バイトまでなので、保存先名は短く切る）
function markSaved_(fileId, msgId, idx, label) {
  try {
    Drive.Files.update({ appProperties: { ansysMsg: msgId, ansysAtt: String(idx), ansysTo: cutBytes_(label, 100) } },
      fileId, null, { supportsAllDrives: true });
  } catch (err) { console.error('markSaved_', err); }
}
// スレッドのメールから保存したファイルを探して { "メッセージID:添付番号": [保存先, …] } にする
function savedMap_(msgIds) {
  var map = {};
  if (!msgIds || !msgIds.length) return map;
  try {
    var pageToken = null;
    var cond = msgIds.slice(-20).map(function (id) { return "appProperties has { key='ansysMsg' and value='" + id + "' }"; }).join(' or ');
    do {
      var r = Drive.Files.list({
        q: '(' + cond + ') and trashed = false',
        fields: 'nextPageToken, files(id, appProperties)',
        corpora: 'allDrives', includeItemsFromAllDrives: true, supportsAllDrives: true,
        pageSize: 100, pageToken: pageToken
      });
      (r.files || []).forEach(function (f) {
        var ap = f.appProperties || {};
        if (ap.ansysAtt == null) return;
        var k = ap.ansysMsg + ':' + ap.ansysAtt;
        (map[k] = map[k] || []);
        if (map[k].indexOf(ap.ansysTo) < 0) map[k].push(ap.ansysTo || '');
      });
      pageToken = r.nextPageToken;
    } while (pageToken);
  } catch (err) { console.error('savedMap_', err); }
  return map;
}
function cutBytes_(s, max) {
  s = String(s || '');
  while (Utilities.newBlob(s).getBytes().length > max) s = s.slice(0, -1);
  return s;
}

// ---------- 押印済みフォルダを探す ----------
// アンシスの「スキャン書類作成」と同じ照合：番号・句読点・空白・全半角の揺れを無視して「企業押印済」と一致するフォルダ。
// 候補が複数なら、親が「サイン・押印」「在留資格申請書類」のものを優先。3階層下まで。
// 1階層ずつまとめて問い合わせる（フォルダを1つずつ開かない）。見つけた場所は6時間覚える。
// 戻り値：{ id, name, url } または null
function findOshiinFolder_(personFolderId) {
  var ck = 'osh21:' + personFolderId, sc = CacheService.getScriptCache();
  try { var hit = sc.get(ck); if (hit) return JSON.parse(hit); } catch (err) {}
  var opt = { supportsAllDrives: true };
  // 探す場所：①人材フォルダの中（古い構成）→ ②案件フォルダ（★人材資料 の親）の下
  var roots = [personFolderId];
  try {
    var me = Drive.Files.get(personFolderId, { fields: 'parents', supportsAllDrives: true });
    (me.parents || []).forEach(function (pid) {
      var p1 = Drive.Files.get(pid, { fields: 'id,name,parents', supportsAllDrives: true });
      if (/人材資料/.test(p1.name || '')) (p1.parents || []).forEach(function (gp) { roots.push(gp); });
      else roots.push(pid);
    });
  } catch (err) { console.error('findOshiinFolder_ parents', err); }
  for (var r = 0; r < roots.length; r++) {
    var hits = [], level = [{ id: roots[r], path: '' }];
    for (var depth = 1; depth <= 3 && level.length; depth++) {
      var next = [];
      for (var c = 0; c < level.length; c += 20) {
        var chunk = level.slice(c, c + 20), pathOf = {};
        chunk.forEach(function (x) { pathOf[x.id] = x.path; });
        var q = '(' + chunk.map(function (x) { return "'" + x.id + "' in parents"; }).join(' or ') + ") and mimeType = '" + FOLDER_MIME + "' and trashed = false";
        var token = null;
        do {
          var res = Drive.Files.list({ q: q, fields: 'nextPageToken, files(id,name,parents,webViewLink)', pageSize: 1000, pageToken: token,
            corpora: 'allDrives', includeItemsFromAllDrives: true, supportsAllDrives: true });
          (res.files || []).forEach(function (f) {
            if (/人材資料/.test(f.name || '') && r > 0) return; // 案件フォルダから探すときは、ほかの人の人材フォルダには潜らない
            var par = (f.parents || []).filter(function (x) { return pathOf[x] != null; })[0];
            var path = (par != null ? pathOf[par] : '') + '/' + f.name;
            if (normFolder_(f.name) === '企業押印済') hits.push({ id: f.id, name: f.name, url: f.webViewLink, path: path });
            next.push({ id: f.id, path: path });
          });
          token = res.nextPageToken;
        } while (token);
      }
      level = next;
    }
    if (hits.length) {
      var pref = hits.filter(function (h) { return /サイン|押印|在留資格申請書類/.test(h.path.replace(/\/[^\/]*$/, '')); });
      var h = (pref.length ? pref : hits)[0];
      var out = { id: h.id, name: h.name, url: h.url || ('https://drive.google.com/drive/folders/' + h.id) };
      try { sc.put(ck, JSON.stringify(out), 21600); } catch (err) {}
      return out;
    }
  }
  return null;
}
function normFolder_(s) {
  var x = String(s || '');
  try { x = x.normalize('NFKC'); } catch (e) {}
  return x.trim().replace(/^[0-9]+[.、,]?\s*/, '').replace(/\s+/g, '');
}

// ---------- 候補の推測 ----------
// 点数をつけて並べる。強い手がかり（紐づけ済みスレッド・登録済みアドレス・件名の氏名）があるときは、
// 弱い手がかり（本文に出てきた名前だけ）の候補は出さない。
var FREE_MAIL = /@([\w-]+\.)*(gmail\.com|googlemail\.com|yahoo\.co\.jp|yahoo\.com|ymail\.ne\.jp|outlook\.(jp|com)|hotmail\.(com|co\.jp)|live\.(jp|com)|icloud\.com|me\.com|mac\.com|docomo\.ne\.jp|ezweb\.ne\.jp|au\.com|softbank\.ne\.jp|i\.softbank\.jp|nifty\.com|biglobe\.ne\.jp|ocn\.ne\.jp|so-net\.ne\.jp|plala\.or\.jp)$/i;
var CO_COLS = 'select=id,name,pref,drive_url';
var DONE_RE = /完了|取り?下げ|不許可|中止|キャンセル/;

// 申請人・会社・押印書類の3種類の候補をまとめて出す（種類を切り替えても探し直さないように）
// 戻り値：{ person: [...], company: [...], oshiin: [...], extra: { key: HTTPResponse } }
// extra：1回目の問い合わせと同時に送りたいほかの問い合わせ（保存済みの印の確認など）
function guessAll_(from, msg, extra) {
  var thread = msg.getThread().getId();
  var subject = msg.getSubject();
  var subjHints = nameHints_(subject);
  var bodyHints = nameHints_(externalBody_(msg));
  var staff = staffNames_();
  function notStaff(n) { return !isStaffName_(n, staff); }
  subjHints.people = subjHints.people.filter(notStaff);
  bodyHints.people = bodyHints.people.filter(notStaff).filter(function (n) { return subjHints.people.indexOf(n) < 0; });
  bodyHints.companies = bodyHints.companies.filter(function (c) { return subjHints.companies.indexOf(c) < 0; });

  // 宛先（From / To / Cc）の社外アドレス
  var addrs = threadAddrs_(msg);
  var domains = uniq_(addrs.filter(function (a) { return !FREE_MAIL.test(a); }).map(function (a) { return a.split('@')[1]; })).slice(0, 3);

  // ---- 1回目：会社の手がかりと、氏名の手がかりをまとめて問い合わせる ----
  var q = [];
  function ask(key, table, query) { q.push({ key: key, table: table, query: query }); }
  ask('thread', 'cases', 'select=' + CASE_COLS + '&mail_thread_id=eq.' + enc_(thread) + '&limit=20');
  addrs.slice(0, 6).forEach(function (a, i) {
    ask('coAddr', 'companies', CO_COLS + '&' + coMailFilter_(a) + '&limit=3');
    ask('caseAddr:' + i, 'cases', 'select=' + CASE_COLS + '&or=(mail_to.ilike.*' + enc_(a) + '*,mail_cc.ilike.*' + enc_(a) + '*)&order=updated_at.desc&limit=30');
  });
  domains.forEach(function (d, j) {
    ask('coDom', 'companies', CO_COLS + '&or=(contact_email.ilike.*%40' + enc_(d) + '*,extra->>emails.ilike.*%40' + enc_(d) + '*)&limit=3');
    ask('caseDom:' + j, 'cases', 'select=company_id&or=(mail_to.ilike.*%40' + enc_(d) + '*,mail_cc.ilike.*%40' + enc_(d) + '*)&company_id=not.is.null&limit=50');
    var lbl = domainLabel_(d);
    if (lbl) ask('coLabel', 'companies', CO_COLS + '&' + likeBoth_('name', lbl) + '&limit=3');
  });
  subjHints.companies.forEach(function (c) { ask('coSubj', 'companies', CO_COLS + '&' + likeBoth_('name', c) + '&limit=3'); });
  bodyHints.companies.forEach(function (c) { ask('coBody', 'companies', CO_COLS + '&' + likeBoth_('name', c) + '&limit=3'); });
  if (true) {
    subjHints.people.forEach(function (n) { ask('nameSubj', 'cases', 'select=' + CASE_COLS + '&' + likeBoth_('applicant', n) + '&order=updated_at.desc&limit=5'); });
    bodyHints.people.forEach(function (n) { ask(/[A-Za-z]/.test(n) ? 'nameBodyR' : 'nameBodyK', 'cases', 'select=' + CASE_COLS + '&' + likeBoth_('applicant', n) + '&order=updated_at.desc&limit=5'); });
  }
  var stIn = 'status=in.(' + OSHIIN_STATUSES.map(quote_).join(',') + ')';
  ask('waiting', 'cases', 'select=' + CASE_COLS + '&' + stIn + '&order=status_changed_at.desc.nullslast&limit=300'); // 押印返送待ちの一覧
  var r1 = sbAll_(q, extra);

  // 会社の点数
  var cos = {};
  function coAdd(rows, pts) { (rows || []).forEach(function (r) { if (!r || !r.id) return; var s = cos[r.id] || (cos[r.id] = { row: r, score: 0 }); s.score += pts; }); }
  coAdd(r1.coAddr, 60); coAdd(r1.coDom, 50); coAdd(r1.coLabel, 30); coAdd(r1.coSubj, 30); coAdd(r1.coBody, 10);
  var linkedCoIds = uniq_((r1.thread || []).map(function (c) { return c.company_id; }).filter(Boolean));
  // 登録支援機関・紹介会社などのアドレスは、たくさんの会社の案件に入っている。
  // 1つのアドレス／ドメインが3社以上の案件に出てくるときは、会社の手がかりにしない
  function keysOf(prefix) { return Object.keys(r1).filter(function (k) { return k.indexOf(prefix + ':') === 0; }); }
  function coIdsOf(rows) { return uniq_((rows || []).map(function (c) { return c.company_id; }).filter(Boolean)); }
  var caseAddrRows = [], addrCoIds = [], domCoIds = [];
  keysOf('caseAddr').forEach(function (k) {
    var ids = coIdsOf(r1[k]);
    if (ids.length && ids.length <= 2) { caseAddrRows = caseAddrRows.concat(r1[k]); addrCoIds = addrCoIds.concat(ids); }
  });
  keysOf('caseDom').forEach(function (k) {
    var ids = coIdsOf(r1[k]);
    if (ids.length && ids.length <= 2) domCoIds = domCoIds.concat(ids);
  });
  domCoIds = uniq_(domCoIds); addrCoIds = uniq_(addrCoIds);
  // 件名の氏名・本文のローマ字フルネームで当たった申請人と、その会社（いちばんはっきりした手がかり）
  var nameRows = (r1.nameSubj || []).concat(r1.nameBodyR || []);
  var nameCoIds = coIdsOf(nameRows);
  // ---- 有力な会社を先に ID だけで決める（会社の行を取りに行くのと、その会社の案件を探すのを同時にできるように）----
  var needIds = uniq_(linkedCoIds.concat(domCoIds, addrCoIds, nameCoIds)).filter(function (id) { return !cos[id]; }).slice(0, 10);
  var sc = {}, order = [];
  function bump(id, p) { if (!(id in sc)) { sc[id] = 0; order.push(id); } sc[id] += p; }
  Object.keys(cos).forEach(function (id) { bump(id, cos[id].score); });
  needIds.forEach(function (id) { bump(id, 0); });
  function pts(ids, p) { ids.forEach(function (id) { if (id in sc) sc[id] += p; }); }
  pts(linkedCoIds, 80); pts(domCoIds, 50); pts(addrCoIds, 40); pts(nameCoIds, 60);
  var byScore = order.slice().sort(function (a, b) { return sc[b] - sc[a]; });
  // 名前から会社が分かったときは、その会社だけを「有力」とする（紹介会社のアドレスに引っぱられないように）
  var strongCoIds = nameCoIds.length ? nameCoIds.slice(0, 3) : byScore.filter(function (id) { return sc[id] >= 30; }).slice(0, 3);

  // ---- 2回目（同時に）：会社の行（ID だけ分かっているもの）＋ 有力な会社の案件（申請人用・押印用）----
  var q2 = [];
  if (needIds.length) q2.push({ key: 'coIds', table: 'companies', query: CO_COLS + '&id=in.(' + needIds.map(quote_).join(',') + ')' });
  if (strongCoIds.length) {
    var coIn = 'company_id=in.(' + strongCoIds.map(quote_).join(',') + ')';
    q2.push({ key: 'coCases', table: 'cases', query: 'select=' + CASE_COLS + '&' + coIn + '&order=updated_at.desc&limit=20' });
    q2.push({ key: 'coCasesO', table: 'cases', query: 'select=' + CASE_COLS + '&' + coIn + '&' + stIn + '&order=updated_at.desc&limit=20' });
  }
  var r2 = q2.length ? sbAll_(q2) : {};
  (r2.coIds || []).forEach(function (r) { cos[r.id] = cos[r.id] || { row: r, score: 0 }; });
  linkedCoIds.forEach(function (id) { if (cos[id]) cos[id].score += 80; });
  domCoIds.forEach(function (id) { if (cos[id]) cos[id].score += 50; });
  addrCoIds.forEach(function (id) { if (cos[id]) cos[id].score += 40; });
  nameCoIds.forEach(function (id) { if (cos[id]) cos[id].score += 60; });

  var coList = Object.keys(cos).map(function (k) { return cos[k]; }).sort(function (a, b) { return b.score - a.score; });
  var out = { extra: r1.__raw || {} };
  out.company = pickStrong_(coList, 50, 20).slice(0, 8).map(function (s) { return mapCos_([s.row])[0]; });
  var r3 = r2; // 有力な会社の案件は2回目に入っている

  // 申請人の点数（会社の案件の入れ方だけ、申請人用と押印用で変える）
  function scored(coRows) {
    var cand = {};
    function add(rows, pts) {
      mapCases_(rows).forEach(function (c) { var s = cand[c.id] || (cand[c.id] = { c: c, score: 0 }); s.score += pts; });
    }
    add(r1.thread, 100);
    add(caseAddrRows, 50);
    add(r1.nameSubj, 60);
    add(r1.nameBodyR, 45);
    add(r1.nameBodyK, 15);
    add(coRows, 25);
    Object.keys(cand).forEach(function (k) {
      var s = cand[k];
      if (s.c.companyId && strongCoIds.indexOf(s.c.companyId) >= 0) s.score += 20; // 名前と会社が両方合う
      if (!DONE_RE.test(s.c.status || '')) s.score += 10;                            // 進行中を上に
    });
    return cand;
  }

  // 👤 申請人
  var cand = scored(r3.coCases);
  var all = Object.keys(cand).map(function (k) { return cand[k]; }).sort(function (a, b) { return b.score - a.score; });
  if (nameRows.length) {
    // 名前で当たった人がいれば、その人たち → 同じ会社の人 の順にだけ出す
    var nameIds = {}; nameRows.forEach(function (c) { nameIds[c.id] = 1; });
    var named = all.filter(function (s) { return nameIds[s.c.id]; });
    var same = all.filter(function (s) { return !nameIds[s.c.id] && s.c.companyId && nameCoIds.indexOf(s.c.companyId) >= 0; });
    out.person = named.concat(same).slice(0, 10).map(function (s) { return s.c; });
  } else {
    out.person = pickStrong_(all, 60, 35).slice(0, 10).map(function (s) { return s.c; });
  }

  // 🖊 押印書類：押印返送待ちの人だけに絞る。手がかりがある人は最初からチェック
  var candO = scored(r3.coCasesO);
  var waiting = mapCases_(r1.waiting);
  var hay = normText_(subject + ' ' + externalBody_(msg) + ' ' + listThreadAttachments_(msg).map(function (a) { return a.name; }).join(' '));
  waiting.forEach(function (c) {
    var n = normText_(c.label);
    var s = candO[c.id] || (candO[c.id] = { c: c, score: 0 });
    if (n.length >= 4 && hay.indexOf(n) >= 0) s.score += 60;
    if (c.companyId && strongCoIds.indexOf(c.companyId) >= 0) s.score += 40;
  });
  var waitIds = {}; waiting.forEach(function (c) { waitIds[c.id] = 1; });
  var list = Object.keys(candO).map(function (k) { return candO[k]; })
    .filter(function (s) { return waitIds[s.c.id]; })
    .sort(function (a, b) { return b.score - a.score; });
  var hits = list.filter(function (s) { return s.score >= 40; }).map(function (s) { s.c.hit = true; return s.c; });
  var rest = waiting.filter(function (c) { return !hits.some(function (h) { return h.id === c.id; }); }).slice(0, 15);
  out.oshiin = hits.concat(rest).slice(0, 25);
  return out;
}
// 1種類だけ欲しいとき（前の呼び方）
function guessTargets_(mode, from, msg) { return guessAll_(from, msg)[mode] || []; }

// いちばん強い候補が strong 点以上なら、weak 点未満の候補は出さない
function pickStrong_(list, strong, weak) {
  if (list.length && list[0].score >= strong) return list.filter(function (s) { return s.score >= weak; });
  return list;
}

function searchTargets_(mode, q) {
  var raw = q.replace(/[,()*]/g, ' ').trim();
  var w = enc_(raw), wz = enc_(toZen_(raw)), wh = enc_(toHan_(raw));
  if (!w) return [];
  if (mode === 'company') {
    return mapCos_(sb_('companies', 'select=id,name,pref,drive_url&or=(name.ilike.*' + w + '*,name.ilike.*' + wz + '*,name.ilike.*' + wh + '*,name_kana.ilike.*' + w + '*)&order=updated_at.desc&limit=15'));
  }
  return mapCases_(sb_('cases', 'select=' + CASE_COLS + '&or=(name.ilike.*' + w + '*,applicant.ilike.*' + w + '*,company.ilike.*' + w + '*,company.ilike.*' + wz + '*,company.ilike.*' + wh + '*)&order=updated_at.desc&limit=15'));
}

function getTarget_(kind, id) {
  if (kind === 'case') { var r = mapCases_(sb_('cases', 'select=' + CASE_COLS + '&id=eq.' + enc_(id))); return r[0]; }
  var c = mapCos_(sb_('companies', 'select=id,name,pref,drive_url&id=eq.' + enc_(id))); return c[0];
}
// 選んだ保存先（"case|ID" / "company|ID"）をまとめて1回で問い合わせる。並びは targets と同じ
function getTargets_(targets) {
  var caseIds = [], coIds = [];
  targets.forEach(function (t) {
    var kind = t.split('|')[0], id = t.split('|').slice(1).join('|');
    if (kind === 'case') caseIds.push(id); else coIds.push(id);
  });
  var q = [];
  if (caseIds.length) q.push({ key: 'cases', table: 'cases', query: 'select=' + CASE_COLS + '&id=in.(' + uniq_(caseIds).map(quote_).join(',') + ')' });
  if (coIds.length) q.push({ key: 'cos', table: 'companies', query: 'select=id,name,pref,drive_url&id=in.(' + uniq_(coIds).map(quote_).join(',') + ')' });
  var r = q.length ? sbAll_(q) : {};
  var byId = {};
  mapCases_(r.cases).forEach(function (c) { byId['case|' + c.id] = c; });
  mapCos_(r.cos).forEach(function (c) { byId['company|' + c.id] = c; });
  return targets.map(function (t) { return byId[t] || null; });
}

// ---------- スレッド ----------
function threadMsgs_(msg) {
  var k = 'thr:' + msg.getId();
  if (MEMO_[k]) return MEMO_[k];
  try { MEMO_[k] = msg.getThread().getMessages(); } catch (err) { MEMO_[k] = [msg]; }
  return MEMO_[k];
}
// 件名＋直近5通の本文（候補探し・押印の判定に使う）
function threadText_(msg) {
  return msg.getSubject() + ' ' + threadMsgs_(msg).slice(-5).map(function (m) { return bodyOf_(m).slice(0, 3000); }).join(' ');
}
// メール本文（同じ実行の中では1回だけ読む）
function bodyOf_(m) {
  var k = 'body:' + m.getId();
  if (MEMO_[k] == null) { try { MEMO_[k] = m.getPlainBody() || ''; } catch (err) { MEMO_[k] = ''; } }
  return MEMO_[k];
}
// スレッド内の添付を新しいメール順に。key = "メッセージID:添付番号"
function listThreadAttachments_(msg) {
  var mk = 'att:' + msg.getId();
  if (MEMO_[mk]) return MEMO_[mk];
  var out = MEMO_[mk] = [];
  threadMsgs_(msg).slice().reverse().forEach(function (m) {
    var d = Utilities.formatDate(m.getDate(), 'Asia/Tokyo', 'M/d');
    var own = /@gyosei-cambo\.com/i.test(m.getFrom()); // 大房から送った添付は最初チェックを外す
    m.getAttachments({ includeInlineImages: true, includeAttachments: true }).forEach(function (a, i) {
      var size = a.getSize(), type = a.getContentType() || '';
      out.push({ key: m.getId() + ':' + i, name: a.getName(), size: size, date: d, own: own, zip: isZip_(a),
        small: /^image\//.test(type) && size < SMALL_IMG_BYTES });
    });
  });
  return out;
}
// スレッドで最後に外部（自社以外）から来たメールの送り主
function externalFrom_(msg) {
  var ms = threadMsgs_(msg).slice().reverse();
  for (var i = 0; i < ms.length; i++) {
    var a = extractEmail_(ms[i].getFrom());
    if (a && !/@gyosei-cambo\.com$/i.test(a)) return a;
  }
  return extractEmail_(msg.getFrom());
}
// 件名・本文から、人の名前と会社名らしいものを拾う
function nameHints_(text) {
  var people = [], cos = [];
  text = String(text || '');
  function push(arr, v, max) { v = String(v || '').replace(/[\s　]+/g, ' ').trim(); if (v && arr.indexOf(v) < 0 && arr.length < max) arr.push(v); }
  var NG = /^(ご?担当者?|皆|各位|お客|御中|先生|社長|部長|課長|係長|代表|弊社|貴社|御社|大房|行政書士)$/;
  var m, re;
  re = /([A-Z][A-Za-z'.-]+(?:[ 　]+[A-Z][A-Za-z'.-]+){1,5})[ 　]*(?:様|さん|殿)/g;
  while ((m = re.exec(text))) push(people, m[1], 6);
  re = /\b([A-Z]{2,}(?:[ 　]+[A-Z]{2,}){1,5})\b/g;
  while ((m = re.exec(text))) if (m[1].length >= 8 && !/^(PDF|JPG|PNG|FAX|TEL|URL|LINE|ZIP|CC|BCC|RE|FW)\b/.test(m[1]) && !/(CO|LTD|INC|CORP|HOTEL|MANAGEMENT|GROUP|SYSTEM|JAPAN)\b/.test(m[1])) push(people, m[1], 6);
  re = /([一-龯々ぁ-んァ-ヶー・]{2,12})[ 　]*様/g;
  while ((m = re.exec(text))) if (!NG.test(m[1])) push(people, m[1], 6);
  re = /【([^】]{2,30})】/g;
  while ((m = re.exec(text))) { var c = coreCo_(m[1]); if (c && !/(人材情報|新規依頼|重要|至急|ご案内|お知らせ|大房|依頼|申請|変更|更新|認定)/.test(c)) push(cos, c, 4); }
  re = /(?:株式会社|有限会社|合同会社|\(株\)|（株）|㈱|\(有\)|（有）|㈲)[ 　]*([^\s　、。,，（(【】)）]{2,20})|([^\s　、。,，（(【】)）]{2,20})(?:株式会社|有限会社|合同会社|\(株\)|（株）|㈱|㈲)/g;
  while ((m = re.exec(text))) { var c2 = coreCo_(m[1] || m[2]); if (c2 && !/大房/.test(c2)) push(cos, c2, 4); }
  // 「ホンダ製菓5名」のように、株式会社が付かない会社名＋人数
  re = /([一-龯々ァ-ヶーA-Za-zＡ-Ｚａ-ｚ]{2,15})[ 　]*[0-9０-９]+名/g;
  while ((m = re.exec(text))) { var c3 = coreCo_(m[1]); if (c3 && !/(人|認定|変更|更新|申請|合計|計|全|大房)$/.test(c3) && !/^(ミャンマー|ベトナム|インドネシア|フィリピン|ネパール|カンボジア|スリランカ|バングラデシュ|モンゴル|中国|タイ)/.test(c3)) push(cos, c3, 4); }
  return { people: people, companies: cos };
}
// 社外から来たメールの本文だけ（引用部分・署名より下は除く）
function externalBody_(msg) {
  return threadMsgs_(msg).filter(function (m) { return !/@gyosei-cambo\.com/i.test(m.getFrom()); }).slice(-3).map(function (m) {
    var b = bodyOf_(m);
    var cut = b.search(/\n(>|-{2,}\s*(Original|元のメッセージ)|On .{5,80}wrote:|\d{4}年\d{1,2}月\d{1,2}日.{0,40}(<|＜)[^\n]*@|-{5,}|_{5,}|={5,}|━{3,}|─{3,})/);
    return (cut > 0 ? b.slice(0, cut) : b).slice(0, 2500);
  }).join('\n');
}
// スレッドの From / To / Cc にある社外アドレス（新しいメール順）
function threadAddrs_(msg) {
  var out = [];
  threadMsgs_(msg).slice().reverse().forEach(function (m) {
    ([m.getFrom(), m.getTo(), m.getCc()].join(',').match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi) || []).forEach(function (a) {
      a = a.toLowerCase();
      if (!/@gyosei-cambo\.com$/.test(a) && out.indexOf(a) < 0) out.push(a);
    });
  });
  return out.slice(0, 6);
}
// ドメインから会社名らしい部分を取る（mail.huge.co.jp → huge）
function domainLabel_(d) {
  var parts = String(d || '').toLowerCase().split('.');
  var SUF = /^(jp|com|net|org|biz|info|co|ne|or|ac|ed|go|lg|gr|ad|asia|tokyo|osaka|nagoya|vn|id|mm|kh|ph|cn|kr|tw|th|np|lk|bd|in|us|uk)$/;
  while (parts.length > 1 && SUF.test(parts[parts.length - 1])) parts.pop();
  var l = parts[parts.length - 1] || '';
  if (l.length < 3 || /^(mail|info|office|sales|corp|group|recruit|saiyo|jinji|soumu|honsha|www|smtp|mx|web|net|biz)$/.test(l)) return '';
  return l;
}
// 大房のスタッフ名（候補から外す）。6時間キャッシュ
function staffNames_() {
  var c = CacheService.getScriptCache(), v = c.get('staffNames');
  if (v) return JSON.parse(v);
  var names = [];
  sb_('users', 'select=name').forEach(function (r) {
    var n = String(r.name || '').trim(); if (!n) return;
    names.push(n.replace(/[\s　]+/g, ''));
    n.split(/[\s　]+/).forEach(function (p) { if (p.length >= 2) names.push(p); });
  });
  names = uniq_(names);
  try { c.put('staffNames', JSON.stringify(names), 21600); } catch (e) {}
  return names;
}
function isStaffName_(n, staff) {
  var x = String(n || '').replace(/[\s　]+/g, '').toLowerCase();
  var kanji = /[一-龯々]/.test(x);
  // ローマ字の名前は完全一致だけ（MYAT などの部分一致で申請人を消さない）。漢字の名字はスタッフ名の先頭と一致でも外す
  return staff.some(function (s) { s = s.toLowerCase(); return s === x || (kanji && x.length >= 2 && s.indexOf(x) === 0); });
}
function uniq_(a) { var o = []; (a || []).forEach(function (x) { if (o.indexOf(x) < 0) o.push(x); }); return o; }
function quote_(x) { return '"' + x + '"'; }
// 英数字の全角／半角の両方で探す（DBの会社名が「ＨＵＧＥ」のように全角のことがある）
function toZen_(s) { return String(s || '').replace(/[!-~]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) + 0xFEE0); }); }
function toHan_(s) { return String(s || '').replace(/[！-～]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); }); }
function likeBoth_(col, v) {
  return 'or=(' + col + '.ilike.*' + enc_(toHan_(v)) + '*,' + col + '.ilike.*' + enc_(toZen_(v)) + '*)';
}
// 会社名から「株式会社」などを外した部分（検索用）
function coreCo_(s) {
  return String(s || '').replace(/株式会社|有限会社|合同会社|一般社団法人|協同組合|\(株\)|（株）|㈱|\(有\)|（有）|㈲|様|御中/g, '').replace(/[\s　]+/g, '').trim();
}

// 名前の照合用：全半角・空白・中黒・カッコ書きの揺れを消す
function normText_(s) {
  var x = String(s || '');
  try { x = x.normalize('NFKC'); } catch (e) {}
  return x.replace(/[（(][^）)]*[）)]/g, '').replace(/[\s・･.\-_]/g, '').toLowerCase();
}


function mapCases_(rows) {
  return (rows || []).map(function (r) {
    return { kind: 'case', id: r.id, label: r.applicant || r.name || '(名前なし)', sub: [r.company || r.name, r.status].filter(Boolean).join('／'), url: r.drive_url || '', companyId: r.company_id || '', status: r.status || '' };
  });
}
function mapCos_(rows) {
  return (rows || []).map(function (r) {
    return { kind: 'company', id: r.id, label: r.name || '(名前なし)', sub: r.pref || '', url: r.drive_url || '' };
  });
}

// ---------- Supabase ----------
function sb_(table, query) {
  var p = PropertiesService.getScriptProperties();
  var base = p.getProperty('SUPABASE_URL') || 'https://ehwlgbwpycglmopiqyty.supabase.co', key = String(p.getProperty('SUPABASE_KEY') || '').replace(/\s+/g, ''); // 貼り付け時の空白・改行を除く
  if (!base || !key) throw new Error('スクリプトプロパティ SUPABASE_URL / SUPABASE_KEY が未設定です');
  // UrlFetchApp は ( ) * > " , などが生のままだと「無効な引数」になるので、区切り（& =）と % 以外の記号を変換してから送る
  var safeQuery = safeQuery_(query);
  var res = UrlFetchApp.fetch(base.replace(/\/$/, '') + '/rest/v1/' + table + '?' + safeQuery, {
    // 新しい形式のキー（sb_secret_ / sb_publishable_）は apikey ヘッダーだけで送る。旧形式（JWT）は Authorization も付ける
    headers: /^sb_/.test(key) ? { apikey: key } : { apikey: key, Authorization: 'Bearer ' + key }, muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 300) { console.error(table, query, res.getContentText()); return []; }
  return JSON.parse(res.getContentText() || '[]');
}

// 複数の問い合わせを同時に送る（UrlFetchApp.fetchAll）。結果は key ごとにまとめる
function sbAll_(list, extra) {
  var p = PropertiesService.getScriptProperties();
  var base = (p.getProperty('SUPABASE_URL') || 'https://ehwlgbwpycglmopiqyty.supabase.co').replace(/\/$/, '');
  var key = String(p.getProperty('SUPABASE_KEY') || '').replace(/\s+/g, '');
  if (!key) throw new Error('スクリプトプロパティ SUPABASE_KEY が未設定です');
  var headers = /^sb_/.test(key) ? { apikey: key } : { apikey: key, Authorization: 'Bearer ' + key };
  var reqs = list.map(function (x) {
    return { url: base + '/rest/v1/' + x.table + '?' + safeQuery_(x.query), headers: headers, muteHttpExceptions: true };
  });
  // extra：同時に送るほかの問い合わせ（ドライブなど）。結果は out.__raw[key] に HTTPResponse のまま入れる
  var ex = (extra || []).filter(function (x) { return x && x.req; });
  var all = reqs.concat(ex.map(function (x) { return x.req; }));
  var out = {};
  var res = all.length ? UrlFetchApp.fetchAll(all) : [];
  res.forEach(function (r, i) {
    if (i >= list.length) { (out.__raw = out.__raw || {})[ex[i - list.length].key] = r; return; }
    var k = list[i].key; out[k] = out[k] || [];
    if (r.getResponseCode() >= 300) { console.error(list[i].table, list[i].query, r.getContentText()); return; }
    out[k] = out[k].concat(JSON.parse(r.getContentText() || '[]'));
  });
  return out;
}
// UrlFetchApp は ( ) * > " , などが生のままだと「無効な引数」になるので、区切り（& =）と % 以外の記号を変換する
function safeQuery_(query) {
  return String(query).replace(/[^A-Za-z0-9\-._~%&=]/g, function (c) {
    return c.charCodeAt(0) < 128 ? '%' + ('0' + c.charCodeAt(0).toString(16).toUpperCase()).slice(-2) : encodeURIComponent(c);
  });
}

// ---------- 補助 ----------
function getMessage_(e) {
  GmailApp.setCurrentMessageAccessToken(e.gmail.accessToken);
  return GmailApp.getMessageById(e.gmail.messageId);
}

function listAttachments_(msg) {
  return msg.getAttachments({ includeInlineImages: true, includeAttachments: true }).map(function (a) {
    var size = a.getSize(), type = a.getContentType() || '';
    return { name: a.getName(), size: size, small: /^image\//.test(type) && size < SMALL_IMG_BYTES };
  });
}

function sameFileExists_(folder, name, size) {
  var it = folder.getFilesByName(name);
  while (it.hasNext()) { if (it.next().getSize() === size) return true; }
  return false;
}

function folderIdFromUrl_(url) {
  var m = String(url).match(/\/folders\/([\w-]+)/) || String(url).match(/[?&]id=([\w-]+)/);
  return m ? m[1] : (/^[\w-]{20,}$/.test(url) ? url : null);
}

// 会社のメールは contact_email と extra.emails（配列）の両方にある
function coMailFilter_(addr) {
  return 'or=(contact_email.ilike.*' + enc_(addr) + '*,extra->emails.cs.' + enc_(JSON.stringify([addr])) + ')';
}
function extractEmail_(s) { var m = String(s || '').match(/[\w.+-]+@[\w.-]+/); return m ? m[0].toLowerCase() : ''; }
function enc_(s) { return encodeURIComponent(s); }
function sizeLabel_(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(n / 1024)) + 'KB'; }

function formVals_(e, k) {
  var c = e.commonEventObject && e.commonEventObject.formInputs && e.commonEventObject.formInputs[k];
  if (c && c.stringInputs && c.stringInputs.value) return c.stringInputs.value;
  return (e.formInputs && e.formInputs[k]) || (e.formInput && e.formInput[k] != null ? [e.formInput[k]] : []);
}
function formVal_(e, k) { var v = formVals_(e, k); return v.length ? v[0] : ''; }

function update_(card) {
  return CardService.newActionResponseBuilder().setNavigation(CardService.newNavigation().updateCard(card)).build();
}
function toast_(t) {
  return CardService.newActionResponseBuilder().setNotification(CardService.newNotification().setText(t)).build();
}
