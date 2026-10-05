/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { NEW_API_FRONTEND_ATTRIBUTION } from '../frontend-attribution'

const en = {
	metadata: {
		title: 'cinatoken · AI capability gateway',
		description:
			'Connect models, images, audio, and agent tools through one gateway with controlled routing, budgets, logs, and analytics.',
	},
	logoAlt: 'cinatoken logo',
	nav: {
		label: 'Homepage navigation',
		homeLabel: 'Back to the cinatoken homepage',
		features: 'Features',
		architecture: 'Architecture',
		deployment: 'Deployment',
		docs: 'Docs',
		console: 'Open console',
		portal: 'User Portal',
	},
	theme: {
		label: 'Color mode',
		light: 'Light',
		dark: 'Dark',
		system: 'System',
	},
	hero: {
		titleLine1: 'One gateway for',
		titleLine2: 'every AI capability',
		description:
			'Connect models, images, audio, and agent tools through controlled routing, budgets, and end-to-end observability.',
		console: 'Open console',
		docs: 'View docs',
	},
	demo: {
		tabsLabel: 'API examples',
		chat: 'Chat',
		responses: 'Responses',
		images: 'Images',
		tools: 'Tools',
		request: 'Request',
		response: 'Response',
		routeStable: 'route stable',
		illustration: 'Illustrative examples only. No request is sent.',
	},
	features: {
		title: 'An AI capability gateway built for builders',
		description:
			'Flexible access, intelligent routing, controlled cost, and end-to-end observability.',
		items: {
			protocols: {
				title: 'Unified protocols',
				description:
					'Use one Gateway Base URL for model inference, media capabilities, and agent tools.',
				detail: 'Chat · Responses · Images · Audio · Tools',
			},
			routing: {
				title: 'Intelligent routing',
				description:
					'Send each request surface into a route pool and fail over safely across upstream targets.',
				detail: 'Priority · Weight · Failover · Sticky routing',
			},
			budgets: {
				title: 'Budgets and keys',
				description:
					'Issue separate keys to real consumers and control cost with periodic budgets and actual usage.',
				detail: 'Users · API keys · Periodic budgets · Three ledgers',
			},
			observability: {
				title: 'Logs and analytics',
				description:
					'Record request paths and budget events, then inspect usage, cost, and quality from multiple dimensions.',
				detail: 'Request logs · Audit logs · Model/provider/user analytics',
			},
		},
	},
	steps: {
		title: 'From provider to reliable traffic in four steps',
		items: {
			providers: {
				title: 'Connect providers',
				description: 'Configure upstream endpoints and credentials',
			},
			routes: {
				title: 'Publish models and routes',
				description: 'Define protocol surfaces, route pools, and failover',
			},
			keys: {
				title: 'Issue user keys',
				description:
					'Assign API keys and budgets by user, project, or customer',
			},
			observe: {
				title: 'Observe every call',
				description: 'Continuously improve with logs, audits, and analytics',
			},
		},
	},
	deployment: {
		title: 'Run on your infrastructure',
		cloudflare:
			'Deploy the proxy and admin console on Cloudflare with Workers and D1.',
		docker:
			'Self-host with Postgres or MySQL and keep control of the data plane and runtime.',
	},
	cta: {
		title: 'Ready to unify your AI capabilities?',
		description:
			'Start with one endpoint, then add models, media capabilities, and agent tools as you grow.',
		console: 'Open console',
		deploymentDocs: 'View deployment docs',
	},
	footer: {
		description: 'AI capability gateway and operations control plane',
	},
	attribution: {
		statement: NEW_API_FRONTEND_ATTRIBUTION,
		originalProject: 'Original project',
		sourceDownload: 'Frontend source',
	},
}

const zh: typeof en = {
	metadata: {
		title: 'cinatoken · AI 能力网关',
		description:
			'统一接入模型、图片、音频与智能体工具，并通过路由、预算、日志和分析稳定运行 AI 调用。',
	},
	logoAlt: 'cinatoken 标志',
	nav: {
		label: '首页导航',
		homeLabel: '返回 cinatoken 首页',
		features: '功能',
		architecture: '架构',
		deployment: '部署',
		docs: '文档',
		console: '进入控制台',
		portal: '用户中心',
	},
	theme: {
		label: '显示模式',
		light: '浅色',
		dark: '深色',
		system: '跟随系统',
	},
	hero: {
		titleLine1: '一个入口，',
		titleLine2: '连接你的全部 AI 能力',
		description:
			'统一接入模型、图片、音频与智能体工具，用可控路由、预算和可观测性稳定运行每一次调用。',
		console: '进入控制台',
		docs: '查看文档',
	},
	demo: {
		tabsLabel: 'API 示例',
		chat: 'Chat',
		responses: 'Responses',
		images: 'Images',
		tools: 'Tools',
		request: '请求',
		response: '响应',
		routeStable: '路由稳定',
		illustration: '仅为请求与响应示例，不会发送实际请求。',
	},
	features: {
		title: '为构建者设计的 AI 能力网关',
		description: '灵活接入、智能路由、可控成本、全链路可观测。',
		items: {
			protocols: {
				title: '统一协议',
				description:
					'使用一个 Gateway Base URL 接入模型推理、媒体能力与智能体工具。',
				detail: 'Chat · Responses · Images · Audio · Tools',
			},
			routing: {
				title: '智能路由',
				description:
					'按请求入口进入路由池，在多个上游目标之间稳定选路并自动故障转移。',
				detail: '优先级 · 权重 · 故障转移 · 粘性路由',
			},
			budgets: {
				title: '预算与密钥',
				description:
					'面向实际使用方签发独立密钥，按周期预算和真实用量控制成本。',
				detail: '用户 · API Key · 周期预算 · 三账本',
			},
			observability: {
				title: '日志与分析',
				description:
					'记录调用链路和预算事件，从多维度观察用量、成本和运行质量。',
				detail: '请求日志 · 审计日志 · 模型/供应商/用户分析',
			},
		},
	},
	steps: {
		title: '从供应商到稳定调用，只需四步',
		items: {
			providers: {
				title: '连接供应商',
				description: '配置上游端点与密钥',
			},
			routes: {
				title: '发布模型与路由',
				description: '定义协议入口、路由池与故障转移',
			},
			keys: {
				title: '签发用户密钥',
				description: '按用户、项目或客户分配 API Key 与预算',
			},
			observe: {
				title: '观察每次调用',
				description: '通过日志、审计与分析持续优化',
			},
		},
	},
	deployment: {
		title: '在你的基础设施上运行',
		cloudflare: '使用 Workers 与 D1 在 Cloudflare 上部署代理服务和管理后台。',
		docker: '使用 Postgres 或 MySQL 自托管，掌控数据面和运行环境。',
	},
	cta: {
		title: '准备好统一你的 AI 能力了吗？',
		description: '从一个入口开始，逐步接入模型、媒体能力与智能体工具。',
		console: '进入控制台',
		deploymentDocs: '查看部署文档',
	},
	footer: {
		description: 'AI 能力网关与运营控制面',
	},
	attribution: {
		statement: '前端设计与开发由 New API 贡献者完成。',
		originalProject: '原始项目',
		sourceDownload: '前端源码',
	},
}

const ja: typeof en = {
	metadata: {
		title: 'cinatoken · AI ケイパビリティゲートウェイ',
		description:
			'モデル、画像、音声、エージェントツールを一つのゲートウェイに接続し、ルーティング、予算、ログ、分析で安定運用します。',
	},
	logoAlt: 'cinatoken ロゴ',
	nav: {
		label: 'ホームページナビゲーション',
		homeLabel: 'cinatoken ホームへ戻る',
		features: '機能',
		architecture: 'アーキテクチャ',
		deployment: 'デプロイ',
		docs: 'ドキュメント',
		console: 'コンソールへ',
		portal: 'ユーザーセンター',
	},
	theme: {
		label: '表示モード',
		light: 'ライト',
		dark: 'ダーク',
		system: 'システム',
	},
	hero: {
		titleLine1: 'すべての AI 機能を、',
		titleLine2: '一つの入口から',
		description:
			'モデル、画像、音声、エージェントツールを統合し、制御可能なルーティング、予算、可観測性で安定運用します。',
		console: 'コンソールへ',
		docs: 'ドキュメントを見る',
	},
	demo: {
		tabsLabel: 'API サンプル',
		chat: 'Chat',
		responses: 'Responses',
		images: 'Images',
		tools: 'Tools',
		request: 'リクエスト',
		response: 'レスポンス',
		routeStable: 'ルート安定',
		illustration:
			'リクエストとレスポンスの例です。実際のリクエストは送信されません。',
	},
	features: {
		title: 'ビルダーのための AI ケイパビリティゲートウェイ',
		description:
			'柔軟な接続、インテリジェントなルーティング、コスト制御、エンドツーエンドの可観測性。',
		items: {
			protocols: {
				title: '統一プロトコル',
				description:
					'一つの Gateway Base URL からモデル推論、メディア機能、エージェントツールを利用できます。',
				detail: 'Chat · Responses · Images · Audio · Tools',
			},
			routing: {
				title: 'インテリジェントルーティング',
				description:
					'各リクエスト入口をルートプールへ送り、複数のアップストリーム間で安全にフェイルオーバーします。',
				detail: '優先度 · Weight · フェイルオーバー · Sticky routing',
			},
			budgets: {
				title: '予算とキー',
				description:
					'利用者ごとにキーを発行し、期間予算と実使用量でコストを管理します。',
				detail: 'ユーザー · API Key · 期間予算 · 3 つの台帳',
			},
			observability: {
				title: 'ログと分析',
				description:
					'呼び出し経路と予算イベントを記録し、利用量、コスト、品質を多角的に確認します。',
				detail: 'リクエストログ · 監査ログ · モデル/Provider/ユーザー分析',
			},
		},
	},
	steps: {
		title: 'Provider から安定した呼び出しまで、4 ステップ',
		items: {
			providers: {
				title: 'Provider を接続',
				description: 'アップストリームのエンドポイントと認証情報を設定',
			},
			routes: {
				title: 'モデルとルートを公開',
				description: 'プロトコル入口、ルートプール、フェイルオーバーを定義',
			},
			keys: {
				title: 'ユーザーキーを発行',
				description:
					'ユーザー、プロジェクト、顧客ごとに API Key と予算を割り当て',
			},
			observe: {
				title: 'すべての呼び出しを観測',
				description: 'ログ、監査、分析で継続的に改善',
			},
		},
	},
	deployment: {
		title: '自分のインフラで実行',
		cloudflare:
			'Workers と D1 を使って Proxy と管理コンソールを Cloudflare にデプロイします。',
		docker:
			'Postgres または MySQL でセルフホストし、データプレーンと実行環境を管理します。',
	},
	cta: {
		title: 'AI 機能を統合する準備はできましたか？',
		description:
			'一つの入口から始め、モデル、メディア機能、エージェントツールを段階的に追加できます。',
		console: 'コンソールへ',
		deploymentDocs: 'デプロイドキュメントを見る',
	},
	footer: {
		description: 'AI ケイパビリティゲートウェイと運用コントロールプレーン',
	},
	attribution: {
		statement:
			'フロントエンドのデザインと開発は New API の貢献者によるものです。',
		originalProject: '元のプロジェクト',
		sourceDownload: 'フロントエンドのソース',
	},
}

const ko: typeof en = {
	metadata: {
		title: 'cinatoken · AI 기능 게이트웨이',
		description:
			'모델, 이미지, 오디오, 에이전트 도구를 하나의 게이트웨이에 연결하고 라우팅, 예산, 로그, 분석으로 안정적으로 운영합니다.',
	},
	logoAlt: 'cinatoken 로고',
	nav: {
		label: '홈페이지 탐색',
		homeLabel: 'cinatoken 홈으로 돌아가기',
		features: '기능',
		architecture: '아키텍처',
		deployment: '배포',
		docs: '문서',
		console: '콘솔 열기',
		portal: '사용자 센터',
	},
	theme: {
		label: '표시 모드',
		light: '라이트',
		dark: '다크',
		system: '시스템',
	},
	hero: {
		titleLine1: '모든 AI 기능을 연결하는',
		titleLine2: '하나의 게이트웨이',
		description:
			'모델, 이미지, 오디오, 에이전트 도구를 통합하고 제어 가능한 라우팅, 예산, 관측성으로 모든 호출을 안정적으로 운영하세요.',
		console: '콘솔 열기',
		docs: '문서 보기',
	},
	demo: {
		tabsLabel: 'API 예제',
		chat: 'Chat',
		responses: 'Responses',
		images: 'Images',
		tools: 'Tools',
		request: '요청',
		response: '응답',
		routeStable: '라우트 안정',
		illustration: '요청과 응답 예시이며 실제 요청은 전송하지 않습니다.',
	},
	features: {
		title: '빌더를 위한 AI 기능 게이트웨이',
		description: '유연한 연결, 지능형 라우팅, 비용 제어, 엔드투엔드 관측성.',
		items: {
			protocols: {
				title: '통합 프로토콜',
				description:
					'하나의 Gateway Base URL로 모델 추론, 미디어 기능, 에이전트 도구를 사용합니다.',
				detail: 'Chat · Responses · Images · Audio · Tools',
			},
			routing: {
				title: '지능형 라우팅',
				description:
					'각 요청 진입점을 라우트 풀로 보내고 여러 업스트림 대상 간에 안전하게 장애 조치합니다.',
				detail: '우선순위 · 가중치 · 장애 조치 · 고정 라우팅',
			},
			budgets: {
				title: '예산과 키',
				description:
					'실제 사용자에게 별도 키를 발급하고 주기 예산과 실제 사용량으로 비용을 제어합니다.',
				detail: '사용자 · API Key · 주기 예산 · 3개 원장',
			},
			observability: {
				title: '로그와 분석',
				description:
					'호출 경로와 예산 이벤트를 기록하고 사용량, 비용, 품질을 여러 관점에서 확인합니다.',
				detail: '요청 로그 · 감사 로그 · 모델/Provider/사용자 분석',
			},
		},
	},
	steps: {
		title: 'Provider 연결부터 안정적인 호출까지 4단계',
		items: {
			providers: {
				title: 'Provider 연결',
				description: '업스트림 엔드포인트와 자격 증명 구성',
			},
			routes: {
				title: '모델과 라우트 게시',
				description: '프로토콜 진입점, 라우트 풀, 장애 조치 정의',
			},
			keys: {
				title: '사용자 키 발급',
				description: '사용자, 프로젝트, 고객별 API Key와 예산 할당',
			},
			observe: {
				title: '모든 호출 관측',
				description: '로그, 감사, 분석으로 지속적으로 개선',
			},
		},
	},
	deployment: {
		title: '자체 인프라에서 실행',
		cloudflare:
			'Workers와 D1을 사용해 Proxy와 관리 콘솔을 Cloudflare에 배포합니다.',
		docker:
			'Postgres 또는 MySQL로 셀프 호스팅하고 데이터 플레인과 런타임을 직접 제어합니다.',
	},
	cta: {
		title: 'AI 기능을 통합할 준비가 되셨나요?',
		description:
			'하나의 진입점에서 시작해 모델, 미디어 기능, 에이전트 도구를 단계적으로 추가하세요.',
		console: '콘솔 열기',
		deploymentDocs: '배포 문서 보기',
	},
	footer: {
		description: 'AI 기능 게이트웨이 및 운영 제어 플레인',
	},
	attribution: {
		statement: '프런트엔드 디자인과 개발은 New API 기여자가 수행했습니다.',
		originalProject: '원본 프로젝트',
		sourceDownload: '프런트엔드 소스',
	},
}

export type PublicHomeMessages = typeof en
export const publicHomeMessages = { en, zh, ja, ko }
