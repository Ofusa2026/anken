# GAS改修指示: 審査完了メールの配送タイプ判別

OFUSA案件管理システム ver.20260425.150 で追加された機能のGAS側対応指示。

## 目的

入管庁から届く「審査完了に関するお知らせ」メールには2パターンあり、
本文から **郵送交付** か **窓口受取** かを自動判別したい。

| パターン | 本文の特徴的な文言 | delivery_type |
|---|---|---|
| 郵送交付 | `郵送による在留カード・在留資格認定証明書・就労資格証明書・資格外活動許可書の受領を希望されている` | `'mail'` |
| 窓口受取 | `本メール受信後１４日以内（注）に申請時に` `在留カード・就労資格証明書の受領希望先として選択された以下の地方出入国在留管理官署にお越しください` | `'window'` |

## GAS関数の改修

### 1. `importMail` 関数

メール取込時に本文を判別して `deliveryType` を返す。

```javascript
function importMail(args) {
  var msgId = args.id;
  var badge = args.badge; // '審査完了' / '認定証明書' / '受付番号' / etc.
  var result = {
    status: 'ok',
    driveUrl: '...',  // 既存
  };

  // ★追加: 審査完了メールの場合のみ配送タイプ判別
  if (badge === '審査完了') {
    var msg = GmailApp.getMessageById(msgId);
    if (msg) {
      var body = msg.getPlainBody() || '';
      result.deliveryType = detectDeliveryType(body);
    }
  }

  return result;
}

// ★新規関数: 本文から配送タイプを判別
function detectDeliveryType(body) {
  if (!body) return null;
  // 「郵送による」を含むなら郵送交付
  if (body.indexOf('郵送による在留カード') >= 0 || body.indexOf('郵送による') >= 0) {
    return 'mail';
  }
  // 「地方出入国在留管理官署にお越しください」を含むなら窓口受取
  if (body.indexOf('地方出入国在留管理官署にお越しください') >= 0) {
    return 'window';
  }
  return null;
}
```

### 2. （任意）`detectDeliveryTypeBatch` 関数

既存の未対応分を一括判別したい場合の関数。

```javascript
// クライアント: gasGmailPost('detectDeliveryTypeBatch', {ids:['msgId1','msgId2',...]})
function detectDeliveryTypeBatch(args) {
  var ids = args.ids || [];
  var results = {};
  for (var i = 0; i < ids.length; i++) {
    try {
      var msg = GmailApp.getMessageById(ids[i]);
      if (msg) {
        var body = msg.getPlainBody() || '';
        results[ids[i]] = detectDeliveryType(body);
      }
    } catch(e) {
      results[ids[i]] = null;
    }
  }
  return { status: 'ok', results: results };
}
```

## クライアント側で期待しているレスポンス

`importMail` のレスポンス例:

```json
{
  "status": "ok",
  "driveUrl": "https://drive.google.com/...",
  "deliveryType": "mail"   // ← 新規追加（審査完了メールの場合のみ）
}
```

`detectDeliveryTypeBatch` のレスポンス例:

```json
{
  "status": "ok",
  "results": {
    "19dd19e699307429": "mail",
    "19db7e347984138b": "window",
    "19dbXXXXXX": null
  }
}
```

## 動作確認

1. GAS Editor で上記コードを反映
2. デプロイ（既存のWebApp URLを使うので新規作成不要、バージョンを上げて再デプロイ）
3. OFUSA で新しい審査完了メールを取り込む
4. shinsa_archive テーブルの `delivery_type` カラムに 'mail' or 'window' が入る
5. 「審査完了メール 対応済」モーダルにバッジが表示される
