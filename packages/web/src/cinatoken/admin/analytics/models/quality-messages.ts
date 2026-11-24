/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
const en = {
	stream_tokens_per_second: 'Stream tokens/s',
	failover_request_rate: 'Requests with failover',
	qualityUnavailable: 'Not reported',
	noStreamSamples: 'No measured streams',
	streamSamples: 'Samples: {{samples}}',
	failoverRequests: 'Requests: {{requests}}',
	qualityHelp: 'How these metrics are calculated',
	streamDefinition:
		'Stream tokens/s divides output tokens by measured stream time, using only successful requests with a positive stream duration for both totals. Samples counts those requests. Legacy tokens/s uses all output tokens and stream durations, so the values can differ.',
	failoverDefinition:
		'Requests with failover is the percentage of requests with at least one upstream failover (0–100%). Failover events divides the total number of failovers by all requests and can exceed 100%.',
	qualityUnavailableHint:
		'Not reported means the server did not provide this metric. No measured streams means there are zero eligible samples; it does not mean the speed is zero. CSV leaves unavailable values blank.',
}
const zh: typeof en = {
	stream_tokens_per_second: '流式 Token/秒',
	failover_request_rate: '故障转移请求占比',
	qualityUnavailable: '未提供',
	noStreamSamples: '无实测流式样本',
	streamSamples: '样本数：{{samples}}',
	failoverRequests: '请求数：{{requests}}',
	qualityHelp: '指标计算口径',
	streamDefinition:
		'流式 Token/秒使用成功且流时长大于零的请求，以这些请求的输出 Token 总数除以实测流时长总和。样本数是符合条件的请求数。旧版 Token/秒使用全部输出 Token 和流时长，两者数值可能不同。',
	failoverDefinition:
		'故障转移请求占比是至少发生一次上游故障转移的请求占全部请求的百分比（0–100%）。故障转移事件率使用转移总次数除以全部请求数，可能超过 100%。',
	qualityUnavailableHint:
		'“未提供”表示服务端未返回该指标。“无实测流式样本”表示符合条件的样本为零，不代表速度为零。CSV 中不可用的值留空。',
}
const ja: typeof en = {
	stream_tokens_per_second: 'ストリーム Token/秒',
	failover_request_rate: 'フェイルオーバーしたリクエスト',
	qualityUnavailable: '未提供',
	noStreamSamples: '実測ストリームなし',
	streamSamples: 'サンプル数：{{samples}}',
	failoverRequests: 'リクエスト数：{{requests}}',
	qualityHelp: '指標の計算方法',
	streamDefinition:
		'ストリーム Token/秒は、成功しストリーム時間が正のリクエストのみを対象に、出力 Token の合計を実測ストリーム時間の合計で割ります。サンプル数は対象リクエスト数です。従来の Token/秒は全出力 Token とストリーム時間を使うため、値が異なる場合があります。',
	failoverDefinition:
		'フェイルオーバーしたリクエストは、上流フェイルオーバーが1回以上発生したリクエストの割合（0–100%）です。イベント率は総フェイルオーバー回数を全リクエスト数で割るため、100%を超える場合があります。',
	qualityUnavailableHint:
		'未提供はサーバーが指標を返していない状態です。実測ストリームなしは対象サンプルがゼロであり、速度ゼロを意味しません。CSVでは利用できない値を空欄にします。',
}
const ko: typeof en = {
	stream_tokens_per_second: '스트림 Token/초',
	failover_request_rate: '장애 조치 요청 비율',
	qualityUnavailable: '미제공',
	noStreamSamples: '실측 스트림 없음',
	streamSamples: '표본 수: {{samples}}',
	failoverRequests: '요청 수: {{requests}}',
	qualityHelp: '지표 계산 방식',
	streamDefinition:
		'스트림 Token/초는 성공하고 스트림 시간이 양수인 요청만 사용하여 출력 Token 합계를 실측 스트림 시간 합계로 나눕니다. 표본 수는 이 조건에 해당하는 요청 수입니다. 기존 Token/초는 전체 출력 Token과 스트림 시간을 사용하므로 값이 다를 수 있습니다.',
	failoverDefinition:
		'장애 조치 요청 비율은 상위 장애 조치가 한 번 이상 발생한 요청의 비율(0–100%)입니다. 이벤트 비율은 총 장애 조치 횟수를 전체 요청 수로 나누므로 100%를 초과할 수 있습니다.',
	qualityUnavailableHint:
		'미제공은 서버가 해당 지표를 반환하지 않았다는 뜻입니다. 실측 스트림 없음은 대상 표본이 0개이며 속도가 0이라는 뜻은 아닙니다. CSV에서 사용할 수 없는 값은 비워 둡니다.',
}
export const analyticsQualityMessages = { en, zh, ja, ko }
