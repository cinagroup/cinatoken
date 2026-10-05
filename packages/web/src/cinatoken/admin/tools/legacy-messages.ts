/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
/** Static copies of the existing four-language tool/provider guides. */
export const legacyToolMessages = {
	en: {
		catalog: {
			webSearch: 'Web Search',
			webFetch: 'Web Fetch',
			webDeepSearch: 'Web Deep Search',
			aiDetection: 'AI Detection',
		},
		config: {
			title: 'Tools',
			subtitle:
				'Configure product tools under /v1/tools/* (engine, API key, unit prices). Settings are stored in system_config and share the user chat budget (charged only).',
			viewInvocations: 'View invocations →',
			showSecrets: 'Show API keys',
			hideSecrets: 'Hide API keys',
			saveWebSearch: 'Save web search',
			saveWebFetch: 'Save web fetch',
			saveWebDeepSearch: 'Save web deep search',
			saveAiDetection: 'Save AI detection',
			testInPlayground: 'Test in Playground',
		},
		providerCards: {
			active: 'Active',
			editing: 'Editing',
			unsaved: 'Unsaved',
			missingCredentials: 'Missing credentials',
			unavailable: 'Unavailable',
			lossPricing: 'Loss pricing',
			configured: 'Configured',
			priceLegend: 'S Standard · C Charged · M Metered',
			selectHint:
				'Click a provider to open the configuration drawer. Changes apply only after you save.',
			detailTitle: 'Configure {name}',
			activeSummary: 'Active · {name}',
			noActive: 'No active provider',
			saveConfig: 'Save configuration',
			saveAndActivate: 'Save & activate',
			saveConfigOnly: 'Save config only',
		},
		unitPrices: {
			title: 'Unit prices ({currency})',
			legend: 'Standard → Charged → Metered',
			standard: 'Standard',
			charged: 'Charged',
			metered: 'Metered',
			lossHint: 'Charged is below metered (loss)',
		},
		webSearch: {
			title: 'Web search',
			description:
				'Powers POST /v1/tools/web-search. Choose an implemented engine only—free text is rejected. Leave the API key empty and save to clear it (endpoint returns 503 until set again).',
			descriptionCatalog:
				'Powers POST /v1/tools/web-search. Configure each engine’s API key and three unit prices, then save & activate one card. Only charged hits user budget. Engines without a key cannot be activated.',
			provider: 'Search engine',
			active: 'Active engine',
			catalogProvider: 'Engine',
			noKey: 'no key',
			needKeyToActivate: 'Add an API key to at least one engine before saving.',
			providerGuideLink: 'Engine guide',
			providerDocs: 'Docs & API key →',
			cost: 'Charged per success ({currency})',
			apiKey: 'Provider API key',
			apiKeyPlaceholder: 'Paste engine API key',
			apiKeyHint:
				'Required for the tool to accept traffic. Cleared keys fall back to nothing (no env).',
			providers: {
				bocha: 'Bocha (博查)',
				tavily: 'Tavily',
				cleversee: 'Alibaba CleverSee (开析)',
				tencent_wsa: 'Tencent Cloud WSA',
			},
			providerGuide: {
				title: 'Search engine guide',
				subtitle:
					'Index / sources and when to pick each engine. Not a direct Baidu or Google API.',
				disclaimer:
					'None of these call Baidu or Google official search APIs. Each uses its own or partner web index; result URLs may still point at baidu.com, google.com, etc.',
				selected: 'Currently selected',
				docsLink: 'Docs & API key →',
				labels: {
					sources: 'Sources',
					bestFor: 'Best for',
				},
				items: {
					bocha: {
						badge: 'China preferred',
						summary:
							'AI-oriented Chinese search engine with its own large web index (positioned as a domestic Bing Search API alternative).',
						sources:
							'Hundreds of millions to ~10B web pages plus partner content (news, encyclopedia, short video, weather, academic, etc.). Not Baidu/Google.',
						bestFor:
							'China-region users, Chinese queries, domestic compliance.',
					},
					tavily: {
						badge: 'International preferred',
						summary:
							'LLM-oriented retrieval layer: search + extract + rank in one call. Built for agents/RAG, not a classic SERP dump.',
						sources:
							'Own crawler plus third-party aggregation (often associated with independent indexes such as Brave). Not an official Google/Baidu API.',
						bestFor: 'International region, English research, agent workflows.',
					},
					cleversee: {
						badge: '',
						summary:
							'Alibaba CleverSee (开析) AI-native web search with mainland_china / global region modes.',
						sources:
							'Alibaba’s own AI search index. Docs do not claim Baidu or Google backends. Gateway default is mainland_china; domain allow-lists switch to global.',
						bestFor:
							'When you need an explicit China vs global region switch on Alibaba Cloud.',
					},
					tencent_wsa: {
						badge: '',
						summary:
							'Tencent Cloud Web Search API (WSA), officially based on Sogou Search.',
						sources:
							'Open web via Sogou plus Tencent ecosystem (Tencent News, Sogou Baike, Penguin accounts). Higher tiers add VR/authority verticals.',
						bestFor:
							'China Chinese web as an alternative to Bocha; strong Sogou/Tencent content mix.',
					},
				},
			},
		},
		webFetch: {
			title: 'Web fetch',
			description:
				'Powers POST /v1/tools/web-fetch. Choose an implemented scraper only—free text is rejected. Leave the API key empty and save to clear it (endpoint returns 503 until set again).',
			descriptionCatalog:
				'Powers POST /v1/tools/web-fetch. Configure each scraper’s API key and three unit prices, then save & activate one card. Only charged hits user budget. Scrapers without a key cannot be activated.',
			provider: 'Fetch provider',
			active: 'Active provider',
			catalogProvider: 'Provider',
			noKey: 'no key',
			needKeyToActivate:
				'Add an API key to at least one provider before saving.',
			providerDocs: 'Docs & API key →',
			cost: 'Charged per success ({currency})',
			apiKey: 'Provider API key',
			apiKeyPlaceholder: 'Paste provider API key',
			apiKeyHint:
				'Required for the tool to accept traffic. Cleared keys fall back to nothing (no env).',
			providers: {
				firecrawl: 'Firecrawl',
				tavily: 'Tavily Extract',
				jina: 'Jina Reader',
			},
		},
		webDeepSearch: {
			title: 'Web deep search',
			descriptionCatalog:
				'Powers POST /v1/tools/web-deep-search. Search-and-read engines (Firecrawl Search / Jina Search) return page content with results—heavier and costlier than plain web search. Configure each provider, then save & activate one card.',
			active: 'Active provider',
			catalogProvider: 'Provider',
			noKey: 'no key',
			needKeyToActivate:
				'Add an API key to at least one provider before saving.',
			providerDocs: 'Docs & API key →',
			cost: 'Charged per success ({currency})',
			apiKey: 'Provider API key',
			apiKeyPlaceholder: 'Paste provider API key',
			providers: {
				firecrawl: 'Firecrawl Search',
				jina: 'Jina Search',
			},
		},
		aiDetection: {
			title: 'AI detection',
			descriptionCatalog:
				'Powers POST /v1/tools/ai-detection. Multi-provider catalog: configure credentials and three unit prices per engine, then save & activate one card. Billing is by character units (billingUnitChars); totals scale metered/standard/charged. Currently only Tencent Cloud TMS is implemented.',
			active: 'Active engine',
			catalogProvider: 'Engine',
			noKey: 'no credentials',
			needKeyToActivate:
				'Add credentials to at least one implemented engine before saving.',
			providerDocs: 'Docs & API key →',
			cost: 'Charged per billing unit ({currency})',
			billingUnitChars: 'Billing unit (chars)',
			credentials: 'Credentials',
			fields: {
				apiKey: 'API key',
				secretId: 'SecretId',
				secretKey: 'SecretKey',
				email: 'Email',
				region: 'Region',
				bizType: 'BizType',
				bizTypeOptional: 'Optional BizType',
			},
			providers: {
				tencent_tms: 'Tencent Cloud TMS',
			},
		},
		invocations: {
			title: 'Tool invocations',
			subtitle:
				'Calls billed as provider octafuse-tools (model_id tool:*). Click a row to inspect query and result summary. Same underlying rows as Request Logs.',
			configureTools: 'Configure tools →',
			openInRequestLogs: 'Open in Request Logs',
			toolFilter: 'Tool',
			allTools: 'All tools',
			status: 'Status',
			empty: 'No tool invocations in this range.',
			columns: {
				time: 'Time',
				tool: 'Tool',
				provider: 'Engine',
				query: 'Query',
				user: 'User',
				status: 'Status',
				results: 'Results',
				standard: 'Standard ({currency})',
				charged: 'Charged ({currency})',
				metered: 'Metered ({currency})',
				profit: 'Profit ({currency})',
				latency: 'Latency',
			},
			titles: {
				profit: 'Charged − metered (per call)',
				standard: 'Standard (catalog price)',
				charged: 'Charged (user budget)',
				metered: 'Metered (supplier cost)',
			},
			detail: {
				request: 'Request',
				response: 'Response',
				responseFormat: 'Response format',
				formatList: 'List',
				formatJson: 'JSON',
				noListResults:
					'No list items to show; switch to JSON if a raw payload exists.',
				noResponseStored:
					'No response summary stored (older rows only kept the query, or the call failed before results).',
				hint: 'Response summaries are truncated for ops review; full chat transcripts stay on the client.',
			},
		},
		errors: {
			invalidWebSearchProvider:
				'Search engine must be one of the implemented options.',
			invalidWebSearchCost:
				'Metered, standard, and charged must each be a non-negative number for every engine.',
			invalidWebFetchProvider:
				'Fetch provider must be one of the implemented options.',
			invalidWebFetchCost:
				'Metered, standard, and charged must each be a non-negative number for every provider.',
			invalidWebDeepSearchCost:
				'Metered, standard, and charged must each be a non-negative number for every deep-search provider.',
			invalidAiDetectionCost:
				'Metered, standard, and charged must be non-negative and billing unit chars must be a positive integer for every engine.',
			aiDetectionNotImplemented:
				'Cannot activate an engine that is not implemented yet.',
			noKeyCannotActivate: 'Cannot activate a provider without an API key.',
			switchActiveBeforeClearingKey:
				'Switch Active to another engine that still has a key before clearing the current engine’s key, then save again to clear it.',
		},
	},
	zh: {
		catalog: {
			webSearch: 'Web Search',
			webFetch: 'Web Fetch',
			webDeepSearch: 'Web Deep Search',
			aiDetection: 'AI 率检测',
		},
		config: {
			title: 'Tools',
			subtitle:
				'配置 /v1/tools/* 产品工具（引擎、API Key、三账本单价）。写入 system_config；用户额度仅累加 charged。',
			viewInvocations: '查看调用记录 →',
			showSecrets: '显示密钥',
			hideSecrets: '隐藏密钥',
			saveWebSearch: '保存 Web Search',
			saveWebFetch: '保存 Web Fetch',
			saveWebDeepSearch: '保存 Web Deep Search',
			saveAiDetection: '保存 AI 率检测',
			testInPlayground: '在 Playground 测试',
		},
		providerCards: {
			active: '已启用',
			editing: '正在编辑',
			unsaved: '未保存',
			missingCredentials: '缺少凭证',
			unavailable: '暂不可用',
			lossPricing: '存在亏损',
			configured: '已配置',
			priceLegend: 'S 标准价 · C 用户扣费 · M 供应价',
			selectHint: '点击 Provider 打开右侧配置抽屉；需保存后才会生效。',
			detailTitle: '配置 {name}',
			activeSummary: '已启用 · {name}',
			noActive: '未启用任何引擎',
			saveConfig: '保存配置',
			saveAndActivate: '保存并启用',
			saveConfigOnly: '仅保存配置',
		},
		unitPrices: {
			title: '单价（{currency}）',
			legend: '标准价 → 用户扣费 → 供应价',
			standard: '标准价',
			charged: '用户扣费',
			metered: '供应价',
			lossHint: '用户扣费低于供应价（亏本）',
		},
		webSearch: {
			title: 'Web Search',
			description:
				'供 POST /v1/tools/web-search 使用。仅可选已实现的引擎，禁止自由文本。留空 API Key 并保存将清除密钥（未配置时接口返回 503）。',
			descriptionCatalog:
				'供 POST /v1/tools/web-search 使用。为每个引擎分别配置 API Key 与三账本单价，再「保存并启用」其中一张卡片。仅 charged 计入用户额度；未配置 Key 的引擎不可激活。',
			provider: '搜索引擎',
			active: '当前 Active 引擎',
			catalogProvider: '引擎',
			noKey: '无 Key',
			needKeyToActivate: '请先为至少一个引擎填写 API Key 再保存。',
			providerGuideLink: '引擎说明',
			providerDocs: '官网与 API Key →',
			cost: '用户扣费单价（{currency}）',
			apiKey: '引擎 API Key',
			apiKeyPlaceholder: '粘贴引擎 API Key',
			apiKeyHint: '有流量前必须配置；清除后不会回退到环境变量。',
			providers: {
				bocha: '博查（Bocha）',
				tavily: 'Tavily',
				cleversee: '阿里云 CleverSee（开析）',
				tencent_wsa: '腾讯云联网搜索 WSA',
			},
			providerGuide: {
				title: '搜索引擎说明',
				subtitle: '各引擎的索引 / 信源与适用场景。均非百度或谷歌官方搜索 API。',
				disclaimer:
					'这些引擎都不是直接调用百度 / 谷歌官方搜索 API，而是各自（或合作方）的网页索引；结果链接里仍可能出现 baidu.com、google.com 等站点。',
				selected: '当前已选',
				docsLink: '官网与 API Key →',
				labels: {
					sources: '信源',
					bestFor: '更适合',
				},
				items: {
					bocha: {
						badge: '国内首选',
						summary:
							'面向 AI 的中文搜索引擎，自建大规模网页索引（定位为国内可用的 Bing Search API 替代）。',
						sources:
							'近百亿级网页 + 生态内容（新闻、百科、短视频、天气、学术等）。不是百度 / 谷歌官方 API。',
						bestFor: '中国区用户、中文查询、国内合规场景。',
					},
					tavily: {
						badge: '国际首选',
						summary:
							'面向 LLM 的检索层：搜索 + 抓取精炼 + 排序一次返回，适合 Agent / RAG，而非传统 SERP 列表。',
						sources:
							'自有爬虫 + 第三方聚合（业界常与 Brave 等独立索引关联）。不是谷歌 / 百度官方 API。',
						bestFor: '国际区、英文资料检索、Agent 工作流。',
					},
					cleversee: {
						badge: '',
						summary:
							'阿里云 CleverSee（开析）AI 原生联网搜索，支持 mainland_china / global 信源范围。',
						sources:
							'阿里自研 AI 搜索索引；文档未宣称绑定百度或谷歌。Gateway 默认 mainland_china，配置域名白名单时会切到 global。',
						bestFor: '需要在阿里云上显式切换「国内 / 全球」检索范围时。',
					},
					tencent_wsa: {
						badge: '',
						summary: '腾讯云联网搜索 API（WSA），官方说明底层来自搜狗搜索。',
						sources:
							'搜狗全网公开页 + 腾讯内容生态（腾讯新闻、搜狗百科、企鹅号等）；高版本含 VR / 权威垂域。',
						bestFor: '国内中文检索的博查备选，偏搜狗 / 腾讯内容。',
					},
				},
			},
		},
		webFetch: {
			title: 'Web Fetch',
			description:
				'供 POST /v1/tools/web-fetch 使用。仅可选已实现的抓取引擎，禁止自由文本。留空 API Key 并保存将清除密钥（未配置时接口返回 503）。',
			descriptionCatalog:
				'供 POST /v1/tools/web-fetch 使用。为每个抓取引擎分别配置 API Key 与三账本单价，再「保存并启用」其中一张卡片。仅 charged 计入用户额度；未配置 Key 的引擎不可激活。',
			provider: '抓取引擎',
			active: '当前 Active 引擎',
			catalogProvider: '引擎',
			noKey: '无 Key',
			needKeyToActivate: '请先为至少一个引擎填写 API Key 再保存。',
			providerDocs: '官网与 API Key →',
			cost: '用户扣费单价（{currency}）',
			apiKey: '引擎 API Key',
			apiKeyPlaceholder: '粘贴引擎 API Key',
			apiKeyHint: '有流量前必须配置；清除后不会回退到环境变量。',
			providers: {
				firecrawl: 'Firecrawl',
				tavily: 'Tavily Extract',
				jina: 'Jina Reader',
			},
		},
		webDeepSearch: {
			title: 'Web Deep Search',
			descriptionCatalog:
				'供 POST /v1/tools/web-deep-search 使用。搜+读一体引擎（Firecrawl Search / Jina Search），结果含页面正文，比普通 Web Search 更重、更贵。为每个引擎配置后「保存并启用」其中一张卡片。',
			active: '当前 Active 引擎',
			catalogProvider: '引擎',
			noKey: '无 Key',
			needKeyToActivate: '请先为至少一个引擎填写 API Key 再保存。',
			providerDocs: '官网与 API Key →',
			cost: '用户扣费单价（{currency}）',
			apiKey: '引擎 API Key',
			apiKeyPlaceholder: '粘贴引擎 API Key',
			providers: {
				firecrawl: 'Firecrawl Search',
				jina: 'Jina Search',
			},
		},
		aiDetection: {
			title: 'AI 率检测',
			descriptionCatalog:
				'供 POST /v1/tools/ai-detection 使用。多引擎 catalog：为每个引擎配置凭证与三账本单价后「保存并启用」一张卡片。计费按字符单元（billingUnitChars）缩放三列金额。当前仅实现腾讯云 TMS。',
			active: '当前 Active 引擎',
			catalogProvider: '引擎',
			noKey: '无凭证',
			needKeyToActivate: '请先为至少一个已实现引擎填写凭证再保存。',
			providerDocs: '官网与 API Key →',
			cost: '每计费单元用户扣费（{currency}）',
			billingUnitChars: '计费单元（字符）',
			credentials: '凭证',
			fields: {
				apiKey: 'API Key',
				secretId: 'SecretId',
				secretKey: 'SecretKey',
				email: 'Email',
				region: 'Region',
				bizType: 'BizType',
				bizTypeOptional: '可选 BizType',
			},
			providers: {
				tencent_tms: '腾讯云 TMS',
			},
		},
		invocations: {
			title: '工具调用记录',
			subtitle:
				'记账为 provider octafuse-tools（model_id 为 tool:*）。点击行可查看查询词与结果摘要；与 Request Logs 同源。',
			configureTools: '配置 Tools →',
			openInRequestLogs: '在 Request Logs 中打开',
			toolFilter: '工具',
			allTools: '全部工具',
			status: '状态',
			empty: '该时间范围内没有工具调用。',
			columns: {
				time: '时间',
				tool: '工具',
				provider: '引擎',
				query: '查询',
				user: '用户',
				status: '状态',
				results: '结果数',
				standard: '标准价（{currency}）',
				charged: '用户扣费（{currency}）',
				metered: '供应价（{currency}）',
				profit: '毛利（{currency}）',
				latency: '延迟',
			},
			titles: {
				profit: '用户扣费 − 供应价（单次）',
				standard: '标准价（目录）',
				charged: '用户扣费',
				metered: '供应价',
			},
			detail: {
				request: '请求',
				response: '响应',
				responseFormat: '响应格式',
				formatList: '列表',
				formatJson: 'JSON',
				noListResults: '无可列表展示的条目；若有原始载荷可切换到 JSON。',
				noResponseStored:
					'未存储响应摘要（旧记录仅有查询词，或调用在返回结果前失败）。',
				hint: '响应摘要已截断，便于运营排查；完整对话内容仍在客户端。',
			},
		},
		errors: {
			invalidWebSearchProvider: '搜索引擎必须为已实现的选项之一。',
			invalidWebSearchCost: '每个引擎的供应 / 目录 / 用户单价均须为非负数字。',
			invalidWebFetchProvider: '抓取引擎必须为已实现的选项之一。',
			invalidWebFetchCost: '每个引擎的供应 / 目录 / 用户单价均须为非负数字。',
			invalidWebDeepSearchCost:
				'每个 Deep Search 引擎的供应 / 目录 / 用户单价均须为非负数字。',
			invalidAiDetectionCost:
				'每个引擎的供应 / 目录 / 用户单价须为非负数字，计费单元字符数须为正整数。',
			aiDetectionNotImplemented: '尚未实现的引擎不能设为 Active。',
			noKeyCannotActivate: '未配置 API Key 的引擎不能设为 Active。',
			switchActiveBeforeClearingKey:
				'若要清空当前 Active 引擎的 Key，请先把 Active 切到仍有 Key 的引擎并保存，再清空旧 Key。',
		},
	},
	ja: {
		catalog: {
			webSearch: 'Web Search',
			webFetch: 'Web Fetch',
			webDeepSearch: 'Web Deep Search',
			aiDetection: 'AI Detection',
		},
		config: {
			title: 'Tools',
			subtitle:
				'/v1/tools/* の製品ツール（エンジン、API キー、三帳簿単価）を設定します。system_config に保存され、ユーザー予算は charged のみ加算されます。',
			viewInvocations: '呼び出し履歴を表示 →',
			saveWebSearch: 'Web Search を保存',
			saveWebFetch: 'Web Fetch を保存',
			saveWebDeepSearch: 'Web Deep Search を保存',
			saveAiDetection: 'AI Detection を保存',
			testInPlayground: 'Playground でテスト',
			showSecrets: 'APIキーを表示',
			hideSecrets: 'APIキーを隠す',
		},
		providerCards: {
			active: '有効',
			editing: '編集中',
			unsaved: '未保存',
			missingCredentials: '認証情報なし',
			unavailable: '利用不可',
			lossPricing: '赤字価格',
			configured: '設定済み',
			priceLegend: 'S 標準価格 · C ユーザー課金 · M 原価',
			selectHint:
				'Provider をクリックして右の設定ドロワーを開きます。保存するまで反映されません。',
			detailTitle: '{name} を設定',
			activeSummary: '有効 · {name}',
			noActive: '有効な Provider なし',
			saveConfig: '設定を保存',
			saveAndActivate: '保存して有効化',
			saveConfigOnly: '設定のみ保存',
		},
		webSearch: {
			title: 'Web Search',
			description:
				'POST /v1/tools/web-search を提供します。実装済みのエンジンのみ選択でき、自由入力は拒否されます。API Key を空欄にして保存すると削除されます（再設定するまでエンドポイントは 503 を返します）。',
			descriptionCatalog:
				'POST /v1/tools/web-search 用。エンジンごとに API キーと三帳簿単価を設定し、カードを「保存して有効化」します。ユーザー予算に加算されるのは charged のみです。キー未設定のエンジンは有効化できません。',
			provider: '検索エンジン',
			active: 'Active エンジン',
			catalogProvider: 'エンジン',
			noKey: 'Key なし',
			needKeyToActivate:
				'保存する前に、少なくとも 1 つのエンジンに API Key を追加してください。',
			providerGuideLink: 'エンジンガイド',
			providerDocs: 'Docs & API Key →',
			cost: '成功時の charged（{currency}）',
			apiKey: 'Provider API Key',
			apiKeyPlaceholder: 'エンジンの API Key を貼り付け',
			apiKeyHint:
				'ツールでトラフィックを受け付けるために必須です。削除した Key は環境変数にフォールバックしません。',
			providers: {
				bocha: 'Bocha（博查）',
				tavily: 'Tavily',
				cleversee: 'Alibaba CleverSee（开析）',
				tencent_wsa: 'Tencent Cloud WSA',
			},
			providerGuide: {
				title: '検索エンジンガイド',
				subtitle:
					'各エンジンのインデックス / ソースと適した用途。Baidu または Google の API を直接使用するものではありません。',
				disclaimer:
					'いずれも Baidu または Google の公式検索 API を呼び出しません。各社または提携先の Web インデックスを使用しているため、結果 URL が baidu.com、google.com などを指す場合はあります。',
				selected: '現在選択中',
				docsLink: 'Docs & API Key →',
				labels: {
					sources: 'ソース',
					bestFor: '適した用途',
				},
				items: {
					bocha: {
						badge: '中国向け推奨',
						summary:
							'独自の大規模 Web インデックスを持つ AI 向け中国語検索エンジン（中国国内向け Bing Search API 代替として提供）。',
						sources:
							'数億から約 100 億の Web ページと提携コンテンツ（ニュース、百科事典、ショート動画、天気、学術情報など）。Baidu/Google ではありません。',
						bestFor:
							'中国地域のユーザー、中国語クエリ、中国国内のコンプライアンス要件。',
					},
					tavily: {
						badge: '国際向け推奨',
						summary:
							'LLM 向けの検索レイヤーで、検索・抽出・ランキングを 1 回の呼び出しで実行します。従来型の SERP 一覧ではなく、Agent / RAG 向けです。',
						sources:
							'独自クローラーとサードパーティ集約（Brave など独立系インデックスとの関連がよく言及されます）。Google/Baidu の公式 API ではありません。',
						bestFor: '国際地域、英語での調査、Agent ワークフロー。',
					},
					cleversee: {
						badge: '',
						summary:
							'Alibaba CleverSee（开析）の AI ネイティブ Web Search。mainland_china / global の地域モードに対応します。',
						sources:
							'Alibaba 独自の AI 検索インデックス。Docs では Baidu または Google をバックエンドとしているとは説明されていません。Gateway のデフォルトは mainland_china で、ドメイン許可リストを設定すると global に切り替わります。',
						bestFor:
							'Alibaba Cloud 上で中国 / グローバル地域を明示的に切り替える必要がある場合。',
					},
					tencent_wsa: {
						badge: '',
						summary:
							'Tencent Cloud Web Search API（WSA）。公式には Sogou Search を基盤としています。',
						sources:
							'Sogou 経由の公開 Web と Tencent エコシステム（Tencent News、Sogou Baike、Penguin アカウント）。上位 tier では VR / 権威性の高い分野別ソースも追加されます。',
						bestFor:
							'中国語 Web 検索で Bocha の代替が必要な場合。Sogou/Tencent コンテンツに強みがあります。',
					},
				},
			},
		},
		webFetch: {
			title: 'Web Fetch',
			description:
				'POST /v1/tools/web-fetch を提供します。実装済みのスクレイパーのみ選択でき、自由入力は拒否されます。API Key を空欄にして保存すると削除されます（再設定するまでエンドポイントは 503 を返します）。',
			descriptionCatalog:
				'POST /v1/tools/web-fetch 用。スクレイパーごとに API キーと三帳簿単価を設定し、カードを「保存して有効化」します。ユーザー予算に加算されるのは charged のみです。',
			provider: 'Fetch Provider',
			active: 'Active Provider',
			catalogProvider: 'Provider',
			noKey: 'Key なし',
			needKeyToActivate:
				'保存する前に、少なくとも 1 つの Provider に API Key を追加してください。',
			providerDocs: 'Docs & API Key →',
			cost: '成功時の charged（{currency}）',
			apiKey: 'Provider API Key',
			apiKeyPlaceholder: 'Provider API Key を貼り付け',
			apiKeyHint:
				'ツールでトラフィックを受け付けるために必須です。削除した Key は環境変数にフォールバックしません。',
			providers: {
				firecrawl: 'Firecrawl',
				tavily: 'Tavily Extract',
				jina: 'Jina Reader',
			},
		},
		webDeepSearch: {
			title: 'Web Deep Search',
			descriptionCatalog:
				'POST /v1/tools/web-deep-search 用。検索+読取エンジン（Firecrawl Search / Jina Search）。プロバイダーごとに設定し、カードを「保存して有効化」します。',
			active: 'Active Provider',
			catalogProvider: 'Provider',
			noKey: 'Key なし',
			needKeyToActivate:
				'保存する前に、少なくとも 1 つの Provider に API Key を追加してください。',
			providerDocs: 'Docs & API Key →',
			cost: '成功時の charged（{currency}）',
			apiKey: 'Provider API Key',
			apiKeyPlaceholder: 'Provider API Key を貼り付け',
			providers: {
				firecrawl: 'Firecrawl Search',
				jina: 'Jina Search',
			},
		},
		aiDetection: {
			title: 'AI Detection',
			descriptionCatalog:
				'POST /v1/tools/ai-detection 用。エンジンごとに認証情報と三帳簿単価を設定し、カードを「保存して有効化」します。課金は文字ユニット（billingUnitChars）で三列をスケール。現在は Tencent Cloud TMS のみ実装。',
			active: 'Active エンジン',
			catalogProvider: 'エンジン',
			noKey: '認証情報なし',
			needKeyToActivate:
				'保存する前に、実装済みエンジンの少なくとも 1 つに認証情報を追加してください。',
			providerDocs: 'Docs & API Key →',
			cost: '課金ユニットあたりの charged（{currency}）',
			billingUnitChars: '課金ユニット（文字）',
			credentials: '認証情報',
			fields: {
				apiKey: 'API Key',
				secretId: 'SecretId',
				secretKey: 'SecretKey',
				email: 'Email',
				region: 'Region',
				bizType: 'BizType',
				bizTypeOptional: '任意の BizType',
			},
			providers: {
				tencent_tms: 'Tencent Cloud TMS',
			},
		},
		invocations: {
			title: 'Tool 呼び出し履歴',
			subtitle:
				'provider octafuse-tools（model_id tool:*）として課金された呼び出しです。行をクリックするとクエリと結果概要を確認できます。リクエストログと同じ元データです。',
			configureTools: 'Tools を設定 →',
			openInRequestLogs: 'リクエストログで開く',
			toolFilter: 'Tool',
			allTools: 'すべての Tools',
			status: 'ステータス',
			empty: 'この期間に Tool 呼び出しはありません。',
			columns: {
				time: '時刻',
				tool: 'Tool',
				query: 'クエリ',
				user: 'ユーザー',
				status: 'ステータス',
				results: '結果',
				latency: 'レイテンシ',
				provider: 'エンジン',
				profit: '粗利（{currency}）',
				standard: '標準（{currency}）',
				charged: 'ユーザー課金（{currency}）',
				metered: '供給（{currency}）',
			},
			detail: {
				request: 'リクエスト',
				response: 'レスポンス',
				responseFormat: 'レスポンス形式',
				formatList: 'リスト',
				formatJson: 'JSON',
				noListResults:
					'リスト表示できる項目はありません。raw payload がある場合は JSON に切り替えてください。',
				noResponseStored:
					'レスポンス概要は保存されていません（古い行にはクエリのみが保存されているか、結果を返す前に呼び出しが失敗しています）。',
				hint: '運用確認用にレスポンス概要は切り詰められています。完全な chat transcript はクライアントに保持されます。',
			},
			titles: {
				profit: 'ユーザー課金 − 供給コスト（1回）',
				standard: '標準（カタログ）',
				charged: 'ユーザー課金',
				metered: '供給コスト',
			},
		},
		errors: {
			invalidWebSearchProvider:
				'検索エンジンは実装済みの選択肢から選んでください。',
			invalidWebSearchCost:
				'各エンジンの metered / standard / charged はいずれも 0 以上の数値である必要があります。',
			invalidWebFetchProvider:
				'Fetch Provider は実装済みの選択肢から選んでください。',
			invalidWebFetchCost:
				'各プロバイダーの metered / standard / charged はいずれも 0 以上の数値である必要があります。',
			invalidWebDeepSearchCost:
				'各 deep-search プロバイダーの metered / standard / charged はいずれも 0 以上の数値である必要があります。',
			invalidAiDetectionCost:
				'各エンジンの metered / standard / charged は 0 以上、billing unit chars は正の整数である必要があります。',
			aiDetectionNotImplemented: '未実装のエンジンは Active にできません。',
			noKeyCannotActivate: 'API Key がない Provider は有効化できません。',
			switchActiveBeforeClearingKey:
				'現在のエンジンの Key を削除する前に、Key が残っている別のエンジンへ Active を切り替えて保存し、その後もう一度保存して Key を削除してください。',
		},
		unitPrices: {
			title: '単価（{currency}）',
			legend: '標準 → ユーザー課金 → 供給',
			standard: '標準',
			charged: 'ユーザー課金',
			metered: '供給',
			lossHint: 'ユーザー課金が供給単価を下回っています（赤字）',
		},
	},
	ko: {
		catalog: {
			webSearch: 'Web Search',
			webFetch: 'Web Fetch',
			webDeepSearch: 'Web Deep Search',
			aiDetection: 'AI Detection',
		},
		config: {
			title: 'Tools',
			subtitle:
				'/v1/tools/* 제품 도구(엔진, API 키, 삼중 단가)를 구성합니다. system_config에 저장되며 사용자 예산에는 charged만 가산됩니다.',
			viewInvocations: '호출 내역 보기 →',
			saveWebSearch: 'Web Search 저장',
			saveWebFetch: 'Web Fetch 저장',
			saveWebDeepSearch: 'Web Deep Search 저장',
			saveAiDetection: 'AI Detection 저장',
			testInPlayground: 'Playground에서 테스트',
			showSecrets: 'API 키 표시',
			hideSecrets: 'API 키 숨기기',
		},
		providerCards: {
			active: '활성',
			editing: '편집 중',
			unsaved: '저장 안 됨',
			missingCredentials: '자격 증명 없음',
			unavailable: '사용 불가',
			lossPricing: '손실 가격',
			configured: '구성됨',
			priceLegend: 'S 표준가 · C 사용자 과금 · M 원가',
			selectHint:
				'Provider를 클릭하면 오른쪽 구성 서랍이 열립니다. 저장해야 적용됩니다.',
			detailTitle: '{name} 구성',
			activeSummary: '활성 · {name}',
			noActive: '활성 Provider 없음',
			saveConfig: '구성 저장',
			saveAndActivate: '저장 후 활성화',
			saveConfigOnly: '구성만 저장',
		},
		webSearch: {
			title: 'Web Search',
			description:
				'POST /v1/tools/web-search에 사용됩니다. 구현된 엔진만 선택할 수 있으며 자유 텍스트는 거부됩니다. API Key를 비운 채 저장하면 Key가 삭제되고, 다시 설정할 때까지 엔드포인트가 503을 반환합니다.',
			descriptionCatalog:
				'POST /v1/tools/web-search용. 엔진별로 API 키와 삼중 단가를 설정한 뒤 카드를 「저장 후 활성화」합니다. 사용자 예산에는 charged만 반영됩니다. 키가 없는 엔진은 활성화할 수 없습니다.',
			provider: '검색 엔진',
			active: 'Active 엔진',
			catalogProvider: '엔진',
			noKey: 'Key 없음',
			needKeyToActivate:
				'저장하기 전에 하나 이상의 엔진에 API Key를 추가하세요.',
			providerGuideLink: '엔진 안내',
			providerDocs: 'Docs 및 API Key →',
			cost: '성공 시 charged ({currency})',
			apiKey: 'Provider API Key',
			apiKeyPlaceholder: '엔진 API Key 붙여넣기',
			apiKeyHint:
				'Tool에서 트래픽을 받으려면 필요합니다. 삭제된 Key는 환경 변수로 대체되지 않습니다.',
			providers: {
				bocha: 'Bocha (博查)',
				tavily: 'Tavily',
				cleversee: 'Alibaba CleverSee (开析)',
				tencent_wsa: 'Tencent Cloud WSA',
			},
			providerGuide: {
				title: '검색 엔진 안내',
				subtitle:
					'엔진별 인덱스 / 소스와 적합한 사용 사례입니다. Baidu 또는 Google API를 직접 호출하지 않습니다.',
				disclaimer:
					'어떤 엔진도 Baidu 또는 Google의 공식 검색 API를 호출하지 않습니다. 각 엔진은 자체 또는 파트너 웹 인덱스를 사용하며 결과 URL은 baidu.com, google.com 등을 가리킬 수 있습니다.',
				selected: '현재 선택됨',
				docsLink: 'Docs 및 API Key →',
				labels: {
					sources: '소스',
					bestFor: '권장 용도',
				},
				items: {
					bocha: {
						badge: '중국 지역 권장',
						summary:
							'자체 대규모 웹 인덱스를 갖춘 AI 중심 중국어 검색 엔진으로, 중국 내 Bing Search API 대안으로 제공됩니다.',
						sources:
							'수억 개에서 약 100억 개의 웹페이지와 파트너 콘텐츠(뉴스, 백과사전, 숏폼 비디오, 날씨, 학술 등)를 사용합니다. Baidu/Google은 아닙니다.',
						bestFor: '중국 지역 사용자, 중국어 검색, 중국 내 규정 준수.',
					},
					tavily: {
						badge: '글로벌 권장',
						summary:
							'LLM 중심 검색 계층으로 검색 + 추출 + 순위를 한 번의 호출로 제공합니다. 일반 SERP 목록이 아닌 Agent/RAG용으로 설계되었습니다.',
						sources:
							'자체 크롤러와 타사 집계(Brave 같은 독립 인덱스와 연계되는 경우가 많음)를 사용합니다. 공식 Google/Baidu API가 아닙니다.',
						bestFor: '글로벌 지역, 영어 자료 조사, Agent 워크플로.',
					},
					cleversee: {
						badge: '',
						summary:
							'mainland_china / global 지역 모드를 지원하는 Alibaba CleverSee (开析) AI 네이티브 Web Search입니다.',
						sources:
							'Alibaba 자체 AI 검색 인덱스를 사용합니다. 문서에는 Baidu 또는 Google 백엔드를 사용한다고 명시되어 있지 않습니다. Gateway 기본값은 mainland_china이며 도메인 Allowlist를 사용하면 global로 전환됩니다.',
						bestFor:
							'Alibaba Cloud에서 중국 / 글로벌 지역을 명시적으로 전환해야 할 때.',
					},
					tencent_wsa: {
						badge: '',
						summary:
							'공식적으로 Sogou Search를 기반으로 하는 Tencent Cloud Web Search API (WSA)입니다.',
						sources:
							'Sogou의 공개 웹과 Tencent 생태계(Tencent News, Sogou Baike, Penguin 계정)를 사용합니다. 상위 요금제는 VR/권위 있는 전문 소스를 추가로 제공합니다.',
						bestFor:
							'Bocha를 대체할 중국어 웹 검색이 필요하거나 Sogou/Tencent 콘텐츠 조합이 중요한 경우.',
					},
				},
			},
		},
		webFetch: {
			title: 'Web Fetch',
			description:
				'POST /v1/tools/web-fetch에 사용됩니다. 구현된 Scraper만 선택할 수 있으며 자유 텍스트는 거부됩니다. API Key를 비운 채 저장하면 Key가 삭제되고, 다시 설정할 때까지 엔드포인트가 503을 반환합니다.',
			descriptionCatalog:
				'POST /v1/tools/web-fetch용. 스크레이퍼별로 API 키와 삼중 단가를 설정한 뒤 카드를 「저장 후 활성화」합니다. 사용자 예산에는 charged만 반영됩니다.',
			provider: 'Fetch Provider',
			active: 'Active Provider',
			catalogProvider: 'Provider',
			noKey: 'Key 없음',
			needKeyToActivate:
				'저장하기 전에 하나 이상의 Provider에 API Key를 추가하세요.',
			providerDocs: 'Docs 및 API Key →',
			cost: '성공 시 charged ({currency})',
			apiKey: 'Provider API Key',
			apiKeyPlaceholder: 'Provider API Key 붙여넣기',
			apiKeyHint:
				'Tool에서 트래픽을 받으려면 필요합니다. 삭제된 Key는 환경 변수로 대체되지 않습니다.',
			providers: {
				firecrawl: 'Firecrawl',
				tavily: 'Tavily Extract',
				jina: 'Jina Reader',
			},
		},
		webDeepSearch: {
			title: 'Web Deep Search',
			descriptionCatalog:
				'POST /v1/tools/web-deep-search용. 검색+읽기 엔진(Firecrawl Search / Jina Search). 프로바이더별로 설정한 뒤 카드를 「저장 후 활성화」합니다.',
			active: 'Active Provider',
			catalogProvider: 'Provider',
			noKey: 'Key 없음',
			needKeyToActivate:
				'저장하기 전에 하나 이상의 Provider에 API Key를 추가하세요.',
			providerDocs: 'Docs 및 API Key →',
			cost: '성공 시 charged ({currency})',
			apiKey: 'Provider API Key',
			apiKeyPlaceholder: 'Provider API Key 붙여넣기',
			providers: {
				firecrawl: 'Firecrawl Search',
				jina: 'Jina Search',
			},
		},
		aiDetection: {
			title: 'AI Detection',
			descriptionCatalog:
				'POST /v1/tools/ai-detection용. 엔진별 자격 증명과 삼중 단가를 설정한 뒤 카드를 「저장 후 활성화」합니다. 문자 단위(billingUnitChars)로 세 열을 스케일합니다. 현재 Tencent Cloud TMS만 구현됨.',
			active: 'Active 엔진',
			catalogProvider: '엔진',
			noKey: '자격 증명 없음',
			needKeyToActivate:
				'저장하기 전에 구현된 엔진 하나 이상에 자격 증명을 추가하세요.',
			providerDocs: 'Docs 및 API Key →',
			cost: '과금 단위당 charged ({currency})',
			billingUnitChars: '과금 단위(문자)',
			credentials: '자격 증명',
			fields: {
				apiKey: 'API Key',
				secretId: 'SecretId',
				secretKey: 'SecretKey',
				email: 'Email',
				region: 'Region',
				bizType: 'BizType',
				bizTypeOptional: '선택 BizType',
			},
			providers: {
				tencent_tms: 'Tencent Cloud TMS',
			},
		},
		invocations: {
			title: 'Tool 호출 내역',
			subtitle:
				'provider=octafuse-tools, model_id=tool:*로 청구된 호출입니다. 행을 클릭하면 Query와 결과 요약을 확인할 수 있습니다. 요청 로그와 동일한 기본 행을 사용합니다.',
			configureTools: 'Tools 설정 →',
			openInRequestLogs: '요청 로그에서 열기',
			toolFilter: 'Tool',
			allTools: '모든 Tools',
			status: '상태',
			empty: '이 기간에는 Tool 호출이 없습니다.',
			columns: {
				time: '시간',
				tool: 'Tool',
				query: 'Query',
				user: '사용자',
				status: '상태',
				results: '결과',
				latency: '지연 시간',
				provider: '엔진',
				profit: '마진 ({currency})',
				standard: '표준 ({currency})',
				charged: '사용자 과금 ({currency})',
				metered: '공급 ({currency})',
			},
			detail: {
				request: '요청',
				response: '응답',
				responseFormat: '응답 형식',
				formatList: '목록',
				formatJson: 'JSON',
				noListResults:
					'목록으로 표시할 항목이 없습니다. 원시 Payload가 있으면 JSON으로 전환하세요.',
				noResponseStored:
					'저장된 응답 요약이 없습니다(이전 행에는 Query만 저장되었거나 결과 반환 전에 호출이 실패함).',
				hint: '운영 검토를 위해 응답 요약은 일부만 저장됩니다. 전체 Chat 기록은 클라이언트에 유지됩니다.',
			},
			titles: {
				profit: '사용자 과금 − 공급 원가(건당)',
				standard: '표준(카탈로그)',
				charged: '사용자 과금',
				metered: '공급 원가',
			},
		},
		errors: {
			invalidWebSearchProvider: '검색 엔진은 구현된 옵션 중 하나여야 합니다.',
			invalidWebSearchCost:
				'각 엔진의 metered / standard / charged는 모두 0 이상의 숫자여야 합니다.',
			invalidWebFetchProvider:
				'Fetch Provider는 구현된 옵션 중 하나여야 합니다.',
			invalidWebFetchCost:
				'각 프로바이더의 metered / standard / charged는 모두 0 이상의 숫자여야 합니다.',
			invalidWebDeepSearchCost:
				'각 deep-search 프로바이더의 metered / standard / charged는 모두 0 이상의 숫자여야 합니다.',
			invalidAiDetectionCost:
				'각 엔진의 metered / standard / charged는 0 이상이어야 하며 billing unit chars는 양의 정수여야 합니다.',
			aiDetectionNotImplemented:
				'아직 구현되지 않은 엔진은 Active로 설정할 수 없습니다.',
			noKeyCannotActivate: 'API Key가 없는 Provider는 활성화할 수 없습니다.',
			switchActiveBeforeClearingKey:
				'현재 엔진의 Key를 삭제하려면 먼저 Key가 있는 다른 엔진으로 Active를 전환하고 저장한 후 다시 저장하여 기존 Key를 삭제하세요.',
		},
		unitPrices: {
			title: '단가 ({currency})',
			legend: '표준 → 사용자 과금 → 공급',
			standard: '표준',
			charged: '사용자 과금',
			metered: '공급',
			lossHint: '사용자 과금이 공급 단가보다 낮습니다(적자)',
		},
	},
} as const
