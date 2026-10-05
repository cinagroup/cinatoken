import { PublicStatsPage, type PublicStatsPageProps } from './PublicStatsPage'

export function BenchmarksPage(props: PublicStatsPageProps) {
	return <PublicStatsPage {...props} mode='benchmarks' />
}
