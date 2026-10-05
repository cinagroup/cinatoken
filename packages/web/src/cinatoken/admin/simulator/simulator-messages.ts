/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
export const simulatorLegacyMessages = {
	ko: {
		wireHeaders: 'Headers (민감 정보 숨김)',
		audioFileRequired: '보내기 전에 오디오 파일이 필요합니다.',
		toolNoRoutes:
			'Agent Tools는 model_routes에 묶이지 않습니다. 이 모드에서는 모델과 라우트 그룹을 숨깁니다.',
		connection: '연결',
		errProxyUrlInvalid:
			'유효하지 않은 Proxy Base URL입니다(http:// 또는 https:// 필수)',
		imageOperation: '이미지 작업',
		refreshList: '목록 새로고침',
		referenceImagesSelected: '파일 {{count}}개 선택됨',
		downloadAudio: '오디오 다운로드',
		tool: '도구',
		modelNoRoute: '라우트 없음',
		audioInputMode: '오디오 입력',
		infoModelOverwritten:
			'요청 본문의 model을 "{{model}}"(으)로 설정했습니다(선택한 모델 및 Route 그룹과 일치).',
		emptyResponseHint:
			'Send를 클릭하면 상태, 본문 또는 스트림 출력이 여기에 표시됩니다.',
		kind: '유형',
		kindAudio: '오디오',
		apiKey: 'API Key',
		supportedSurfacesEmpty:
			'이 모델과 라우트 그룹에 활성 공개 Surface가 없습니다.',
		requestUrl: '요청 URL: ',
		mergedView: '병합 보기',
		audioTranscriptionsHint:
			'전사: JSON 필드(language, response_format)와 오디오 파일 → multipart POST /v1/audio/transcriptions.',
		clientHint:
			'실제 클라이언트와 같습니다. Proxy Base URL + 사용자 API 키이며 인증, failover, 과금, 요청 로그가 모두 적용됩니다.',
		defaultRouteGroup: '기본값 (명시적 접미사 없음)',
		matchingRoutesEmpty:
			'이 모델 및 Route 그룹과 일치하는 활성 Route가 없습니다.',
		errBodyMustBeObject: '요청 본문은 JSON 객체여야 합니다',
		toolHint:
			'선택한 API 키로 Proxy POST /v1/tools/{{id}}를 호출합니다(인증·과금·로그).',
		routeGroupHint:
			'이 모델의 활성 Routes에서 가져옵니다. OpenAI/Anthropic은 body.model을 id 또는 id:group으로 설정하고, Gemini는 같은 경로 세그먼트를 사용합니다.',
		requestBody: '요청 본문',
		openRequestLogs: '요청 로그 열기 →',
		routingTargetHint:
			'클라이언트가 보낼 catalog 모델과 Route group을 고릅니다. 업스트림은 Proxy가 고르며, 여기서는 단일 Route를 고정하지 않습니다.',
		errSelectKey: 'API Key를 선택하고 불러오기가 끝날 때까지 기다리세요(sk-…)',
		errSelectModel: '모델을 선택하세요',
		matchingRoutesNeedModel: '일치할 Route를 미리 보려면 모델을 선택하세요.',
		noRoutedModels: '이 종류에 활성 Route가 있는 모델이 없습니다.',
		keysShowing: '전체 Key {{total}}개 중 {{shown}}개 표시',
		tabMerged: '병합',
		modelHasRoute: '라우트 있음',
		errProxyUrlRequired: 'Proxy Base URL이 필요합니다',
		rawPayload: '원시 Payload',
		thinkingReasoning: 'Thinking / reasoning',
		localDevHint:
			'로컬 개발 예시: http://127.0.0.1:8787 — 실수로 프로덕션을 지정하지 않도록 주의하세요.',
		protocol: '프로토콜',
		selectModel: '— 모델 선택 —',
		imagePreview: '생성된 이미지',
		noMatchingModels: '현재 검색과 일치하는 모델이 없습니다.',
		audioPreview: '합성 오디오',
		audioInputFile: '오디오 파일',
		readyNeedKeyLoading: 'API Key를 아직 불러오는 중입니다…',
		audioSpeechHint:
			'음성 합성: JSON 본문에서 input, voice, response_format, speed를 편집 → POST /v1/audio/speech.',
		referenceImagesRequired: '참조 이미지가 하나 이상 필요합니다.',
		realtimeOperation: '실시간 작업',
		model: '모델',
		emailContains: '이메일 포함',
		openaiOperationHint:
			'chat → POST /v1/chat/completions. responses → POST /v1/responses (input + store: false).',
		errKeyLoading: 'API Key를 아직 불러오는 중입니다',
		proxyBaseUrl: 'Proxy Base URL',
		routingTarget: 'Routing 대상',
		openToolsInvocations: 'Tools Invocations 열기',
		protocolSwitchConfirm:
			'요청 본문이 편집되었습니다. 프로토콜을 전환하고 기본 템플릿으로 교체하시겠습니까?',
		wirePreview: 'Wire 미리보기 (URL / headers / body)',
		imageGenerationsHint:
			'Generations: POST /v1/images/generations용 JSON 본문(prompt, n, size, quality).',
		readyNeedModel: '모델을 선택하세요.',
		modelFilterPlaceholder: 'id / 표시 이름 / vendor 포함…',
		errSelectTool: '전송 전에 도구를 선택하세요.',
		body: '본문',
		toolProtocolHidden:
			'Tools는 항상 JSON POST /v1/tools/* 입니다. 프로토콜 선택은 적용되지 않습니다.',
		loadingKey: 'Key 불러오는 중…',
		routingModelString: 'Routing 모델 문자열',
		audioRealtimeSpeechHint:
			'DashScope 실시간 음성 합성: 브라우저가 WebSocket을 열고 run-task 다음 continue-task 텍스트를 전송한 뒤 오디오 청크를 받습니다.',
		matchingRoutes: '일치하는 활성 Routes',
		select: '— 선택 —',
		protocolLockedAudio:
			'오디오 라우트는 OpenAI HTTP(ASR: POST /v1/audio/transcriptions, TTS: /v1/audio/speech) 또는 DashScope 실시간 WSS를 지원합니다.',
		audioRealtimeDashScopeHint:
			'DashScope 실시간 ASR: 브라우저가 WebSocket을 열며, 작업 모드는 바이너리 PCM, 세션 모드는 Base64 오디오 이벤트를 전송합니다.',
		couldNotExtractBody: '(Payload에서 본문을 추출할 수 없음)',
		title: 'Simulator',
		modelCount: '이 유형 {{total}}개 · 표시 {{filtered}}개',
		toolEndpoint: 'Proxy 경로',
		matchingRoutesSummary: '일치하는 활성 Route {{count}}개',
		kindLlm: 'LLM',
		applyTemplate: '템플릿으로 초기화',
		audioFileHint: 'multipart 업로드용 오디오 파일 하나 선택.',
		referenceImagesHint:
			'multipart 업로드용 이미지 파일 1–{{max}}개를 선택하세요.',
		requestTargetUrlEmpty:
			'전체 URL을 미리 보려면 Proxy Base URL, 모델 및 API Key를 입력하세요.',
		usagePreview: '사용량 (미리보기): ',
		subtitle:
			'{{product}} — 실제 클라이언트처럼 브라우저에서 Proxy를 직접 호출합니다: 인증, Route 그룹, Failover, 청구 및 api_key_request_logs.',
		response: '응답',
		requestTargetUrl: '요청 URL',
		jsonBodySent: 'Proxy로 전송할 JSON 본문',
		readyNeedKey: 'API Key를 선택하고 불러오기가 끝날 때까지 기다리세요(sk-…).',
		filter: '필터',
		audioRealtimeFileDashScopeHint:
			'실시간 ASR은 선택한 WSS 모드로 오디오를 전송합니다. 파일 입력에는 16 kHz 모노 PCM을 사용하세요.',
		audioResponseReceived: '합성 오디오 {{bytes}}바이트를 수신했습니다.',
		tabRaw: '원본',
		kindImage: '이미지',
		matchingRoutesHint:
			'이 모델과 그룹에 대해 Proxy가 쓸 수 있는 활성 Route의 읽기 전용 미리보기입니다. Failover는 요청 시점에 발생합니다.',
		openaiOperation: 'OpenAI operation',
		openaiOperationSwitchConfirm:
			'요청 본문이 편집되었습니다. OpenAI operation을 전환하고 기본 템플릿으로 교체하시겠습니까?',
		readyNeedTool: '도구를 선택하세요.',
		protocolLockedImage:
			'이미지 모델은 openai → POST /v1/images/generations 또는 /v1/images/edits로 고정됩니다.',
		readyNeedProxyUrl: '유효한 Proxy Base URL(http/https)을 입력하세요.',
		referenceImages: '참조 이미지',
		loadedKey: '불러옴: {{prefix}}…{{suffix}}',
		usageNote:
			'아래 사용량은 참고용입니다. API Key는 메모리에만 유지되며 localStorage에 기록되지 않습니다.',
		keysLimitHint: ' — 스크롤 제한 내에서 더 보려면 필터 범위를 좁히세요.',
		routeGroupOptional: 'Route 그룹 (선택 사항)',
		audioInputMicrophone: '브라우저 마이크',
		modelKind: '유형',
		audioFile: '오디오 파일',
		readyNeedOpenaiForImage:
			'이미지 생성 모델은 openai 프로토콜이 필요합니다(Proxy /v1/images/generations 또는 /v1/images/edits).',
		wirePreviewEmpty:
			'요청을 미리 보려면 Proxy URL, 모델 및 API Key를 입력하고 유효한 JSON을 작성하세요.',
		kindTool: 'Tools',
		geminiAction: 'Gemini action',
		receiving: '(수신 중…)',
		wireBody: 'Body',
		apiKeyRowId: 'API Key (row id)',
		imageEditsHint:
			'Edits: JSON 필드와 참조 이미지 파일 → multipart POST /v1/images/edits.',
	},
	zh: {
		wireHeaders: 'Headers（已脱敏）',
		audioFileRequired: '发送前必须选择音频文件。',
		toolNoRoutes: 'Agent Tools 不绑定 model_routes；此模式下隐藏模型与路由组。',
		connection: '连接',
		errProxyUrlInvalid: 'Proxy Base URL 无效（须为 http:// 或 https://）',
		imageOperation: '图像操作',
		refreshList: '刷新列表',
		referenceImagesSelected: '已选 {{count}} 个文件',
		downloadAudio: '下载音频',
		tool: '工具',
		modelNoRoute: '无路由',
		audioInputMode: '音频输入',
		infoModelOverwritten:
			'已将请求体 model 设为 "{{model}}"（与所选模型及路由组一致）。',
		emptyResponseHint: '点击发送后，这里会显示状态、响应体或流式输出。',
		kind: '类型',
		kindAudio: '音频',
		apiKey: 'API Key',
		supportedSurfacesEmpty: '当前模型和路由组没有可用的公开入口。',
		requestUrl: '请求 URL：',
		mergedView: '合并视图',
		audioTranscriptionsHint:
			'转写：JSON 字段（language、response_format）加上音频文件 → multipart POST /v1/audio/transcriptions。',
		clientHint:
			'与真实客户端相同：Proxy Base URL + 用户 API Key。鉴权、故障转移、计费和请求日志都会生效。',
		defaultRouteGroup: '默认（无显式后缀）',
		matchingRoutesEmpty: '没有与当前模型 / 路由组匹配的活跃路由。',
		errBodyMustBeObject: '请求体必须是 JSON 对象',
		toolHint:
			'使用所选 API Key 调用 Proxy POST /v1/tools/{{id}}（鉴权、计费、请求日志）。',
		routeGroupHint:
			'来自该模型的活跃路由。OpenAI/Anthropic 将 body.model 设为 id 或 id:group；Gemini 在路径中使用相同片段。',
		requestBody: '请求体',
		openRequestLogs: '打开请求日志 →',
		routingTargetHint:
			'选择客户端会发送的目录模型与路由组。上游由代理服务决定，这里不会钉死单条路由。',
		errSelectKey: '请选择 API Key 并等待加载完成（sk-…）',
		errSelectModel: '请选择模型',
		matchingRoutesNeedModel: '选择模型后可预览会匹配的路由。',
		noRoutedModels: '该类型下没有已配置活跃路由的模型。',
		keysShowing: '显示 {{shown}} / {{total}} 个 Key',
		tabMerged: '合并视图',
		modelHasRoute: '已路由',
		errProxyUrlRequired: '请填写 Proxy Base URL',
		rawPayload: '原始报文',
		thinkingReasoning: 'Thinking / reasoning',
		localDevHint: '本地开发示例：http://127.0.0.1:8787 — 避免误指向生产环境。',
		protocol: '协议',
		selectModel: '— 请选择模型 —',
		imagePreview: '生成图片',
		noMatchingModels: '没有符合当前搜索的模型。',
		audioPreview: '合成音频',
		audioInputFile: '音频文件',
		readyNeedKeyLoading: 'API Key 仍在加载…',
		audioSpeechHint:
			'语音合成：在 JSON 请求体中编辑 input、voice、response_format 和 speed → POST /v1/audio/speech。',
		referenceImagesRequired: '至少需要选择一张参考图。',
		realtimeOperation: '实时操作',
		model: '模型',
		emailContains: 'Email 包含',
		openaiOperationHint:
			'chat → POST /v1/chat/completions。responses → POST /v1/responses（input + store: false）。',
		errKeyLoading: 'API Key 仍在加载',
		proxyBaseUrl: 'Proxy Base URL',
		routingTarget: '路由目标',
		openToolsInvocations: '打开 Tools 调用记录',
		protocolSwitchConfirm: '请求体已修改。切换协议并用默认模板覆盖吗？',
		wirePreview: '请求预览（URL / Headers / Body）',
		imageGenerationsHint:
			'文生图：JSON 请求体对应 POST /v1/images/generations（prompt、n、size、quality）。',
		readyNeedModel: '请选择模型。',
		modelFilterPlaceholder: 'ID / 显示名称 / 模型厂商包含…',
		errSelectTool: '发送前请先选择工具。',
		body: '正文',
		toolProtocolHidden: 'Tools 固定走 JSON POST /v1/tools/*，无需选择协议。',
		loadingKey: '加载 Key 中…',
		routingModelString: '路由模型字符串',
		audioRealtimeSpeechHint:
			'DashScope 实时语音合成：浏览器建立 WebSocket；先发送 run-task，再发送文本 continue-task，返回音频分片。',
		matchingRoutes: '将命中的活跃路由',
		select: '— 请选择 —',
		protocolLockedAudio:
			'音频路由支持 OpenAI HTTP（ASR：POST /v1/audio/transcriptions，TTS：/v1/audio/speech）或 DashScope 实时 WSS。',
		audioRealtimeDashScopeHint:
			'DashScope 实时 ASR：浏览器建立 WebSocket；任务模式发送二进制 PCM，会话模式发送 Base64 音频事件。',
		couldNotExtractBody: '（无法从报文提取正文）',
		title: '模拟器',
		modelCount: '本类型 {{total}} 个 · 显示 {{filtered}} 个',
		toolEndpoint: 'Proxy 路径',
		matchingRoutesSummary: '{{count}} 条匹配的活跃路由',
		kindLlm: '大语言模型',
		applyTemplate: '重置为模板',
		audioFileHint: '选择一个音频文件用于 multipart 上传。',
		referenceImagesHint: '选择 1–{{max}} 张图片用于 multipart 上传。',
		requestTargetUrlEmpty:
			'补全 Proxy Base URL、模型与 API Key 后即可预览完整 URL。',
		usagePreview: '用量（预览）：',
		subtitle:
			'{{product}} — 浏览器直接调用 Proxy，如同真实客户端：鉴权、路由组、故障转移、计费与 api_key_request_logs。',
		response: '响应',
		requestTargetUrl: '请求 URL',
		jsonBodySent: '发送到 Proxy 的 JSON 请求体',
		readyNeedKey: '请选择 API Key 并等待加载完成（sk-…）。',
		filter: '筛选',
		audioRealtimeFileDashScopeHint:
			'实时 ASR 按所选 WSS 模式发送音频；文件输入请使用 16 kHz 单声道 PCM。',
		audioResponseReceived: '已收到 {{bytes}} 字节的合成音频。',
		tabRaw: '原始报文',
		kindImage: '文生图',
		matchingRoutesHint:
			'只读预览：代理服务可能用到的活跃路由。实际请求时仍会故障转移。',
		openaiOperation: 'OpenAI 操作',
		openaiOperationSwitchConfirm:
			'请求体已修改。切换 OpenAI 操作并用默认模板覆盖吗？',
		readyNeedTool: '请选择工具。',
		protocolLockedImage:
			'文生图模型已锁定为 openai → POST /v1/images/generations 或 /v1/images/edits。',
		readyNeedProxyUrl: '请填写有效的 Proxy Base URL（http/https）。',
		referenceImages: '参考图',
		loadedKey: '已加载：{{prefix}}…{{suffix}}',
		usageNote:
			'下方用量仅供参考。API Key 保留在内存中，不会写入 localStorage。',
		keysLimitHint: ' — 缩小筛选条件可查看更多结果。',
		routeGroupOptional: '路由组（可选）',
		audioInputMicrophone: '浏览器麦克风',
		modelKind: '类型',
		audioFile: '音频文件',
		readyNeedOpenaiForImage:
			'文生图模型须使用 openai 协议（Proxy /v1/images/generations 或 /v1/images/edits）。',
		wirePreviewEmpty:
			'填写 Proxy URL、模型、API Key 且 JSON 合法后可预览请求。',
		kindTool: 'Tools',
		geminiAction: 'Gemini 动作',
		receiving: '（接收中…）',
		wireBody: 'Body',
		apiKeyRowId: 'API Key（行 ID）',
		imageEditsHint:
			'图像编辑：JSON 字段加参考图 → multipart POST /v1/images/edits。',
	},
	ja: {
		wireHeaders: 'Headers（マスキング済み）',
		audioFileRequired: '送信前に音声ファイルが必要です。',
		toolNoRoutes:
			'Agent Tools は model_routes に束縛されません。このモードではモデルとルートグループを非表示にします。',
		connection: '接続',
		errProxyUrlInvalid:
			'Proxy Base URL が無効です（http:// または https:// が必要）',
		imageOperation: '画像操作',
		refreshList: '一覧を更新',
		referenceImagesSelected: '{{count}} ファイル選択済み',
		downloadAudio: '音声をダウンロード',
		tool: 'ツール',
		modelNoRoute: 'Route なし',
		audioInputMode: '音声入力',
		infoModelOverwritten:
			'リクエスト Body の model を "{{model}}" に設定しました（選択したモデルと Route Group に一致）。',
		emptyResponseHint:
			'Send をクリックすると、ステータス、Body、またはストリーム出力がここに表示されます。',
		kind: '種類',
		kindAudio: '音声',
		apiKey: 'API Key',
		supportedSurfacesEmpty:
			'このモデルと Route group に有効な公開 Surface がありません。',
		requestUrl: 'リクエスト URL：',
		mergedView: '統合表示',
		audioTranscriptionsHint:
			'文字起こし：JSON フィールド（language、response_format）と音声ファイル → multipart POST /v1/audio/transcriptions。',
		clientHint:
			'実クライアントと同じ経路です。Proxy Base URL とユーザー API キーを使い、認証・failover・課金・リクエストログが適用されます。',
		defaultRouteGroup: 'デフォルト（明示的なサフィックスなし）',
		matchingRoutesEmpty:
			'このモデルと Route Group に一致する有効な Route はありません。',
		errBodyMustBeObject:
			'リクエスト Body は JSON オブジェクトである必要があります',
		toolHint:
			'選択した API キーで Proxy POST /v1/tools/{{id}} を呼び出します（認証・課金・ログ）。',
		routeGroupHint:
			'このモデルの有効な Route から取得します。OpenAI/Anthropic は body.model を id または id:group に設定し、Gemini は同じパスセグメントを使用します。',
		requestBody: 'リクエスト Body',
		openRequestLogs: 'リクエストログを開く →',
		routingTargetHint:
			'クライアントが送る catalog モデルと Route group を選びます。上流は Proxy が選び、ここでは単一 Route を固定しません。',
		errSelectKey:
			'API Key を選択し、読み込み（sk-…）が完了するまでお待ちください',
		errSelectModel: 'モデルを選択してください',
		matchingRoutesNeedModel:
			'モデルを選択すると、一致する Route をプレビューできます。',
		noRoutedModels: 'この Kind に Active Route があるモデルはありません。',
		keysShowing: '全 {{total}} Keys 中 {{shown}} 件を表示',
		tabMerged: '統合',
		modelHasRoute: 'Route あり',
		errProxyUrlRequired: 'Proxy Base URL は必須です',
		rawPayload: 'Raw payload',
		thinkingReasoning: 'Thinking / reasoning',
		localDevHint:
			'ローカル開発例：http://127.0.0.1:8787 — 誤って本番環境を指定しないよう注意してください。',
		protocol: 'プロトコル',
		selectModel: '— モデルを選択 —',
		imagePreview: '生成画像',
		noMatchingModels: '現在の検索に一致するモデルはありません。',
		audioPreview: '合成音声',
		audioInputFile: '音声ファイル',
		readyNeedKeyLoading: 'API Key を読み込み中です…',
		audioSpeechHint:
			'音声合成：JSON Body の input、voice、response_format、speed を編集 → POST /v1/audio/speech。',
		referenceImagesRequired: '参照画像を 1 つ以上選択してください。',
		realtimeOperation: 'リアルタイム操作',
		model: 'モデル',
		emailContains: 'メールアドレスに含む',
		openaiOperationHint:
			'chat → POST /v1/chat/completions。responses → POST /v1/responses（input + store: false）。',
		errKeyLoading: 'API Key を読み込み中です',
		proxyBaseUrl: 'Proxy Base URL',
		routingTarget: 'ルーティング先',
		openToolsInvocations: 'Tools Invocations を開く',
		protocolSwitchConfirm:
			'リクエスト Body は編集済みです。プロトコルを切り替え、デフォルトテンプレートに置き換えますか？',
		wirePreview: '送信内容のプレビュー（URL / headers / body）',
		imageGenerationsHint:
			'Generations：POST /v1/images/generations 用の JSON Body（prompt、n、size、quality）。',
		readyNeedModel: 'モデルを選択してください。',
		modelFilterPlaceholder: 'id / 表示名 / ベンダーを検索…',
		errSelectTool: '送信前にツールを選択してください。',
		body: 'Body',
		toolProtocolHidden:
			'Tools は常に JSON POST /v1/tools/* です。プロトコル選択は不要です。',
		loadingKey: 'Key を読み込み中…',
		routingModelString: 'ルーティングモデル文字列',
		audioRealtimeSpeechHint:
			'DashScope リアルタイム音声合成：ブラウザが WebSocket を開き、run-task の後に continue-task でテキストを送り、音声チャンクを受信します。',
		matchingRoutes: '一致する有効な Route',
		select: '— 選択 —',
		protocolLockedAudio:
			'音声ルートは OpenAI HTTP（ASR: POST /v1/audio/transcriptions、TTS: /v1/audio/speech）または DashScope リアルタイム WSS に対応します。',
		audioRealtimeDashScopeHint:
			'DashScope リアルタイム ASR：ブラウザが WebSocket を開き、タスクモードはバイナリ PCM、セッションモードは Base64 音声イベントを送信します。',
		couldNotExtractBody: '（payload から Body を抽出できませんでした）',
		title: 'Simulator',
		modelCount: 'この種類 {{total}} · 表示 {{filtered}}',
		toolEndpoint: 'Proxy パス',
		matchingRoutesSummary: '一致する Active Route {{count}} 件',
		kindLlm: 'LLM',
		applyTemplate: 'テンプレートにリセット',
		audioFileHint: 'multipart アップロード用の音声ファイルを 1 つ選択。',
		referenceImagesHint:
			'multipart アップロード用に 1–{{max}} 個の画像ファイルを選択してください。',
		requestTargetUrlEmpty:
			'完全な URL をプレビューするには、Proxy Base URL、モデル、API Key を入力してください。',
		usagePreview: '使用量（プレビュー）：',
		subtitle:
			'{{product}} — 実際のクライアントと同様にブラウザーから Proxy を直接呼び出します。認証、Route Group、failover、課金、api_key_request_logs が適用されます。',
		response: 'レスポンス',
		requestTargetUrl: 'リクエスト URL',
		jsonBodySent: 'Proxy に送信する JSON Body',
		readyNeedKey:
			'API Key を選択し、読み込み（sk-…）が完了するまでお待ちください。',
		filter: 'フィルター',
		audioRealtimeFileDashScopeHint:
			'リアルタイム ASR は選択した WSS モードで音声を送信します。ファイル入力には 16 kHz モノラル PCM を使用してください。',
		audioResponseReceived: '{{bytes}} バイトの合成音声を受信しました。',
		tabRaw: 'Raw',
		kindImage: '画像',
		matchingRoutesHint:
			'このモデルとグループで Proxy が使い得る Active Route の読み取り専用プレビューです。failover はリクエスト時に行われます。',
		openaiOperation: 'OpenAI operation',
		openaiOperationSwitchConfirm:
			'リクエスト Body は編集済みです。OpenAI operation を切り替え、デフォルトテンプレートに置き換えますか？',
		readyNeedTool: 'ツールを選択してください。',
		protocolLockedImage:
			'画像モデルは openai → POST /v1/images/generations または /v1/images/edits に固定されます。',
		readyNeedProxyUrl:
			'有効な Proxy Base URL（http/https）を入力してください。',
		referenceImages: '参照画像',
		loadedKey: '読み込み済み：{{prefix}}…{{suffix}}',
		usageNote:
			'以下の使用量は参考情報です。API Key はメモリ内にのみ保持され、localStorage には保存されません。',
		keysLimitHint:
			' — フィルターを絞り込むと、スクロール上限内でより多く表示できます。',
		routeGroupOptional: 'Route Group（任意）',
		audioInputMicrophone: 'ブラウザのマイク',
		modelKind: '種類',
		audioFile: '音声ファイル',
		readyNeedOpenaiForImage:
			'画像生成モデルにはプロトコル openai が必要です（Proxy /v1/images/generations または /v1/images/edits）。',
		wirePreviewEmpty:
			'リクエストをプレビューするには、Proxy URL、モデル、API Key、および有効な JSON を入力してください。',
		kindTool: 'Tools',
		geminiAction: 'Gemini action',
		receiving: '（受信中…）',
		wireBody: 'Body',
		apiKeyRowId: 'API Key（row id）',
		imageEditsHint:
			'Edits：JSON 項目と参照画像ファイル → multipart POST /v1/images/edits。',
	},
	en: {
		wireHeaders: 'Headers (redacted)',
		audioFileRequired: 'An audio file is required before Send.',
		toolNoRoutes:
			'Agent Tools are not bound to model_routes. Model and route group are hidden in this mode.',
		connection: 'Connection',
		errProxyUrlInvalid: 'Invalid Proxy Base URL (must be http:// or https://)',
		imageOperation: 'Image operation',
		refreshList: 'Refresh list',
		referenceImagesSelected: '{{count}} file(s) selected',
		downloadAudio: 'Download audio',
		tool: 'Tool',
		modelNoRoute: 'No route',
		audioInputMode: 'Audio input',
		infoModelOverwritten:
			'Set request body model to "{{model}}" (matches selected model and route group).',
		emptyResponseHint:
			'After you click Send, status, body, or streamed output appears here.',
		kind: 'Kind',
		kindAudio: 'Audio',
		apiKey: 'API Key',
		supportedSurfacesEmpty:
			'No active public surface for this model and route group.',
		requestUrl: 'Request URL: ',
		mergedView: 'Merged view',
		audioTranscriptionsHint:
			'Transcriptions: JSON fields (language, response_format) plus an audio file → multipart POST /v1/audio/transcriptions.',
		clientHint:
			'Same path a real client uses: Proxy Base URL + user API key. Auth, failover, billing, and request logs all apply.',
		defaultRouteGroup: 'Default (no explicit suffix)',
		matchingRoutesEmpty: 'No active routes match this model and route group.',
		errBodyMustBeObject: 'Request body must be a JSON object',
		toolHint:
			'Calls Proxy POST /v1/tools/{{id}} with the selected API key (auth, billing, logs).',
		routeGroupHint:
			'From active routes for this model. OpenAI/Anthropic set body.model to id or id:group; Gemini uses the same path segment.',
		requestBody: 'Request body',
		openRequestLogs: 'Open Request Logs →',
		routingTargetHint:
			'Pick the catalog model and route group the client would send. Proxy chooses the upstream; this page does not pin a single route.',
		errSelectKey: 'Select an API key and wait until it finishes loading (sk-…)',
		errSelectModel: 'Select a model',
		matchingRoutesNeedModel:
			'Select a model to preview routes that would match.',
		noRoutedModels: 'No models in this kind have an active route.',
		keysShowing: 'Showing {{shown}} of {{total}} key(s)',
		tabMerged: 'Merged',
		modelHasRoute: 'Routed',
		errProxyUrlRequired: 'Proxy Base URL is required',
		rawPayload: 'Raw payload',
		thinkingReasoning: 'Thinking / reasoning',
		localDevHint:
			'Local dev example: http://127.0.0.1:8787 — avoid pointing at production by mistake.',
		protocol: 'Protocol',
		selectModel: '— Select a model —',
		imagePreview: 'Generated images',
		noMatchingModels: 'No models match the current search.',
		audioPreview: 'Synthesized audio',
		audioInputFile: 'Audio file',
		readyNeedKeyLoading: 'API key is still loading…',
		audioSpeechHint:
			'Speech synthesis: edit input, voice, response_format, and speed in the JSON body → POST /v1/audio/speech.',
		referenceImagesRequired: 'At least one reference image is required.',
		realtimeOperation: 'Realtime operation',
		model: 'Model',
		emailContains: 'Email contains',
		openaiOperationHint:
			'chat → POST /v1/chat/completions. responses → POST /v1/responses (input + store: false).',
		errKeyLoading: 'API key is still loading',
		proxyBaseUrl: 'Proxy Base URL',
		routingTarget: 'Routing target',
		openToolsInvocations: 'Open Tools Invocations',
		protocolSwitchConfirm:
			'Request body was edited. Switch protocol and replace it with the default template?',
		wirePreview: 'Wire preview (URL / headers / body)',
		imageGenerationsHint:
			'Generations: JSON body for POST /v1/images/generations (prompt, n, size, quality).',
		readyNeedModel: 'Select a model.',
		modelFilterPlaceholder: 'id / display name / vendor contains…',
		errSelectTool: 'Select a tool before Send.',
		body: 'Body',
		toolProtocolHidden:
			'Tools always use JSON POST /v1/tools/* — protocol selection does not apply.',
		loadingKey: 'Loading key…',
		routingModelString: 'Routing model string',
		audioRealtimeSpeechHint:
			'DashScope realtime speech: the browser opens a WebSocket, sends run-task followed by continue-task text, and receives audio chunks.',
		matchingRoutes: 'Matching active routes',
		select: '— Select —',
		protocolLockedAudio:
			'Audio routes support OpenAI HTTP (POST /v1/audio/transcriptions for ASR or /v1/audio/speech for TTS) or DashScope realtime WSS.',
		audioRealtimeDashScopeHint:
			'DashScope realtime ASR: the browser opens a WebSocket; task mode sends binary PCM and session mode sends Base64 audio events.',
		couldNotExtractBody: '(Could not extract body from payload)',
		title: 'Simulator',
		modelCount: '{{total}} in this kind · {{filtered}} shown',
		toolEndpoint: 'Proxy path',
		matchingRoutesSummary: '{{count}} matching active route(s)',
		kindLlm: 'LLM',
		applyTemplate: 'Reset to template',
		audioFileHint: 'Select one audio file for multipart upload.',
		referenceImagesHint: 'Select 1–{{max}} image file(s) for multipart upload.',
		requestTargetUrlEmpty:
			'Complete Proxy Base URL, model, and API key to preview the full URL.',
		usagePreview: 'Usage (preview): ',
		subtitle:
			'{{product}} — Browser calls the Proxy directly, like a real client: auth, route groups, failover, billing, and api_key_request_logs.',
		response: 'Response',
		requestTargetUrl: 'Request URL',
		jsonBodySent: 'JSON body sent to Proxy',
		readyNeedKey: 'Select an API key and wait until it loads (sk-…).',
		filter: 'Filter',
		audioRealtimeFileDashScopeHint:
			'Realtime ASR uses the selected WSS mode for audio; use 16 kHz mono PCM for file input.',
		audioResponseReceived: 'Received {{bytes}} bytes of synthesized audio.',
		tabRaw: 'Raw',
		kindImage: 'Image',
		matchingRoutesHint:
			'Read-only preview of active routes Proxy may use for this model and group. Failover still happens at request time.',
		openaiOperation: 'OpenAI operation',
		openaiOperationSwitchConfirm:
			'Request body was edited. Switch OpenAI operation and replace it with the default template?',
		readyNeedTool: 'Select a tool.',
		protocolLockedImage:
			'Image models are locked to openai → POST /v1/images/generations or /v1/images/edits.',
		readyNeedProxyUrl: 'Enter a valid Proxy Base URL (http/https).',
		referenceImages: 'Reference images',
		loadedKey: 'Loaded: {{prefix}}…{{suffix}}',
		usageNote:
			'Usage below is informational only. The API key stays in memory and is not written to localStorage.',
		keysLimitHint: ' — narrow filters to see more within the scroll limit.',
		routeGroupOptional: 'Route group (optional)',
		audioInputMicrophone: 'Browser microphone',
		modelKind: 'Kind',
		audioFile: 'Audio file',
		readyNeedOpenaiForImage:
			'Image-generation models require protocol openai (Proxy /v1/images/generations or /v1/images/edits).',
		wirePreviewEmpty:
			'Complete Proxy URL, model, and API key with valid JSON to preview the request.',
		kindTool: 'Tools',
		geminiAction: 'Gemini action',
		receiving: '(Receiving…)',
		wireBody: 'Body',
		apiKeyRowId: 'API key (row id)',
		imageEditsHint:
			'Edits: JSON fields plus reference image files → multipart POST /v1/images/edits.',
	},
} as const

const simulatorAdditionalMessages = {
	en: {
		loading: 'Loading…',
		contextError: 'Could not load the Simulator model and route context.',
		keysError: 'Could not load the Key directory.',
		keysForbidden: 'Key directory access requires user_keys.read.',
		accessDenied: 'A verified Console session is required.',
		invalidTarget: 'The Simulator link contains an invalid selection.',
		clearTarget: 'Clear selection',
		keyPages: 'Key directory pages',
		previous: 'Previous',
		next: 'Next',
		page: 'Page {{page}}',
		owner: 'Owner',
		workspace: 'Workspace',
		keyBudget: 'Key spent / limit',
		originalSecret: 'Original Gateway Key secret',
		verifySecret: 'Verify secret',
		verifying: 'Verifying…',
		secretVerified: 'Secret verified for this Key, owner and workspace.',
		secretError:
			'The secret could not be verified for this selected Key. Enter the original secret again.',
		secretRequired:
			'Select a Key, enter its original secret and verify it before Send.',
		secretMemoryHint:
			'Gateway Keys are stored as hashes. Enter the original secret saved when the Key was created; masked previews cannot be used. The secret stays in memory and is cleared when Key, identity or Proxy changes, or this page closes.',
		priority: 'Priority {{priority}}',
		stop: 'Stop',
		send: 'Send',
		firstByteLatency: 'Time to response headers / first byte',
		imageLimits:
			'Up to {{max}} reference images; each file must be at most {{bytes}} bytes.',
		invalidImages:
			'Reference images exceed the count or size limit, or have an unsupported image type.',
		audioLimit: 'Audio file limit: {{bytes}} bytes.',
		invalidAudio: 'The audio file exceeds the allowed size.',
		multimodalHttpHint:
			'This operation uses DashScope multimodal HTTP. Set the public audio URL in the JSON body.',
		realtimeUnavailable:
			'No supported realtime operation is available for this selection.',
		realtimeTtsRejected:
			'The current Proxy rejects realtime TTS because its billing lifecycle is not supported. A real attempt will show the rejected handshake.',
		unknownChargeHint:
			'Cancellation or a lost connection does not prove the request was uncharged. Check the actual request logs before sending again; no automatic retry is performed.',
		handshakeRejected:
			'The WebSocket handshake did not open. Browser WebSocket does not expose its HTTP error body; no 101 response was received.',
		budgetError:
			'Proxy rejected this request because of a budget or balance restriction. Check the raw error and request logs before sending again.',
		actualRequest: 'Actual request snapshot',
		generationId: 'Generation ID',
		imageNumber: 'Generated image {{number}}',
		toolNames: {
			webSearch: 'Web Search',
			webFetch: 'Web Fetch',
			webDeepSearch: 'Deep Search',
			aiDetection: 'AI Detection',
		},
		outcomes: {
			running: 'Receiving…',
			complete: 'Completed',
			failed: 'Request failed',
			cancelled: 'Stopped; billing may have occurred',
			unknown: 'Outcome unknown; billing may have occurred',
		},
	},
	zh: {
		loading: '加载中…',
		contextError: '无法加载模拟器的模型及路由上下文。',
		keysError: '无法加载 Key 目录。',
		keysForbidden: '读取 Key 目录需要 user_keys.read 权限。',
		accessDenied: '需要已核验的 Console 会话。',
		invalidTarget: '模拟器链接包含无效的选择参数。',
		clearTarget: '清除选择',
		keyPages: 'Key 目录分页',
		previous: '上一页',
		next: '下一页',
		page: '第 {{page}} 页',
		owner: '所属用户',
		workspace: '工作区',
		keyBudget: 'Key 已用 / 上限',
		originalSecret: 'Gateway Key 原始密钥',
		verifySecret: '核验密钥',
		verifying: '核验中…',
		secretVerified: '密钥已核验并绑定至此 Key、用户和工作区。',
		secretError: '无法核验此密钥与所选 Key 的绑定。请重新输入原始密钥。',
		secretRequired: '请先选择 Key、输入其原始密钥并核验，再发送请求。',
		secretMemoryHint:
			'Gateway Key 以哈希形式存储。请使用创建时保存的原始密钥，掩码预览无法发送。密钥仅保存在内存中，切换 Key、身份或 Proxy 及离开页面时会清除。',
		priority: '优先级 {{priority}}',
		stop: '停止',
		send: '发送',
		firstByteLatency: '响应头 / 首字节耗时',
		imageLimits: '最多 {{max}} 张参考图，每个文件最多 {{bytes}} 字节。',
		invalidImages: '参考图数量或大小超限，或文件类型不受支持。',
		audioLimit: '音频文件上限：{{bytes}} 字节。',
		invalidAudio: '音频文件超过允许大小。',
		multimodalHttpHint:
			'此操作使用 DashScope 多模态 HTTP，请在 JSON 请求体中设置公开音频 URL。',
		realtimeUnavailable: '当前选择没有可用的实时操作。',
		realtimeTtsRejected:
			'当前 Proxy 因计费生命周期尚不支持而拒绝实时 TTS，真实请求将显示握手被拒绝。',
		unknownChargeHint:
			'停止请求或连接中断不能证明未发生计费。再次发送前请查看实际请求日志；此页面不会自动重试。',
		handshakeRejected:
			'WebSocket 握手未成功打开。浏览器 WebSocket 无法读取握手的 HTTP 错误体，未收到 101 响应。',
		budgetError:
			'Proxy 因预算或余额限制拒绝此请求。再次发送前请查看原始错误及请求日志。',
		actualRequest: '实际请求快照',
		generationId: 'Generation ID',
		imageNumber: '生成的第 {{number}} 张图片',
		toolNames: {
			webSearch: '网页搜索',
			webFetch: '网页抓取',
			webDeepSearch: '深度搜索',
			aiDetection: 'AI 检测',
		},
		outcomes: {
			running: '接收中…',
			complete: '已完成',
			failed: '请求失败',
			cancelled: '已停止，可能已发生计费',
			unknown: '结果未知，可能已发生计费',
		},
	},
	ja: {
		loading: '読み込み中…',
		contextError: 'シミュレーターのモデルとルートを読み込めませんでした。',
		keysError: 'Key 一覧を読み込めませんでした。',
		keysForbidden: 'Key 一覧の読み取りには user_keys.read 権限が必要です。',
		accessDenied: '確認済みの Console セッションが必要です。',
		invalidTarget: 'シミュレーターのリンクに無効な選択が含まれています。',
		clearTarget: '選択を解除',
		keyPages: 'Key 一覧のページ',
		previous: '前へ',
		next: '次へ',
		page: '{{page}} ページ',
		owner: '所有者',
		workspace: 'ワークスペース',
		keyBudget: 'Key 使用額 / 上限',
		originalSecret: 'Gateway Key の元のシークレット',
		verifySecret: 'シークレットを確認',
		verifying: '確認中…',
		secretVerified:
			'この Key、所有者、ワークスペースへの紐付けを確認しました。',
		secretError:
			'選択した Key との紐付けを確認できませんでした。元のシークレットを再入力してください。',
		secretRequired:
			'Key を選び、元のシークレットを入力して確認してから送信してください。',
		secretMemoryHint:
			'Gateway Key はハッシュで保存されています。作成時に保存した元のシークレットを使用してください。マスク表示は送信できません。シークレットはメモリにのみ保持され、Key・本人情報・Proxy の変更またはページを離れると消去されます。',
		priority: '優先度 {{priority}}',
		stop: '停止',
		send: '送信',
		firstByteLatency: '応答ヘッダー / 最初のバイトまでの時間',
		imageLimits:
			'参照画像は最大 {{max}} 枚、各ファイルは {{bytes}} バイト以下です。',
		invalidImages: '参照画像の数・サイズ・形式が制限を満たしていません。',
		audioLimit: '音声ファイルの上限：{{bytes}} バイト。',
		invalidAudio: '音声ファイルがサイズ上限を超えています。',
		multimodalHttpHint:
			'この操作は DashScope マルチモーダル HTTP を使用します。JSON 本文で公開音声 URL を指定してください。',
		realtimeUnavailable: 'この選択で利用できるリアルタイム操作はありません。',
		realtimeTtsRejected:
			'現在の Proxy は課金ライフサイクルが未対応のためリアルタイム TTS を拒否します。実際の試行ではハンドシェイクの拒否を表示します。',
		unknownChargeHint:
			'停止や接続切断は未課金を意味しません。再送信前に実際のリクエストログを確認してください。自動再試行は行いません。',
		handshakeRejected:
			'WebSocket のハンドシェイクは開きませんでした。ブラウザーでは HTTP エラー本文を取得できず、101 応答も受信していません。',
		budgetError:
			'Proxy が予算または残高制限でリクエストを拒否しました。再送信前に生のエラーとログを確認してください。',
		actualRequest: '実際のリクエスト記録',
		generationId: 'Generation ID',
		imageNumber: '生成画像 {{number}}',
		toolNames: {
			webSearch: 'ウェブ検索',
			webFetch: 'ウェブ取得',
			webDeepSearch: '詳細検索',
			aiDetection: 'AI 検出',
		},
		outcomes: {
			running: '受信中…',
			complete: '完了',
			failed: 'リクエスト失敗',
			cancelled: '停止済み、課金された可能性があります',
			unknown: '結果不明、課金された可能性があります',
		},
	},
	ko: {
		loading: '불러오는 중…',
		contextError: '시뮬레이터 모델 및 라우트 정보를 불러오지 못했습니다.',
		keysError: 'Key 목록을 불러오지 못했습니다.',
		keysForbidden: 'Key 목록을 읽으려면 user_keys.read 권한이 필요합니다.',
		accessDenied: '검증된 Console 세션이 필요합니다.',
		invalidTarget: '시뮬레이터 링크에 잘못된 선택이 포함되어 있습니다.',
		clearTarget: '선택 지우기',
		keyPages: 'Key 목록 페이지',
		previous: '이전',
		next: '다음',
		page: '{{page}} 페이지',
		owner: '소유자',
		workspace: '워크스페이스',
		keyBudget: 'Key 사용액 / 한도',
		originalSecret: 'Gateway Key 원본 시크릿',
		verifySecret: '시크릿 검증',
		verifying: '검증 중…',
		secretVerified: '이 Key, 소유자 및 워크스페이스와의 연결을 검증했습니다.',
		secretError:
			'선택한 Key와 시크릿의 연결을 검증하지 못했습니다. 원본 시크릿을 다시 입력하세요.',
		secretRequired:
			'Key를 선택하고 원본 시크릿을 입력하여 검증한 뒤 전송하세요.',
		secretMemoryHint:
			'Gateway Key는 해시로 저장됩니다. 생성할 때 저장한 원본 시크릿을 사용하세요. 마스킹된 값은 전송할 수 없습니다. 시크릿은 메모리에만 보관되며 Key, 신원 또는 Proxy가 변경되거나 페이지를 떠나면 삭제됩니다.',
		priority: '우선순위 {{priority}}',
		stop: '중지',
		send: '전송',
		firstByteLatency: '응답 헤더 / 첫 바이트까지 걸린 시간',
		imageLimits: '참조 이미지 최대 {{max}}개, 각 파일 최대 {{bytes}}바이트.',
		invalidImages:
			'참조 이미지의 수, 크기 또는 형식이 제한을 충족하지 않습니다.',
		audioLimit: '오디오 파일 한도: {{bytes}}바이트.',
		invalidAudio: '오디오 파일이 허용 크기를 초과했습니다.',
		multimodalHttpHint:
			'이 작업은 DashScope 멀티모달 HTTP를 사용합니다. JSON 본문에 공개 오디오 URL을 설정하세요.',
		realtimeUnavailable: '현재 선택에는 사용 가능한 실시간 작업이 없습니다.',
		realtimeTtsRejected:
			'현재 Proxy는 과금 수명 주기가 지원되지 않아 실시간 TTS를 거부합니다. 실제 시도에서는 핸드셰이크 거부를 표시합니다.',
		unknownChargeHint:
			'중지하거나 연결이 끊겼다고 해서 과금되지 않았음을 보장하지는 않습니다. 다시 보내기 전에 실제 요청 로그를 확인하세요. 자동 재시도는 수행하지 않습니다.',
		handshakeRejected:
			'WebSocket 핸드셰이크가 열리지 않았습니다. 브라우저에서는 HTTP 오류 본문에 접근할 수 없으며 101 응답을 받지 않았습니다.',
		budgetError:
			'Proxy가 예산 또는 잔액 제한으로 요청을 거부했습니다. 다시 보내기 전에 원본 오류와 요청 로그를 확인하세요.',
		actualRequest: '실제 요청 스냅샷',
		generationId: 'Generation ID',
		imageNumber: '생성된 이미지 {{number}}',
		toolNames: {
			webSearch: '웹 검색',
			webFetch: '웹 가져오기',
			webDeepSearch: '심층 검색',
			aiDetection: 'AI 감지',
		},
		outcomes: {
			running: '수신 중…',
			complete: '완료',
			failed: '요청 실패',
			cancelled: '중지됨, 과금되었을 수 있습니다',
			unknown: '결과 불명, 과금되었을 수 있습니다',
		},
	},
} as const
export const adminSimulatorMessages = {
	en: { ...simulatorLegacyMessages.en, ...simulatorAdditionalMessages.en },
	zh: { ...simulatorLegacyMessages.zh, ...simulatorAdditionalMessages.zh },
	ja: { ...simulatorLegacyMessages.ja, ...simulatorAdditionalMessages.ja },
	ko: { ...simulatorLegacyMessages.ko, ...simulatorAdditionalMessages.ko },
} as const
