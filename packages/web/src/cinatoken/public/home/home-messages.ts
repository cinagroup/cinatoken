/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
const en = {
	nav: {
		label: 'Homepage navigation',
		features: 'Features',
		architecture: 'Setup',
		deployment: 'Deployment',
		docs: 'Docs',
		signIn: 'Sign in',
	},
	hero: {
		console: 'Console',
		docs: 'Integration docs',
	},
	demo: {
		tabsLabel: 'API examples',
		request: 'Request',
		response: 'Response',
		illustration: 'API examples. No request is sent.',
		chat: 'Chat',
		responses: 'Responses',
		images: 'Images',
		tools: 'Tools',
	},
	features: {
		title: 'Access and management',
		description: 'Configure what you need, from model calls to usage reports.',
		items: {
			protocols: {
				title: 'One API',
				description:
					'Call chat, image, audio and tool endpoints through the same address.',
			},
			routing: {
				title: 'Routing',
				description: 'Configure upstream priorities, weights and failover.',
			},
			budgets: {
				title: 'Keys and budgets',
				description: 'Give each project its own keys and usage budget.',
			},
			observability: {
				title: 'Request records',
				description: 'Look up requests, usage and costs to investigate issues.',
			},
		},
	},
	steps: {
		title: 'Get connected',
		items: {
			providers: {
				title: 'Connect providers',
				description: 'Configure upstream endpoints and credentials',
			},
			routes: {
				title: 'Publish models and routes',
				description: 'Define protocol endpoints, route pools and failover',
			},
			keys: {
				title: 'Issue user keys',
				description: 'Assign API keys and budgets by user, project or customer',
			},
			observe: {
				title: 'Review requests',
				description: 'Look up logs, usage and costs',
			},
		},
	},
	deployment: {
		title: 'Self-hosting',
		cloudflare:
			'Deploy the proxy and admin console with Cloudflare Workers and D1.',
		docker: 'Run with Docker and store data in Postgres or MySQL.',
		docs: 'Deployment docs',
	},
	footer: {
		description: 'Model access and usage management',
		navigation: 'Footer navigation',
		sourceDownload: 'Frontend source',
		license: 'Open-source notices',
	},
}

const zh: typeof en = {
	nav: {
		label: '首页导航',
		features: '功能',
		architecture: '架构',
		deployment: '部署',
		docs: '文档',
		signIn: '登录',
	},
	hero: {
		console: '控制台',
		docs: '接入文档',
	},
	demo: {
		tabsLabel: 'API 示例',
		request: '请求',
		response: '响应',
		illustration: '接口示例，不会发送请求。',
		chat: 'Chat',
		responses: 'Responses',
		images: 'Images',
		tools: 'Tools',
	},
	features: {
		title: '接入与管理',
		description: '从模型调用到用量查询，按需配置。',
		items: {
			protocols: {
				title: '统一 API',
				description: '通过同一地址调用对话、图像、音频和工具接口。',
			},
			routing: {
				title: '路由配置',
				description: '配置上游优先级、权重与故障转移。',
			},
			budgets: {
				title: '密钥与预算',
				description: '为不同项目分配密钥，设置各自的使用预算。',
			},
			observability: {
				title: '请求记录',
				description: '查询请求、用量与费用，排查调用问题。',
			},
		},
	},
	steps: {
		title: '开始接入',
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
				title: '查看请求记录',
				description: '查询日志、用量和费用',
			},
		},
	},
	deployment: {
		title: '自行部署',
		cloudflare: '使用 Cloudflare Workers 运行代理与管理后台，D1 存储数据。',
		docker: '使用 Docker 运行服务，Postgres 或 MySQL 存储数据。',
		docs: '查看部署文档',
	},
	footer: {
		description: '模型接入与用量管理',
		navigation: '页脚导航',
		sourceDownload: '前端源码',
		license: '开源许可',
	},
}

const ja: typeof en = {
	nav: {
		label: 'ホームのナビゲーション',
		features: '機能',
		architecture: '設定',
		deployment: 'デプロイ',
		docs: 'ドキュメント',
		signIn: 'ログイン',
	},
	hero: {
		console: 'コンソール',
		docs: '接続ドキュメント',
	},
	demo: {
		tabsLabel: 'API の例',
		request: 'リクエスト',
		response: 'レスポンス',
		illustration: 'API の例です。実際のリクエストは送信しません。',
		chat: 'Chat',
		responses: 'Responses',
		images: 'Images',
		tools: 'Tools',
	},
	features: {
		title: '接続と管理',
		description: 'モデルの呼び出しから利用状況の確認まで、必要に応じて設定。',
		items: {
			protocols: {
				title: '共通 API',
				description:
					'同じアドレスで対話、画像、音声、ツールの API を呼び出せます。',
			},
			routing: {
				title: 'ルーティング',
				description: '接続先の優先度、重み、フェイルオーバーを設定します。',
			},
			budgets: {
				title: 'キーと予算',
				description: 'プロジェクトごとにキーと利用予算を割り当てます。',
			},
			observability: {
				title: 'リクエスト記録',
				description: 'リクエスト、利用量、費用を確認し、問題を調べます。',
			},
		},
	},
	steps: {
		title: '接続の手順',
		items: {
			providers: {
				title: 'プロバイダーを接続',
				description: '接続先のエンドポイントと認証情報を設定',
			},
			routes: {
				title: 'モデルとルートを公開',
				description: 'API の入口、ルートプール、フェイルオーバーを定義',
			},
			keys: {
				title: 'ユーザーキーを発行',
				description: 'ユーザー、プロジェクト、顧客ごとにキーと予算を割り当て',
			},
			observe: {
				title: '記録を確認',
				description: 'ログ、利用量、費用を確認',
			},
		},
	},
	deployment: {
		title: 'セルフホスト',
		cloudflare:
			'Cloudflare Workers で Proxy と管理画面を実行し、D1 にデータを保存します。',
		docker:
			'Docker でサービスを実行し、Postgres または MySQL にデータを保存します。',
		docs: 'デプロイドキュメント',
	},
	footer: {
		description: 'モデル接続と利用状況の管理',
		navigation: 'フッターナビゲーション',
		sourceDownload: 'フロントエンドのソース',
		license: 'オープンソースの表記',
	},
}

const ko: typeof en = {
	nav: {
		label: '홈 탐색',
		features: '기능',
		architecture: '설정',
		deployment: '배포',
		docs: '문서',
		signIn: '로그인',
	},
	hero: {
		console: '콘솔',
		docs: '연동 문서',
	},
	demo: {
		tabsLabel: 'API 예제',
		request: '요청',
		response: '응답',
		illustration: 'API 예제입니다. 실제 요청을 보내지 않습니다.',
		chat: 'Chat',
		responses: 'Responses',
		images: 'Images',
		tools: 'Tools',
	},
	features: {
		title: '연결 및 관리',
		description: '모델 호출부터 사용량 조회까지 필요한 항목을 설정하세요.',
		items: {
			protocols: {
				title: '공통 API',
				description: '같은 주소로 대화, 이미지, 오디오, 도구 API를 호출합니다.',
			},
			routing: {
				title: '라우팅',
				description: '업스트림 우선순위, 가중치, 장애 조치를 설정합니다.',
			},
			budgets: {
				title: '키와 예산',
				description: '프로젝트마다 키와 사용 예산을 할당합니다.',
			},
			observability: {
				title: '요청 기록',
				description: '요청, 사용량, 비용을 조회하고 문제를 확인합니다.',
			},
		},
	},
	steps: {
		title: '연결 순서',
		items: {
			providers: {
				title: '공급자 연결',
				description: '업스트림 엔드포인트와 자격 증명 설정',
			},
			routes: {
				title: '모델과 경로 게시',
				description: 'API 진입점, 경로 풀, 장애 조치 정의',
			},
			keys: {
				title: '사용자 키 발급',
				description: '사용자, 프로젝트, 고객별 키와 예산 할당',
			},
			observe: {
				title: '기록 확인',
				description: '로그, 사용량, 비용 조회',
			},
		},
	},
	deployment: {
		title: '직접 배포',
		cloudflare:
			'Cloudflare Workers로 Proxy와 관리 화면을 실행하고 D1에 데이터를 저장합니다.',
		docker:
			'Docker로 서비스를 실행하고 Postgres 또는 MySQL에 데이터를 저장합니다.',
		docs: '배포 문서',
	},
	footer: {
		description: '모델 연결 및 사용량 관리',
		navigation: '바닥글 탐색',
		sourceDownload: '프런트엔드 소스',
		license: '오픈소스 고지',
	},
}

export type PublicHomeMessages = typeof en
export const publicHomeMessages = { en, zh, ja, ko }
