const en = {
	title: 'Account settings',
	description: 'Manage your API access, wallet and CinaAuth account.',
	wallet: 'Wallet',
	walletHint: 'Wallet ownership is verified with a signed challenge.',
	none: 'No wallet is bound.',
	legacy:
		'This wallet has no recorded signature verification and retains its current withdrawal eligibility. You can verify ownership in wallet management.',
	verified: 'Verified: {{date}}',
	manageWallet: 'Manage wallet and withdrawals',
	identity: 'Identity and profile',
	identityHint:
		'Profile, sign-in and identity settings are managed by CinaAuth.',
	accountCenter: 'Open CinaAuth account center',
	unavailable: 'Wallet management is currently unavailable.',
	failed: 'Wallet details could not be verified.',
	mismatch:
		'Your account context changed. Verify your session before continuing.',
	retry: 'Retry wallet',
}
const zh: typeof en = {
	title: '账户设置',
	description: '管理 API 访问、钱包和 CinaAuth 账户。',
	wallet: '钱包',
	walletHint: '钱包归属通过签名挑战验证。',
	none: '尚未绑定钱包。',
	legacy:
		'此钱包没有已记录的签名验证，保留现有提现资格。可在钱包管理中验证归属。',
	verified: '验证时间：{{date}}',
	manageWallet: '管理钱包与提现',
	identity: '身份与资料',
	identityHint: '个人资料、登录和身份设置由 CinaAuth 管理。',
	accountCenter: '打开 CinaAuth 账户中心',
	unavailable: '钱包管理暂不可用。',
	failed: '无法验证钱包信息。',
	mismatch: '账户上下文已变化，请先重新验证会话。',
	retry: '重试加载钱包',
}
const ja: typeof en = {
	title: 'アカウント設定',
	description: 'API アクセス、ウォレット、CinaAuth アカウントを管理します。',
	wallet: 'ウォレット',
	walletHint: '署名チャレンジでウォレットの所有権を確認します。',
	none: 'ウォレットは未登録です。',
	legacy:
		'署名による確認記録がありません。現在の出金資格は維持されます。ウォレット管理で所有権を確認できます。',
	verified: '確認日時：{{date}}',
	manageWallet: 'ウォレットと出金を管理',
	identity: '本人情報とプロフィール',
	identityHint:
		'プロフィール、ログイン、本人情報の設定は CinaAuth で管理します。',
	accountCenter: 'CinaAuth アカウントセンターを開く',
	unavailable: 'ウォレット管理は現在利用できません。',
	failed: 'ウォレット情報を確認できませんでした。',
	mismatch: 'アカウント情報が変わりました。セッションを再確認してください。',
	retry: 'ウォレットを再読み込み',
}
const ko: typeof en = {
	title: '계정 설정',
	description: 'API 접근, 지갑 및 CinaAuth 계정을 관리하세요.',
	wallet: '지갑',
	walletHint: '서명 챌린지로 지갑 소유권을 확인합니다.',
	none: '연결된 지갑이 없습니다.',
	legacy:
		'서명 확인 기록이 없습니다. 현재 출금 자격은 유지됩니다. 지갑 관리에서 소유권을 확인할 수 있습니다.',
	verified: '확인 시각: {{date}}',
	manageWallet: '지갑 및 출금 관리',
	identity: '신원 및 프로필',
	identityHint: '프로필, 로그인 및 신원 설정은 CinaAuth에서 관리합니다.',
	accountCenter: 'CinaAuth 계정 센터 열기',
	unavailable: '현재 지갑 관리를 사용할 수 없습니다.',
	failed: '지갑 정보를 확인할 수 없습니다.',
	mismatch: '계정 컨텍스트가 변경되었습니다. 세션을 다시 확인하세요.',
	retry: '지갑 다시 불러오기',
}
export const settingsMessages = { en, zh, ja, ko }
