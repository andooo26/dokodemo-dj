# どこでもDJ
## 概要
スマホをDJコントローラとして使用することができるWebアプリケーション
一般的なタッチUIに加え、ARジェスチャで操作ができる機能も備える

## 使用技術
| 項目               | 内容                        |
| ------------------ | --------------------------- |
| フレームワーク     | Next.js 16.2.6 (App Router) |
| UI                 | React 19 + Tailwind CSS     |
| リアルタイム通信   | Socket.io                   |
| MIDI               | @julusian/midi (Node)       |
| ハンドトラッキング | @mediapipe/tasks-vision     |
| サーバー           | Node.js                     |
| 言語               | TypeScript                  |

## 技術仕様
### サーバ
- HTTPS化 : mkcertにて自己署名証明書を起動時に自動生成 (`certs/`)
- ポート : 3000 (HTTPS), 3001 (HTTP→HTTPSリダイレクト)
- Socket.io : controller(スマホ)/output(PC モニタ)
- MIDI出力 : controllerから受信した信号をサーバがMIDIポートへ送出
  - 既定は仮想ポート `DokodemoDJ`。output画面のプルダウンで既存ポートへ切り替えられる
  - 起動時から特定のポートを使う場合は `MIDI_PORT="ポート名の一部" npm run dev`
- リレー : 同じ信号をoutput(モニタ)にも転送
#### MIDIメッセージ仕様
#### メッセージ型 (MidiMsg)
```
type MidiMsg =
 | { type: 'note_on'; channel: number; note: number; velocity: number }
 | { type: 'note_off'; channel: number; note: number }
 | { type: 'cc'; channel: number; controller: number; value:
number }
 | { type: 'pitch_bend'; channel: number; value: number }
 ```
#### チャンネル
- 0 : DECK1
- 1 : DECK2

#### ノート,CC
| 操作          | タイプ | 番号 |
| ------------- | ------ | ---- |
| タンテ停止    | note   | 46   |
| CUE           | note   | 47   |
| PLAY/PAUSE    | note   | 0    |
| PAD 1         | note   | 36   |
| PAD 2         | note   | 37   |
| PAD 3         | note   | 38   |
| PAD 4         | note   | 39   |
| TEMPOフェーダ | CC     | 9 (MSB) / 41 (LSB) |
| HIGH          | CC     | 10   |
| MID           | CC     | 11   |
| LOW           | CC     | 12   |
| FILTER        | CC     | 13   |

#### useMidiBridgeフック(src/hooks/useMidiBridge.ts)
- 返り値

```typescript
{ status, log, connect, send, failed }
```

| 項目    | 型                                              | 内容               |
| ------- | ----------------------------------------------- | ------------------ |
| status  | `'disconnected' \| 'connecting' \| 'connected'` | 接続状態           |
| log     | `string[]`                                      | 最新30件のログ     |
| connect | `() => void`                                    | 手動再接続         |
| send    | `(msg: MidiMsg) => void`                        | MIDI送信           |
| failed  | `boolean`                                       | 自動接続失敗フラグ |

---

#### ARモード (src/app/ar/page.tsx)

##### MediaPipe 設定

| 設定       | 値                     |
| ---------- | ---------------------- |
| モデル     | HandLandmarker float16 |
| 実行モード | VIDEO                  |
| 最大手数   | 2                      |
| WASM       | jsDelivr CDN           |

##### ジェスチャー仕様

###### PADピンチ
- **検出**: 親指と各指先の距離 < `PINCH_THRESH (0.07)`
- **有効エリア**: 画面下半分 (index.y ≥ 0.4)
- **排他制御**: 最も近い指1本のみ有効 (best-pinch-wins)
- **無効条件**: グー状態 / フェーダーエリア(y < 0.4) / フェーダーグラブ中

###### EQフェーダー操作
- **検出**: 人差し指先端がKNOB_ZONE矩形内に進入
- **操作**: 人差し指+親指ピンチ → 指のY移動でCC送信
- **感度**: `FADER_SENSI = 200`
- **デッキ別保存**: `eqValuesRef[2][4]` で独立管理

###### DECKグーポーズ
- **検出**: 全指屈曲 (`countExtendedFingers() === 0`)
- **動作**: 1秒ホールドでDECKをトグル (1→2→1)
- **状態管理**: `'none' → 'holding' → 'completed'`
- **排他制御**: PAD/フェーダー操作中は無視

###### 表示レイヤー
- カメラ映像 (background)
- Canvas オーバーレイ: スケルトン / フェーダーUI / ピンチライン / DECK表示 / プログレス円

##### フェーダーゾーン配置 (正規化座標)

| ゾーン | X    | Y中心 |
| ------ | ---- | ----- |
| HIGH   | 0.20 | 0.22  |
| MID    | 0.40 | 0.22  |
| LOW    | 0.60 | 0.22  |
| FILTER | 0.80 | 0.22  |

---

## 起動方法

```bash
npm install
brew install mkcert && mkcert -install   # 初回のみ
npm run dev                              # 本番相当は npm run mobile
```

証明書は `npm run dev` が自動でセットアップするので、手動発行は不要。
起動時にアクセス用URLがターミナルに表示される。

| 用途             | URL                        |
| ---------------- | -------------------------- |
| スマホUI         | `https://<PCのIP>:3000/touch`   |
| ARモード         | `https://<PCのIP>:3000/ar` |
| PC版UI (モニタ)   | `https://localhost:3000/output` |

### 証明書の自動セットアップ
`server.js` が起動時に以下を行う。

- mkcert があれば `certs/` に自己署名証明書を自動生成する。SANには `localhost` / LAN IP / `<ホスト名>.local` が含まれる
- PCのIPが変わった場合はSANの差分を検出して自動で再発行する
- mkcert が無い場合はHTTPで起動し、対処法を表示する(HTTPではスマホのカメラが使用不可)

`.local` 名でアクセスすればIP変更の影響を受けない。

### スマホでの証明書警告
サーバが `/rootCA.pem` でmkcertのルートCAを配信するので、スマホでそのURLを開いてインストールする。

- iOS : 設定 → 一般 → VPNとデバイス管理 でプロファイルをインストール後、設定 → 一般 → 情報 → 証明書信頼設定 で有効化
- Android : ダウンロード後、設定からCA証明書としてインストール

### 証明書を使わない方法
外出先でのデモなど、スマホ側に何もインストールさせたくない場合はトンネルを使う。

```bash
npm run dev      # 別ターミナル
npm run tunnel   # cloudflared が必要
```

`https://xxx.trycloudflare.com` が発行され、正規の証明書で接続できる。
通信がCloudflare経由になるためMIDIに遅延が乗る点に注意。
