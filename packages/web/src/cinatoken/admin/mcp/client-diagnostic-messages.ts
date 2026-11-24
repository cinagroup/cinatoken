/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
export const mcpClientDiagnosticMessages = {
	en: {
		clientHttpError:
			'The server returned an HTTP error. Check the response details.',
		clientRpcError:
			'The server returned a JSON-RPC error. Check the response details.',
		clientTimeout:
			'The request timed out. Any available response details are shown below.',
		clientNetwork:
			'The response could not be read. Check the connection and response details.',
		clientTooLarge:
			'The response exceeds the processing limit. The body is unavailable.',
		clientHttpStatus: 'HTTP status',
		clientNoStatus: 'No HTTP response',
		clientElapsed: 'Elapsed time',
		clientMilliseconds: '{{value}} ms',
		clientResponseHeaders: 'Response headers',
		clientHeadersHint:
			'Only supported diagnostic headers exposed by the browser are shown. Long values may be shortened.',
		clientNoHeaders: 'No diagnostic headers are available.',
		clientResponseBody: 'Response body',
		copyResponse: 'Copy response body',
		clientCopyHint:
			'Copies the displayed, redacted response body. If truncated, only the displayed part is copied.',
		clientBodyTruncated:
			'The response body is truncated to {{limit}} characters.',
		clientBodyUnavailable:
			'The response body is unavailable because it could not be read completely or displayed safely.',
		clientEmptyBody: 'The response body is empty.',
	},
	zh: {
		clientHttpError: '服务器返回了 HTTP 错误，请查看响应详情。',
		clientRpcError: '服务器返回了 JSON-RPC 错误，请查看响应详情。',
		clientTimeout: '请求超时，可用的响应详情显示在下方。',
		clientNetwork: '无法读取响应，请检查连接和响应详情。',
		clientTooLarge: '响应超出处理上限，正文不可用。',
		clientHttpStatus: 'HTTP 状态',
		clientNoStatus: '未收到 HTTP 响应',
		clientElapsed: '耗时',
		clientMilliseconds: '{{value}} 毫秒',
		clientResponseHeaders: '响应头',
		clientHeadersHint:
			'仅显示浏览器可访问且支持诊断的响应头，过长的值可能被截断。',
		clientNoHeaders: '没有可用的诊断响应头。',
		clientResponseBody: '响应正文',
		copyResponse: '复制响应正文',
		clientCopyHint: '复制当前显示的脱敏正文；正文被截断时，仅复制显示的部分。',
		clientBodyTruncated: '响应正文已截断，最多显示 {{limit}} 个字符。',
		clientBodyUnavailable: '响应正文未能完整读取或安全显示，因此不可用。',
		clientEmptyBody: '响应正文为空。',
	},
	ja: {
		clientHttpError:
			'サーバーが HTTP エラーを返しました。応答の詳細を確認してください。',
		clientRpcError:
			'サーバーが JSON-RPC エラーを返しました。応答の詳細を確認してください。',
		clientTimeout:
			'リクエストがタイムアウトしました。取得できた応答の詳細を以下に表示します。',
		clientNetwork:
			'応答を読み取れませんでした。接続と応答の詳細を確認してください。',
		clientTooLarge: '応答が処理上限を超えています。本文は表示できません。',
		clientHttpStatus: 'HTTP ステータス',
		clientNoStatus: 'HTTP 応答なし',
		clientElapsed: '経過時間',
		clientMilliseconds: '{{value}} ミリ秒',
		clientResponseHeaders: '応答ヘッダー',
		clientHeadersHint:
			'ブラウザーから取得できる対応済みの診断ヘッダーのみ表示します。長い値は省略される場合があります。',
		clientNoHeaders: '表示できる診断ヘッダーはありません。',
		clientResponseBody: '応答本文',
		copyResponse: '応答本文をコピー',
		clientCopyHint:
			'表示中の機密情報を伏せた本文をコピーします。省略されている場合は表示部分のみコピーします。',
		clientBodyTruncated: '応答本文は {{limit}} 文字に切り詰められています。',
		clientBodyUnavailable:
			'応答本文を完全に読み取れなかったか、安全に表示できないため、利用できません。',
		clientEmptyBody: '応答本文は空です。',
	},
	ko: {
		clientHttpError:
			'서버가 HTTP 오류를 반환했습니다. 응답 세부 정보를 확인하세요.',
		clientRpcError:
			'서버가 JSON-RPC 오류를 반환했습니다. 응답 세부 정보를 확인하세요.',
		clientTimeout:
			'요청 시간이 초과되었습니다. 사용 가능한 응답 세부 정보가 아래에 표시됩니다.',
		clientNetwork:
			'응답을 읽을 수 없습니다. 연결과 응답 세부 정보를 확인하세요.',
		clientTooLarge: '응답이 처리 한도를 초과하여 본문을 사용할 수 없습니다.',
		clientHttpStatus: 'HTTP 상태',
		clientNoStatus: 'HTTP 응답 없음',
		clientElapsed: '소요 시간',
		clientMilliseconds: '{{value}} 밀리초',
		clientResponseHeaders: '응답 헤더',
		clientHeadersHint:
			'브라우저에서 접근 가능한 지원 진단 헤더만 표시합니다. 긴 값은 잘릴 수 있습니다.',
		clientNoHeaders: '사용 가능한 진단 헤더가 없습니다.',
		clientResponseBody: '응답 본문',
		copyResponse: '응답 본문 복사',
		clientCopyHint:
			'표시된 민감 정보가 가려진 본문을 복사합니다. 잘린 경우 표시된 부분만 복사합니다.',
		clientBodyTruncated: '응답 본문이 {{limit}}자로 잘렸습니다.',
		clientBodyUnavailable:
			'응답 본문을 완전히 읽거나 안전하게 표시할 수 없어 사용할 수 없습니다.',
		clientEmptyBody: '응답 본문이 비어 있습니다.',
	},
}
