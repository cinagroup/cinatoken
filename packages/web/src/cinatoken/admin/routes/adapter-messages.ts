/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
const strings = {
	'preset-image-qwen': [
		'DashScope Qwen image',
		'DashScope Qwen 生图',
		'DashScope Qwen 画像',
		'DashScope Qwen 이미지',
	],
	'preset-image-wan': [
		'DashScope Wan image',
		'DashScope Wan 生图',
		'DashScope Wan 画像',
		'DashScope Wan 이미지',
	],
	adapterGuide: [
		'Selected adapter',
		'所选适配器',
		'選択中のアダプター',
		'선택한 어댑터',
	],
	adapterGuidePath: [
		'Client request path',
		'客户端请求路径',
		'クライアントのリクエストパス',
		'클라이언트 요청 경로',
	],
	adapterGuideExchange: [
		'Adapter exchange',
		'适配器处理方式',
		'アダプターの処理方式',
		'어댑터 처리 방식',
	],
	'adapterExchange-unary': [
		'HTTP response',
		'HTTP 响应',
		'HTTP レスポンス',
		'HTTP 응답',
	],
	'adapterExchange-sse': [
		'Server-sent events (SSE)',
		'服务器推送事件（SSE）',
		'サーバー送信イベント（SSE）',
		'서버 전송 이벤트 (SSE)',
	],
	'adapterExchange-websocket': [
		'WebSocket session',
		'WebSocket 会话',
		'WebSocket セッション',
		'WebSocket 세션',
	],
	'adapterExchange-job': [
		'Asynchronous upstream task',
		'上游异步任务',
		'上流の非同期タスク',
		'공급자의 비동기 작업',
	],
	adapterGuideNativeTask: [
		'After submission, query {{path}} with the same Gateway Key and the task receipt returned by the gateway.',
		'提交后，使用同一 Gateway Key 和网关返回的任务回执查询 {{path}}。',
		'送信後、同じ Gateway Key とゲートウェイが返すタスク受領情報で {{path}} を照会します。',
		'제출 후 동일한 Gateway Key와 게이트웨이가 반환한 작업 수신 정보로 {{path}}를 조회하세요.',
	],
	adapterGuideConvertedTask: [
		'The gateway waits for the upstream task and returns the transcription response. The client does not query a DashScope task.',
		'网关等待上游任务并返回转写结果，客户端无需查询 DashScope 任务。',
		'ゲートウェイが上流タスクを待機し、文字起こし結果を返します。クライアントによる DashScope タスクの照会は不要です。',
		'게이트웨이가 공급자 작업을 기다린 뒤 전사 결과를 반환합니다. 클라이언트에서 DashScope 작업을 조회할 필요가 없습니다.',
	],
	adapterGuideCapabilities: [
		'Required provider endpoints',
		'所需供应商端点',
		'必要なプロバイダーエンドポイント',
		'필요한 공급자 엔드포인트',
	],
	adapterGuideUnsupported: [
		'Unsupported fields',
		'不支持的字段',
		'未対応のフィールド',
		'지원하지 않는 필드',
	],
	adapterGuideProtected: [
		'Gateway-managed fields',
		'网关管理的字段',
		'ゲートウェイ管理のフィールド',
		'게이트웨이가 관리하는 필드',
	],
	adapterGuideProtectedHint: [
		'These fields are restored by the gateway after merging extra_body.',
		'这些字段在合并 extra_body 后由网关恢复。',
		'これらは extra_body のマージ後にゲートウェイが復元します。',
		'이 필드는 extra_body 병합 후 게이트웨이가 복원합니다.',
	],
	adapterGuideExample: [
		'extra_body example',
		'extra_body 示例',
		'extra_body の例',
		'extra_body 예시',
	],
	adapterGuideCopy: [
		'Copy extra_body example',
		'复制 extra_body 示例',
		'extra_body の例をコピー',
		'extra_body 예시 복사',
	],
	adapterGuideCopied: [
		'Example copied.',
		'已复制示例。',
		'例をコピーしました。',
		'예시를 복사했습니다.',
	],
	adapterGuideCopyFailed: [
		'Could not copy the example.',
		'无法复制示例。',
		'例をコピーできませんでした。',
		'예시를 복사할 수 없습니다.',
	],
	adapterGuideTtsInput: [
		'OpenAI input is the text to synthesize. Put nested upstream options in extra_body.',
		'OpenAI input 是待合成的文本，上游嵌套参数请放入 extra_body。',
		'OpenAI input は合成するテキストです。上流のネストした設定は extra_body に入れてください。',
		'OpenAI input은 합성할 텍스트입니다. 공급자의 중첩 옵션은 extra_body에 넣으세요.',
	],
	adapterGuideModelMismatch: [
		'This adapter does not match the configured model name pattern. Verify the upstream model before saving.',
		'当前供应商模型名未匹配该适配器的型号规则，请在保存前核对。',
		'設定されたモデル名がこのアダプターのパターンに一致しません。保存前に上流モデルを確認してください。',
		'설정한 모델 이름이 이 어댑터의 패턴과 일치하지 않습니다. 저장 전에 공급자 모델을 확인하세요.',
	],
} satisfies Record<string, readonly [string, string, string, string]>
export function routeAdapterMessages(
	index: 0 | 1 | 2 | 3
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(strings).map(([key, values]) => [key, values[index]])
	)
}
