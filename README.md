# どこでもDJ
## 概要
スマホをDJコントローラとして使用することができるWebアプリケーション
一般的なタッチUIに加え、ARジェスチャで操作ができる機能も備える

音の出し方は2通り。操作は共通なので、1台構成で覚えた手つきがそのままPC連携で通じる。

| | 誰向けか | やること | 音が出る場所 |
| -- | -------- | -------- | ------------ |
| 1台構成 | 初心者 | `/touch` を開いて曲を選ぶ | スマホ自身 |
| PC連携 | 経験者 | モニタのQRを読んで参加する | PCのDJソフト |

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

## 構成
| 役割 | 内容 | 置き場所 |
| ---- | ---- | -------- |
| サーバ (`server.js`) | ルーム管理・検証・リレー。MIDIは扱わない | ローカルでもクラウドでも可 |
| モニタ (`/output`) | 受け取った信号をWeb MIDIでそのまま出す | 音を出すPCのChrome |
| ブリッジ (`bridge/`) | 同じことをNodeから行う。任意 | 必ず音を出すPC上 |

MIDIの出口は2つあり、どちらで鳴らすかはルームごとに1つだけ選べる。
既定はモニタ画面のWeb MIDIで、この場合PC側で何も起動しなくてよい。
仮想ポートを自前で作りたい場合やChrome以外を使う場合はブリッジを立てる。
サーバを公開する場合も、ブリッジは各自のPCで動かして同じルームに繋ぐ。

### ルーム
1ルーム = 1つのDJセット。モニタ画面に4文字のコードとQRが出るので、スマホはそれを読んで参加する。
コードを持たないスマホは接続できない。ルームをまたいで信号が漏れることはない。

ローカル (`LOCAL_MODE=1`, 開発時の既定) では、ブリッジが1つだけならモニタはコード無しでもそこに入る。
公開時 (`LOCAL_MODE=0`) はこの近道は無効で、常にコードが要る。

## 技術仕様
### サーバ
- HTTPS化 : ローカルのみ。mkcertにて自己署名証明書を起動時に自動生成 (`certs/`)。公開時はプラットフォーム側でTLSを終端する前提
- ポート : 3000 (HTTPS), 3001 (HTTP→HTTPSリダイレクト)
- Socket.io : controller(スマホ) / output(PCモニタ) / bridge(MIDI出力)
- 検証 : controllerから届く3バイトを `src/core/mapping.ts` のホワイトリストで照合し、500msg/秒(バースト1000)で制限
- リレー : 検証を通った信号を同ルームのモニタへ転送し、出力先がブリッジのときはブリッジへも送る

### ブラウザで鳴らす (Web MIDI)
モニタ画面が受け取った信号を、そのままブラウザからMIDIポートへ出す。ブリッジは不要。

Web MIDIは仮想ポートを作れないので、OS側にループバックのポートを1つ用意する。

| OS | 用意するもの |
| -- | ------------ |
| macOS | Audio MIDI設定 → ウインドウ → MIDIスタジオ → IACドライバ を有効化 |
| Windows | loopMIDI で仮想ポートを1本作る |

DJソフトのMIDI入力にはそのポートを選ぶ。モニタを開くと初回に許可を求められ、
選んだポートは次回から自動で開き直す。

- 出力先はルームに1つ。ブラウザで鳴らしている間、サーバはブリッジへ信号を送らない
- モニタを閉じるか切断すると、鳴っている音を戻してブリッジ側へ戻る
- モニタが複数ある場合、最後にブラウザ出力を選んだ1枚だけが鳴らす
- Chrome / Edge のみ。Safari は Web MIDI 非対応なのでブリッジを使う
- タブを閉じると音が止まる。モニタとして開いたまま使う前提

### スマホだけで鳴らす (内蔵DJエンジン)
`/touch` をコード無しで開くと1台構成 (ヘッダに「ローカル」)。QRを読めばPC連携に移る。
操作で出たMIDIを、送信と同時にブラウザ内のWeb Audioへ流す (`src/core/audio.ts`, `djmidi.ts`)。

- 曲 : File APIでデッキごとに選ぶ。2デッキ、メモリに展開
- 波形 : 読み込み時にピークを畳んで全体波形を描く。CUE点は上端の旗、ホットキューは下端の番号付きチップ
- BPM : 読み込み時に自動推定 (立ち上がりの自己相関)。表示はテンポフェーダ込みの実効値。四つ打ち以外では外れることがある
- EQ / FILTER : 64が素通し。絞り切り-26dB、上げ切り+6dB。FILTERは左でローパス、右でハイパス
- TEMPO : 中央で等速、端で±8%
- タンテ : 触れている間はジョグが速度を握る。止めれば無音、送れば早回し
- PAD : ホットキュー4つ。未登録なら登録、登録済みなら頭出し、0.7秒の長押しで削除
- 制約 : 逆回転なし (`playbackRate` が負を取れない)。音量とクロスフェーダーは番号が無く両デッキ等倍。ARは未対応

### ブリッジ
- MIDI出力 : 既定は仮想ポート `DokodemoDJ`。モニタ画面のプルダウンで既存ポートへ切り替えられる
- 起動時から特定のポートを使う場合は `MIDI_PORT="ポート名の一部" npm run bridge`
- サーバとの接続が切れたら、自分が鳴らした音を必ず戻す

### 環境変数
| 変数 | 対象 | 内容 |
| ---- | ---- | ---- |
| `PORT` | サーバ | 待ち受けポート (既定 3000) |
| `PUBLIC_URL` | サーバ | 公開URL。案内メッセージに使う |
| `LOCAL_MODE` | サーバ | `1` でローカル運用 (証明書自動生成・コード無し参加)。既定は開発時のみ `1` |
| `LOG_MIDI` | サーバ | `1` でMIDIを1件ずつログ出力。既定は `LOCAL_MODE` と同じ |
| `SERVER_URL` | ブリッジ | 接続先サーバ (既定 `https://localhost:3000`) |
| `DJ_ROOM` | ブリッジ | 参加するルームコード。省略すると新規発行 |
| `MIDI_PORT` | ブリッジ | 開くMIDIポート名の一部 |
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
npm run dev                              # サーバとブリッジをまとめて起動
```

`npm run dev` はサーバとブリッジの両方を立ち上げる。片方だけ動かす場合は `npm run server` / `npm run bridge`。
ブラウザで鳴らすなら `npm run server` だけでよい。
証明書とMediaPipeのアセットは自動でセットアップされる。

| 用途             | URL                        |
| ---------------- | -------------------------- |
| 1台で試す        | `https://<PCのIP>:3000/touch` (コード不要。PCでも開ける) |
| PC版UI (モニタ)   | `https://localhost:3000/output` |
| スマホUI         | `https://<PCのIP>:3000/touch?room=コード` |
| ARモード         | `https://<PCのIP>:3000/ar?room=コード` |

モニタを開くとルームコードとQRが出る。スマホはQRを読めばコード付きのURLに飛ぶ。

Node は 22.18 以上が必要 (サーバが `src/core/mapping.ts` を直接読むため)。

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

## サーバを公開して使う
サーバだけをクラウドに置き、ブリッジは手元のPCで動かす。

```bash
docker build -t dokodemo-dj .
docker run -p 3000:3000 -e PUBLIC_URL=https://example.com dokodemo-dj
```

イメージにはMIDIのネイティブモジュールを含めない (`npm ci --omit=optional`)。
Socket.ioと常駐状態を持つので、サーバーレスではなく常駐Nodeが動くホストが要る。
複数インスタンスにする場合はスティッキーセッションかRedisアダプタが別途必要。

手元のPCからは次のように繋ぐ。

```bash
SERVER_URL=https://example.com DJ_ROOM=ABCD npm run bridge
```

### 既知の制約
1台構成では曲をメモリに展開するため、端末によっては2デッキ目で落ちることがある。

ブラウザで鳴らす場合、モニタのタブを閉じると音が止まる。
仮想ポートはWeb MIDIでは作れないため、IACやloopMIDIの用意が要る。

クラウド経由になるとスマホ→PC間に往復のレイテンシが乗る。
体感で問題になる場合は、スマホとPCをWebRTC DataChannelで直結し、
サーバをシグナリングだけに使う構成が必要になる (未実装)。
