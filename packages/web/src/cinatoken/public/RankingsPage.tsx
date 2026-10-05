import { PublicStatsPage, type PublicStatsPageProps } from './PublicStatsPage'

export function RankingsPage(props: PublicStatsPageProps) {
	return <PublicStatsPage {...props} mode='rankings' />
}
