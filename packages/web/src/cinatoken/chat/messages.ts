/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
const en = {
	metadata: {
		title: 'Chat',
		description: 'Call cinatoken text models from a private browser session.',
	},
	title: 'Chat',
	description: 'Test a published model through the OpenAI-compatible gateway.',
	newChat: 'New chat',
	model: 'Model',
	textAndImages: 'Text and image input',
	textOnly: 'Text input only',
	apiKey: 'API key',
	keySafety:
		'Kept only in this page memory and forwarded by cinatoken to its API. It is never stored by this interface.',
	getKey: 'Create or manage keys',
	saveLocally: 'Save this conversation locally',
	saveLocallyHelp:
		'Optional. Saves the text transcript and model in this browser only. API keys and image data are never saved.',
	localSaveFailed: 'This browser could not save the conversation locally.',
	localAttachmentPlaceholder:
		'[Image attachment omitted from local session: {{count}}]',
	clear: 'Clear conversation',
	emptyTitle: 'Start a conversation',
	emptyDescription:
		'Choose a model, enter your API key, and send a message. Responses stream from the live gateway.',
	catalogUnavailable: 'The model catalog is unavailable, so chat cannot start.',
	noModels: 'No OpenAI-compatible text model is currently published.',
	thinking: 'Generating…',
	prompt: 'Message cinatoken',
	promptLabel: 'Chat message',
	send: 'Send message',
	stop: 'Stop generating',
	attachImages: 'Attach images',
	removeAttachment: 'Remove {{name}}',
	imagesUnsupported:
		'The selected model does not advertise image input support.',
	tooManyAttachments: 'A conversation can include up to {{count}} images.',
	unsupportedAttachment: 'Use PNG, JPEG, WebP, or GIF images.',
	attachmentTooLarge: 'Each image must be {{size}} MB or smaller.',
	attachmentsTooLarge:
		'Images in one conversation must total {{size}} MB or less.',
	attachmentReadFailed: 'The selected image could not be read.',
	disclaimer: 'Model output can be inaccurate. Review important information.',
	requestFailed: 'Request failed ({{status}}).',
	invalidResponse: 'The gateway returned no assistant text.',
	networkError: 'The request could not reach the gateway.',
}
const zh = {
	metadata: {
		title: '聊天',
		description: '在私有浏览器会话中调用 cinatoken 文本模型。',
	},
	title: '聊天',
	description: '通过 OpenAI 兼容网关测试已发布的模型。',
	newChat: '新对话',
	model: '模型',
	textAndImages: '支持文本和图片输入',
	textOnly: '仅支持文本输入',
	apiKey: 'API 密钥',
	keySafety:
		'仅保存在当前页面内存中，并由 cinatoken 转发至其 API；本界面不会存储密钥。',
	getKey: '创建或管理密钥',
	saveLocally: '在本地保存本次对话',
	saveLocallyHelp:
		'可选；仅在当前浏览器保存文字记录和模型，绝不保存 API 密钥或图片数据。',
	localSaveFailed: '当前浏览器无法在本地保存对话。',
	localAttachmentPlaceholder: '[本地会话未保存图片附件：{{count}} 张]',
	clear: '清空对话',
	emptyTitle: '开始对话',
	emptyDescription:
		'选择模型、输入 API 密钥并发送消息；回复会从实时网关流式返回。',
	catalogUnavailable: '模型目录不可用，暂时无法开始聊天。',
	noModels: '当前没有已发布的 OpenAI 兼容文本模型。',
	thinking: '生成中…',
	prompt: '发送消息给 cinatoken',
	promptLabel: '聊天消息',
	send: '发送消息',
	stop: '停止生成',
	attachImages: '添加图片',
	removeAttachment: '移除 {{name}}',
	imagesUnsupported: '所选模型未声明支持图片输入。',
	tooManyAttachments: '一次对话最多可包含 {{count}} 张图片。',
	unsupportedAttachment: '请选择 PNG、JPEG、WebP 或 GIF 图片。',
	attachmentTooLarge: '每张图片不得超过 {{size}} MB。',
	attachmentsTooLarge: '一次对话中的图片总计不得超过 {{size}} MB。',
	attachmentReadFailed: '无法读取所选图片。',
	disclaimer: '模型输出可能不准确，请核验重要信息。',
	requestFailed: '请求失败（{{status}}）。',
	invalidResponse: '网关未返回助手文本。',
	networkError: '请求无法到达网关。',
}
const ja = {
	metadata: {
		title: 'チャット',
		description:
			'プライベートなブラウザーセッションで cinatoken モデルを呼び出します。',
	},
	title: 'チャット',
	description: 'OpenAI 互換ゲートウェイで公開モデルを試します。',
	newChat: '新しいチャット',
	model: 'モデル',
	textAndImages: 'テキストと画像入力',
	textOnly: 'テキスト入力のみ',
	apiKey: 'API キー',
	keySafety:
		'このページのメモリ内だけに保持し、cinatoken が API へ転送します。画面側では保存しません。',
	getKey: 'キーを作成・管理',
	saveLocally: 'この会話をローカルに保存',
	saveLocallyHelp:
		'任意。テキスト履歴とモデルだけをこのブラウザーに保存します。API キーと画像データは保存しません。',
	localSaveFailed: 'このブラウザーでは会話をローカル保存できませんでした。',
	localAttachmentPlaceholder:
		'[ローカルセッションに画像を保存していません：{{count}} 件]',
	clear: '会話をクリア',
	emptyTitle: '会話を始める',
	emptyDescription:
		'モデルと API キーを選び、メッセージを送信してください。応答はライブゲートウェイからストリーミングされます。',
	catalogUnavailable: 'モデルカタログが利用できないため開始できません。',
	noModels: '公開中の OpenAI 互換テキストモデルがありません。',
	thinking: '生成中…',
	prompt: 'cinatoken にメッセージ',
	promptLabel: 'チャットメッセージ',
	send: '送信',
	stop: '生成を停止',
	attachImages: '画像を添付',
	removeAttachment: '{{name}} を削除',
	imagesUnsupported: '選択したモデルは画像入力対応として公開されていません。',
	tooManyAttachments: '1 件の会話に添付できる画像は最大 {{count}} 件です。',
	unsupportedAttachment: 'PNG、JPEG、WebP、GIF の画像を使用してください。',
	attachmentTooLarge: '画像 1 件の上限は {{size}} MB です。',
	attachmentsTooLarge:
		'1 件の会話の画像合計は {{size}} MB 以下にしてください。',
	attachmentReadFailed: '選択した画像を読み取れませんでした。',
	disclaimer:
		'モデル出力は不正確な場合があります。重要情報は確認してください。',
	requestFailed: 'リクエスト失敗（{{status}}）。',
	invalidResponse: 'アシスタントテキストが返りませんでした。',
	networkError: 'ゲートウェイへ接続できませんでした。',
}
const ko = {
	metadata: {
		title: '채팅',
		description: '비공개 브라우저 세션에서 cinatoken 텍스트 모델을 호출합니다.',
	},
	title: '채팅',
	description: 'OpenAI 호환 게이트웨이에서 게시된 모델을 테스트합니다.',
	newChat: '새 채팅',
	model: '모델',
	textAndImages: '텍스트 및 이미지 입력',
	textOnly: '텍스트 입력만',
	apiKey: 'API 키',
	keySafety:
		'이 페이지 메모리에만 보관되고 cinatoken이 API로 전달합니다. 인터페이스는 키를 저장하지 않습니다.',
	getKey: '키 만들기 또는 관리',
	saveLocally: '이 대화를 로컬에 저장',
	saveLocallyHelp:
		'선택 사항입니다. 텍스트 기록과 모델만 이 브라우저에 저장하며 API 키와 이미지 데이터는 저장하지 않습니다.',
	localSaveFailed: '이 브라우저에서 대화를 로컬에 저장할 수 없습니다.',
	localAttachmentPlaceholder:
		'[로컬 세션에 이미지 첨부 파일을 저장하지 않음: {{count}}개]',
	clear: '대화 지우기',
	emptyTitle: '대화 시작',
	emptyDescription:
		'모델을 선택하고 API 키와 메시지를 입력하세요. 응답은 실제 게이트웨이에서 스트리밍됩니다.',
	catalogUnavailable:
		'모델 카탈로그를 사용할 수 없어 채팅을 시작할 수 없습니다.',
	noModels: '현재 게시된 OpenAI 호환 텍스트 모델이 없습니다.',
	thinking: '생성 중…',
	prompt: 'cinatoken에 메시지',
	promptLabel: '채팅 메시지',
	send: '메시지 보내기',
	stop: '생성 중지',
	attachImages: '이미지 첨부',
	removeAttachment: '{{name}} 삭제',
	imagesUnsupported: '선택한 모델은 이미지 입력 지원으로 게시되지 않았습니다.',
	tooManyAttachments:
		'대화 하나에는 이미지를 최대 {{count}}개까지 포함할 수 있습니다.',
	unsupportedAttachment: 'PNG, JPEG, WebP 또는 GIF 이미지를 사용하세요.',
	attachmentTooLarge: '각 이미지는 {{size}}MB 이하여야 합니다.',
	attachmentsTooLarge: '대화 하나의 이미지 합계는 {{size}}MB 이하여야 합니다.',
	attachmentReadFailed: '선택한 이미지를 읽을 수 없습니다.',
	disclaimer: '모델 출력은 부정확할 수 있습니다. 중요한 정보는 확인하세요.',
	requestFailed: '요청 실패({{status}}).',
	invalidResponse: '게이트웨이가 어시스턴트 텍스트를 반환하지 않았습니다.',
	networkError: '게이트웨이에 연결할 수 없습니다.',
}
export const chatMessages = {
	en: {
		...en,
		retryAfter:
			'The gateway asks you to wait {{seconds}} seconds before retrying.',
		interrupted:
			'The stream ended before completion. The partial response is preserved.',
		timeout:
			'The request timed out. Review the partial response before sending another message.',
		invalidInput:
			'Check the API key, message count and attachment limits before sending.',
	},
	zh: {
		...zh,
		retryAfter: '网关要求等待 {{seconds}} 秒后再重试。',
		interrupted: '响应流在完成前中断，已保留收到的部分内容。',
		timeout: '请求已超时。再次发送前请检查已收到的部分内容。',
		invalidInput: '请检查 API 密钥、消息数量和附件限制后再发送。',
	},
	ja: {
		...ja,
		retryAfter:
			'ゲートウェイの指示に従い、{{seconds}} 秒後に再試行してください。',
		interrupted:
			'完了前にストリームが終了しました。受信済みの内容は保持されています。',
		timeout:
			'リクエストがタイムアウトしました。再送する前に受信済みの内容を確認してください。',
		invalidInput:
			'API キー、メッセージ数、添付ファイルの制限を確認してください。',
	},
	ko: {
		...ko,
		retryAfter: '게이트웨이 요청에 따라 {{seconds}}초 후 다시 시도하세요.',
		interrupted: '완료 전에 스트림이 종료되었습니다. 받은 내용은 유지됩니다.',
		timeout:
			'요청 시간이 초과되었습니다. 다시 보내기 전에 받은 내용을 확인하세요.',
		invalidInput: 'API 키, 메시지 수 및 첨부 제한을 확인하세요.',
	},
}
