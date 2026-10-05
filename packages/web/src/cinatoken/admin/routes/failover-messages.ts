/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
export const routeFailoverMessages = {
	en: {
		'failover-order':
			"Attempt order: priority tiers high → low; within a tier, order by that tier's route strategy; skip providers in cooldown.",
		'failover-title': 'Failover rules',
		'failover-readonlyHint':
			'These rules are fixed today and not configurable yet.',
		'failover-imagesAbort':
			'Image generation: client cancel or gateway timeout returns 504 and does not fail over to another provider.',
		'failover-circuitCooldown':
			'Provider cooldown: 429 backs off 5s→15s→30s→60s (prefer upstream Retry-After, capped at 15 minutes); 401/403 for 5 minutes; 5xx opens for 10s after 3 consecutive failures.',
		'failover-memoryNote':
			'Cooldown state is in-process memory and is not shared across Cloudflare Worker isolates.',
		'failover-attemptLimit':
			'No fixed retry cap: every active route that is not circuit-open may be tried.',
		'failover-sameLayer':
			'Same-tier failover: 429 / 5xx / 401 / 403 / 524 / network errors try the next candidate; client errors such as 400 / 404 do not switch providers.',
		'failover-allBusy':
			'If every provider is cooling down: gateway returns 429 circuit.upstream_capacity_exhausted with zero upstream calls; honor Retry-After.',
		'failover-crossLayer':
			'Cross-tier failover: after a higher priority tier is exhausted, continue to the next priority tier (operator-defined primary/backup).',
	},
	zh: {
		'failover-order':
			'尝试顺序：按 priority 从高到低分层；层内按该层路由策略排序；跳过冷却中的 Provider。',
		'failover-title': 'Failover 规则',
		'failover-readonlyHint': '当前为固定策略，暂不可配置。',
		'failover-imagesAbort':
			'图片生成：客户端取消或网关超时返回 504，不会 failover 到其他 Provider。',
		'failover-circuitCooldown':
			'Provider 冷却：429 递增 5s→15s→30s→60s（优先上游 Retry-After，封顶 15 分钟）；401/403 固定 5 分钟；5xx 连续 3 次后冷却 10 秒。',
		'failover-memoryNote':
			'冷却状态为单实例内存态，Cloudflare Workers 多 isolate 之间不共享。',
		'failover-attemptLimit':
			'无固定重试次数上限：会尝试所有未熔断的 active 路由。',
		'failover-sameLayer':
			'同层 failover：429 / 5xx / 401 / 403 / 524 / 网络错误会换下一个候选；400 / 404 等客户端错误不会换 Provider。',
		'failover-allBusy':
			'全部冷却时：网关直接返回 429 circuit.upstream_capacity_exhausted（零上游调用），请按 Retry-After 重试。',
		'failover-crossLayer':
			'跨层 failover：高层候选耗尽后进入下一 priority 层（运维配置的主备关系）。',
	},
	ko: {
		'failover-order':
			'시도 순서: priority 높은 계층 → 낮은 계층. 계층 내에서는 해당 계층 라우트 전략으로 정렬. 냉각 중인 Provider는 건너뜁니다.',
		'failover-title': 'Failover 규칙',
		'failover-readonlyHint': '현재는 고정 규칙이며 아직 구성할 수 없습니다.',
		'failover-imagesAbort':
			'이미지 생성: 클라이언트 취소 또는 게이트웨이 타임아웃은 504를 반환하며 다른 Provider로 failover하지 않습니다.',
		'failover-circuitCooldown':
			'Provider 냉각: 429는 5s→15s→30s→60s(업스트림 Retry-After 우선, 최대 15분), 401/403은 5분, 5xx는 연속 3회 후 10초.',
		'failover-memoryNote':
			'냉각 상태는 프로세스 메모리이며 Cloudflare Worker isolate 간에 공유되지 않습니다.',
		'failover-attemptLimit':
			'고정 재시도 상한 없음: 회로가 열리지 않은 active 라우트를 모두 시도할 수 있습니다.',
		'failover-sameLayer':
			'동일 계층 failover: 429 / 5xx / 401 / 403 / 524 / 네트워크 오류는 다음 후보로. 400 / 404 등 클라이언트 오류는 Provider를 바꾸지 않습니다.',
		'failover-allBusy':
			'모두 냉각 중이면: 게이트웨이가 업스트림 호출 없이 429 circuit.upstream_capacity_exhausted를 반환합니다. Retry-After를 따르세요.',
		'failover-crossLayer':
			'계층 간 failover: 상위 계층 후보를 모두 소진한 뒤 다음 priority 계층으로 이동합니다(운영자가 설정한 주/백업).',
	},
	ja: {
		'failover-order':
			'試行順：priority が高い層から低い層へ。層内はその層のルート戦略で並べ替え。冷却中の Provider はスキップ。',
		'failover-title': 'Failover ルール',
		'failover-readonlyHint': '現在は固定ルールで、設定変更はできません。',
		'failover-imagesAbort':
			'画像生成：クライアント取消しやゲートウェイタイムアウトは 504 を返し、他 Provider へ failover しません。',
		'failover-circuitCooldown':
			'Provider 冷却：429 は 5s→15s→30s→60s（上流 Retry-After を優先、上限 15 分）、401/403 は 5 分、5xx は連続 3 回で 10 秒。',
		'failover-memoryNote':
			'冷却状態はプロセス内メモリで、Cloudflare Workers の isolate 間では共有されません。',
		'failover-attemptLimit':
			'固定の再試行上限はありません。サーキットが開いていない active ルートをすべて試せます。',
		'failover-sameLayer':
			'同層 failover：429 / 5xx / 401 / 403 / 524 / ネットワークエラーは次候補へ。400 / 404 などのクライアントエラーは Provider を切り替えません。',
		'failover-allBusy':
			'すべて冷却中のとき：ゲートウェイは上流呼び出しなしで 429 circuit.upstream_capacity_exhausted を返し、Retry-After に従ってください。',
		'failover-crossLayer':
			'跨層 failover：上位層の候補を使い切った後、次の priority 層へ進みます（運用で設定する主系/予備）。',
	},
} as const
