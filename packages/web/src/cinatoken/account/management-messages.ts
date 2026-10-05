export const managementMessages = {
	en: {
		title: 'Management API keys',
		description:
			'Account-scoped credentials for supported management APIs. Management keys cannot run inference.',
		scopeNotice:
			'Within the account scope, these keys can manage Gateway keys, BYOK, workspaces, members, budgets and Guardrails, and access analytics and generation feedback. Permissions are not individually selectable.',
		scope: 'Account: {{name}}',
		create: 'Create management key',
		creating: 'Creating…',
		createIn: 'This key provides account management access for {{name}}.',
		name: 'Management key name',
		namePlaceholder: 'Deployment automation, control plane…',
		nameRequired: 'Enter a name for this key.',
		nameInvalid: 'Use no more than 128 characters.',
		accessHint:
			'Grants account-scoped access to supported management APIs, including keys, BYOK, workspaces and members, budgets, Guardrails, analytics and generation feedback. Its permissions cannot be narrowed here.',
		refresh: 'Refresh management keys',
		loading: 'Checking access and loading management keys…',
		noCapability:
			'Your account does not have permission to manage Management API keys.',
		ownerRequired: 'Only the personal account owner can manage these keys.',
		adminRequired:
			'Organization-wide key management requires an authorized CinaAuth organization administrator. Workspace administrator access alone does not grant this permission.',
		emptyTitle: 'Set up your automation',
		empty:
			'No management key has been created for this account. Create one when your applications need to automate account management.',
		loadFailed: 'Could not load Management API keys.',
		createFailed:
			'Creation could not be confirmed. Close this dialog and refresh the list before trying again; a key may have been created.',
		secretTitle: 'Save your management key',
		secretNotice:
			'Copy this key now and store it securely. It grants account-scoped management access, including configuration changes and analytics. After you close this dialog, the full key cannot be retrieved.',
		revokeNamed: 'Revoke management key {{name}}',
		revokeTitle: 'Revoke this management key?',
		revokeNotice:
			'Automation using {{name}} will stop immediately. Existing Gateway keys remain usable. This action cannot be undone.',
		revokeFailed:
			'Revocation could not be confirmed. Refresh the list to check the key status before trying again.',
	},
	zh: {
		title: 'Management API 密钥',
		description:
			'用于已支持管理 API 的账户级凭据。Management 密钥不能用于推理调用。',
		scopeNotice:
			'在账户授权范围内，这些密钥可管理 Gateway 密钥、BYOK、工作区、成员、预算和防护规则，并访问分析数据和请求反馈。权限不能逐项选择。',
		scope: '账户：{{name}}',
		create: '创建管理密钥',
		creating: '正在创建…',
		createIn: '此密钥提供 {{name}} 的账户管理访问权限。',
		name: '管理密钥名称',
		namePlaceholder: '部署自动化、控制平面…',
		nameRequired: '请输入密钥名称。',
		nameInvalid: '名称最多 128 个字符。',
		accessHint:
			'授予账户范围内已支持管理 API 的访问权限，包括密钥、BYOK、工作区与成员、预算、防护规则、分析数据和请求反馈。无法在此缩小权限范围。',
		refresh: '刷新管理密钥',
		loading: '正在检查权限并加载管理密钥…',
		noCapability: '你的账户没有管理 Management API 密钥的权限。',
		ownerRequired: '只有个人账户所有者可以管理这些密钥。',
		adminRequired:
			'组织级密钥管理需要经过授权的 CinaAuth 组织管理员身份。仅拥有工作区管理员权限不足以获得此权限。',
		emptyTitle: '配置自动化访问',
		empty: '此账户尚未创建管理密钥。需要自动化管理账户时，可在此创建。',
		loadFailed: '无法加载 Management API 密钥。',
		createFailed:
			'无法确认创建结果。请关闭对话框并刷新列表后再重试，密钥可能已创建。',
		secretTitle: '保存管理密钥',
		secretNotice:
			'请立即复制并妥善保存。此密钥提供账户范围内的管理访问权限，包括修改配置和访问分析数据。关闭对话框后，无法再次获取全文。',
		revokeNamed: '撤销管理密钥 {{name}}',
		revokeTitle: '撤销这把管理密钥？',
		revokeNotice:
			'使用 {{name}} 的自动化将立即停止。已经创建的 Gateway 密钥仍可使用。此操作无法撤销。',
		revokeFailed: '无法确认撤销结果。请刷新列表检查密钥状态后再重试。',
	},
	ja: {
		title: 'Management API キー',
		description:
			'対応する管理 API 用のアカウント単位の認証情報です。管理キーで推論を実行することはできません。',
		scopeNotice:
			'アカウントの権限範囲内で Gateway キー、BYOK、ワークスペース、メンバー、予算、Guardrail を管理し、分析データと生成フィードバックにアクセスできます。権限を個別に選択することはできません。',
		scope: 'アカウント: {{name}}',
		create: '管理キーを作成',
		creating: '作成中…',
		createIn: 'このキーは {{name}} のアカウント管理アクセスを許可します。',
		name: '管理キー名',
		namePlaceholder: 'デプロイ自動化、コントロールプレーン…',
		nameRequired: 'キー名を入力してください。',
		nameInvalid: '128 文字以内で入力してください。',
		accessHint:
			'キー、BYOK、ワークスペースとメンバー、予算、Guardrail、分析データ、生成フィードバックを含む対応管理 API へのアカウント単位のアクセスを許可します。ここで権限を縮小することはできません。',
		refresh: '管理キーを更新',
		loading: '権限を確認し、管理キーを読み込み中…',
		noCapability:
			'このアカウントには Management API キーを管理する権限がありません。',
		ownerRequired: '個人アカウントの所有者のみがこれらのキーを管理できます。',
		adminRequired:
			'組織全体のキー管理には、承認された CinaAuth 組織管理者の権限が必要です。ワークスペース管理者の権限だけでは利用できません。',
		emptyTitle: '自動化用のアクセスを設定',
		empty:
			'このアカウントには管理キーがありません。アカウント管理の自動化が必要な場合に作成してください。',
		loadFailed: 'Management API キーを読み込めませんでした。',
		createFailed:
			'作成結果を確認できません。キーが作成されている場合があります。ダイアログを閉じて一覧を更新してから再試行してください。',
		secretTitle: '管理キーを保存',
		secretNotice:
			'今すぐコピーして安全に保管してください。このキーは設定変更や分析データへのアクセスを含むアカウント単位の管理権限を許可します。ダイアログを閉じると全文は再取得できません。',
		revokeNamed: '管理キー {{name}} を取り消す',
		revokeTitle: 'この管理キーを取り消しますか？',
		revokeNotice:
			'{{name}} を使った自動化は直ちに停止します。作成済みの Gateway キーは引き続き利用できます。この操作は元に戻せません。',
		revokeFailed:
			'取り消し結果を確認できません。一覧を更新してキーの状態を確認してから再試行してください。',
	},
	ko: {
		title: 'Management API 키',
		description:
			'지원되는 관리 API를 위한 계정 범위 인증 정보입니다. 관리 키로 추론을 실행할 수는 없습니다.',
		scopeNotice:
			'계정 권한 범위에서 Gateway 키, BYOK, 워크스페이스, 멤버, 예산, Guardrail을 관리하고 분석 데이터와 생성 피드백에 접근할 수 있습니다. 권한을 개별적으로 선택할 수는 없습니다.',
		scope: '계정: {{name}}',
		create: '관리 키 만들기',
		creating: '만드는 중…',
		createIn: '이 키는 {{name}}의 계정 관리 접근 권한을 제공합니다.',
		name: '관리 키 이름',
		namePlaceholder: '배포 자동화, 제어 영역…',
		nameRequired: '키 이름을 입력하세요.',
		nameInvalid: '128자 이내로 입력하세요.',
		accessHint:
			'키, BYOK, 워크스페이스와 멤버, 예산, Guardrail, 분석 데이터, 생성 피드백을 포함하는 지원 관리 API에 계정 범위 접근 권한을 부여합니다. 여기서 권한 범위를 줄일 수는 없습니다.',
		refresh: '관리 키 새로고침',
		loading: '권한을 확인하고 관리 키를 불러오는 중…',
		noCapability: '이 계정에는 Management API 키를 관리할 권한이 없습니다.',
		ownerRequired: '개인 계정 소유자만 이 키를 관리할 수 있습니다.',
		adminRequired:
			'조직 전체의 키 관리에는 승인된 CinaAuth 조직 관리자 권한이 필요합니다. 워크스페이스 관리자 권한만으로는 사용할 수 없습니다.',
		emptyTitle: '자동화 접근 설정',
		empty:
			'이 계정에 관리 키가 없습니다. 계정 관리를 자동화해야 할 때 만드세요.',
		loadFailed: 'Management API 키를 불러올 수 없습니다.',
		createFailed:
			'생성 결과를 확인할 수 없습니다. 키가 이미 만들어졌을 수 있습니다. 창을 닫고 목록을 새로고침한 후 다시 시도하세요.',
		secretTitle: '관리 키 저장',
		secretNotice:
			'지금 복사하여 안전하게 보관하세요. 이 키는 설정 변경과 분석 데이터 접근을 포함한 계정 범위 관리 권한을 제공합니다. 창을 닫으면 전체 키를 다시 가져올 수 없습니다.',
		revokeNamed: '관리 키 {{name}} 취소',
		revokeTitle: '이 관리 키를 취소할까요?',
		revokeNotice:
			'{{name}}을 사용하는 자동화가 즉시 중단됩니다. 이미 만든 Gateway 키는 계속 사용할 수 있습니다. 이 작업은 되돌릴 수 없습니다.',
		revokeFailed:
			'취소 결과를 확인할 수 없습니다. 목록을 새로고침하여 키 상태를 확인한 후 다시 시도하세요.',
	},
}
