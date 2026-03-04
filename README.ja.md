# mojiokoshi

[![Next.js](https://img.shields.io/badge/Next.js-15-black?logo=next.js)](https://nextjs.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-3-06B6D4?logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)
[![OpenAI](https://img.shields.io/badge/OpenAI-Speech--to--Text-412991?logo=openai&logoColor=white)](https://platform.openai.com/docs/guides/speech-to-text)
[![License](https://img.shields.io/badge/License-Proprietary-red)](#ライセンス)

> **[English README](README.md)**

[OpenAI Speech-to-Text API](https://platform.openai.com/docs/guides/speech-to-text) を使った音声文字起こしWebアプリケーション。

オーディオファイルをアップロードし、OpenAI API キーを入力するだけで、プレーンテキスト・JSON・SRT・VTT 形式で文字起こし結果を取得できます。

![mojiokoshi スクリーンショット](docs/screenshot.jpg)

## 機能

- ドラッグ＆ドロップまたはクリックでオーディオファイルをアップロード（mp3, wav, m4a, mp4, webm, ogg, flac — 最大 500MB）
- 大容量ファイル対応: 25MB 超のファイルは [ffmpeg.wasm](https://ffmpegwasm.netlify.app/) でブラウザ内圧縮・分割（サーバー不要）
- チャンク間の文脈引き継ぎによる高精度な分割文字起こし
- 圧縮・分割・文字起こし中のリアルタイム進捗表示
- 処理中いつでもキャンセル可能
- モデル選択: GPT-4o Transcribe / GPT-4o Mini Transcribe / Whisper-1
- 出力形式: text / json / verbose_json / srt / vtt
- SRT/VTT 形式ではチャンク間のタイムスタンプを自動オフセット
- 言語検出（自動または 11 言語から手動選択）
- プロンプト入力で固有名詞・専門用語のヒントを指定可能
- API キーはブラウザの localStorage に保存（OpenAI 以外のサーバーには送信されません）
- ワンクリックで文字起こし結果をコピー

## 技術スタック

- [Next.js 15](https://nextjs.org/)（App Router）
- [React 19](https://react.dev/)
- [Tailwind CSS 3](https://tailwindcss.com/)
- [ffmpeg.wasm](https://ffmpegwasm.netlify.app/)（クライアントサイド音声処理）
- TypeScript

## セットアップ

```bash
# 依存パッケージのインストール
npm install

# 開発サーバーの起動
npm run dev
```

ブラウザで [http://localhost:3000](http://localhost:3000) を開いてください。

文字起こし機能を使用するには [OpenAI API キー](https://platform.openai.com/api-keys) が必要です。

## デプロイ

[Vercel](https://vercel.com) に設定なしでデプロイできます:

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/loppo-llc/mojiokoshi)

## ライセンス

本プロジェクトはプロプライエタリソフトウェアです。すべての権利は [loppo LLC](https://github.com/loppo-llc) に帰属します。無断での複製・改変・再配布を禁止します。
