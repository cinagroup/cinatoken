/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import { playgroundCode, playgroundControl } from './PlaygroundSetup'
import type { ImageOperation } from './browser-domain/image-generations'
import {
	PLAYGROUND_LLM_SAMPLE_IDS,
	resolveClaudeThinkingProfile,
	resolveGeminiThinkingProfile,
	type PlaygroundLlmSampleId,
} from './browser-domain/samples'
import type {
	PlaygroundContext,
	PlaygroundKind,
	PlaygroundPreview,
	PlaygroundRoute,
	PlaygroundUploads,
} from './playground-contracts'
import {
	isRealtimeRoute,
	llmFamily,
	needsAudioFile,
	playgroundPrefix as prefix,
} from './playground-domain'
import type { PlaygroundResult } from './use-playground-run'

export type PlaygroundRequestProps = {
	context: PlaygroundContext
	route: PlaygroundRoute | null
	kind: PlaygroundKind | 'tool'
	body: string
	busy: boolean
	dirty: boolean
	imageOperation: ImageOperation
	geminiAction: 'generateContent' | 'streamGenerateContent'
	audioInput: 'file' | 'microphone'
	uploads: PlaygroundUploads
	preview: PlaygroundPreview | null
	result: PlaygroundResult | null
	onBody: (value: string) => void
	onImageOperation: (operation: ImageOperation) => void
	onGeminiAction: (action: 'generateContent' | 'streamGenerateContent') => void
	onAudioInput: (mode: 'file' | 'microphone') => void
	onImages: (files: File[]) => void
	onAudio: (file: File | null) => void
	onTemplate: () => void
	onSample: (id: PlaygroundLlmSampleId) => void
	onSend: () => void
	onPreview: () => void
	onStop: () => void
}
export function PlaygroundRequest(props: PlaygroundRequestProps) {
	const { t } = useTranslation(),
		realtime = isRealtimeRoute(props.route),
		asr =
			props.route?.upstream_operation.startsWith('audio.transcriptions') ??
			false
	const hint = props.route
		? `${props.route.model_id} ${props.route.provider_model_name}`.toLowerCase()
		: ''
	const claudeProfile = resolveClaudeThinkingProfile(hint)
	const sampleLabels = {
		connectivity: 'templateConnectivity',
		tools: 'templateToolStream',
		reasoning: 'templateReasoning',
	}
	const wire = props.result?.meta?.wireBody ?? props.preview?.request_body_json
	const target = props.result?.meta?.upstreamUrl ?? props.preview?.upstream_url
	let audioHint = 'audioSpeechHint'
	if (asr)
		audioHint =
			props.route?.upstream_protocol === 'dashscope'
				? 'audioTranscriptionsDashScopeHint'
				: 'audioTranscriptionsHint'
	if (realtime) audioHint = 'audioRealtimeDashScopeHint'
	return (
		<section className='min-w-0 space-y-4 rounded-xl border p-4'>
			<div className='flex flex-wrap items-center justify-between gap-2'>
				<h2 className='font-semibold'>{t(prefix + 'requestBody')}</h2>
				<div className='flex flex-wrap gap-2'>
					<Button
						size='sm'
						variant='outline'
						disabled={props.busy}
						onClick={props.onTemplate}
					>
						{t(prefix + 'applyTemplate')}
					</Button>
					<Button
						size='sm'
						variant='outline'
						disabled={props.busy}
						onClick={props.onPreview}
					>
						{t(prefix + 'preview')}
					</Button>
					<Button
						size='sm'
						disabled={
							props.busy || (realtime && !props.context.realtime_supported)
						}
						onClick={props.onSend}
					>
						{t(prefix + 'send')}
					</Button>
					<Button
						size='sm'
						variant='outline'
						disabled={!props.busy}
						onClick={props.onStop}
					>
						{t(prefix + 'stop')}
					</Button>
				</div>
			</div>
			{props.kind === 'llm' && props.route && llmFamily(props.route) ? (
				<div className='space-y-2'>
					<div className='flex flex-wrap items-center gap-2'>
						<span className='text-sm'>{t(prefix + 'templateSamples')}</span>
						{PLAYGROUND_LLM_SAMPLE_IDS.map((id) => (
							<Button
								size='sm'
								variant='outline'
								key={id}
								disabled={props.busy}
								onClick={() => props.onSample(id)}
							>
								{t(prefix + sampleLabels[id])}
							</Button>
						))}
					</div>
					{props.route.upstream_protocol === 'anthropic' ? (
						<p className='text-muted-foreground text-xs'>
							{t(prefix + 'thinkingProfile', {
								profile: `${claudeProfile.mode}${claudeProfile.includeEffort ? ' / effort' : ''}`,
							})}
						</p>
					) : null}
					{props.route.upstream_protocol === 'gemini' ? (
						<p className='text-muted-foreground text-xs'>
							{t(prefix + 'thinkingProfile', {
								profile: resolveGeminiThinkingProfile(hint),
							})}
						</p>
					) : null}
				</div>
			) : null}
			{props.dirty ? (
				<p role='status' className='text-muted-foreground text-sm'>
					{t(prefix + 'bodyDirtyHintLlm')}
				</p>
			) : null}
			{props.route?.upstream_protocol === 'gemini' ? (
				<label className='block space-y-1 text-sm'>
					<span>{t(prefix + 'geminiAction')}</span>
					<select
						className={playgroundControl}
						value={props.geminiAction}
						onChange={(event) =>
							props.onGeminiAction(
								event.target.value as PlaygroundRequestProps['geminiAction']
							)
						}
					>
						<option>streamGenerateContent</option>
						<option>generateContent</option>
					</select>
				</label>
			) : null}
			{props.kind === 'image' ? (
				<div className='space-y-2'>
					<fieldset className='flex flex-wrap gap-3'>
						<legend className='mb-2 text-sm'>
							{t(prefix + 'imageOperation')}
						</legend>
						{(['generations', 'edits'] as const).map((operation) => (
							<label
								key={operation}
								className='flex items-center gap-2 text-sm'
							>
								<input
									type='radio'
									name='playground-image-operation'
									checked={props.imageOperation === operation}
									onChange={() => props.onImageOperation(operation)}
								/>
								{operation}
							</label>
						))}
					</fieldset>
					<p className='text-muted-foreground text-xs'>
						{t(
							prefix +
								(props.imageOperation === 'edits'
									? 'imageEditsHint'
									: 'imageGenerationsHint')
						)}
					</p>
					{props.imageOperation === 'edits' ? (
						<label className='block space-y-1 text-sm'>
							<span>{t(prefix + 'referenceImages')}</span>
							<input
								key={props.route?.id}
								className={playgroundControl}
								type='file'
								multiple
								accept='image/png,image/jpeg,image/webp,image/gif'
								onChange={(event) =>
									props.onImages(Array.from(event.target.files ?? []))
								}
							/>
							<span className='text-muted-foreground text-xs'>
								{t(prefix + 'referenceImagesHint', {
									max: props.context.limits.image_count,
								})}{' '}
								·{' '}
								{t(prefix + 'referenceImagesSelected', {
									count: props.uploads.images?.length ?? 0,
								})}
							</span>
						</label>
					) : null}
				</div>
			) : null}
			{props.kind === 'rerank' ? (
				<p className='text-muted-foreground text-sm'>
					{t(prefix + 'rerankHint')}
				</p>
			) : null}
			{props.kind === 'audio' ? (
				<div className='space-y-3'>
					<p className='text-muted-foreground text-sm'>
						{t(prefix + audioHint)}
					</p>
					{realtime && !props.context.realtime_supported ? (
						<p
							role='alert'
							className='rounded-md border border-amber-500/50 p-3'
						>
							{t(prefix + 'realtimeUnavailable', {
								runtime: props.context.limits.runtime,
							})}
						</p>
					) : null}
					{realtime && asr ? (
						<fieldset className='flex flex-wrap gap-3'>
							<legend className='mb-2 text-sm'>
								{t(prefix + 'audioInputMode')}
							</legend>
							{(['file', 'microphone'] as const).map((mode) => (
								<label key={mode} className='flex items-center gap-2 text-sm'>
									<input
										type='radio'
										name='playground-audio-input'
										checked={props.audioInput === mode}
										onChange={() => props.onAudioInput(mode)}
									/>
									{t(
										prefix +
											(mode === 'file'
												? 'audioInputFile'
												: 'audioInputMicrophone')
									)}
								</label>
							))}
						</fieldset>
					) : null}
					{needsAudioFile(props.route) &&
					(!realtime || props.audioInput === 'file') ? (
						<label className='block space-y-1 text-sm'>
							<span>{t(prefix + 'audioFile')}</span>
							<input
								key={props.route?.id}
								className={playgroundControl}
								type='file'
								accept={
									realtime ? '.pcm,.wav,.raw' : 'audio/*,.m4a,.mp3,.wav,.webm'
								}
								onChange={(event) =>
									props.onAudio(event.target.files?.[0] ?? null)
								}
							/>
							<span className='text-muted-foreground text-xs'>
								{t(
									prefix +
										(realtime
											? 'audioRealtimeFileDashScopeHint'
											: 'audioFileHint')
								)}
							</span>
						</label>
					) : null}
				</div>
			) : null}
			{props.uploads.images?.length || props.uploads.audio ? (
				<ul className='space-y-1 text-xs'>
					{[
						...(props.uploads.images ?? []),
						...(props.uploads.audio ? [props.uploads.audio] : []),
					].map((file, index) => (
						<li key={`${file.name}-${index}`} className='break-all'>
							{file.name} · {(file.size / 1024 / 1024).toFixed(2)} MiB
						</li>
					))}
				</ul>
			) : null}
			<div className='grid min-w-0 gap-3 xl:grid-cols-2'>
				<label className='flex min-w-0 flex-col gap-1 text-sm'>
					<span>{t(prefix + 'inputBody')}</span>
					<textarea
						className={playgroundControl + ' min-h-72 font-mono text-xs'}
						spellCheck={false}
						value={props.body}
						disabled={props.busy}
						onChange={(event) => props.onBody(event.target.value)}
					/>
				</label>
				<div className='min-w-0 space-y-2'>
					<div className='flex flex-wrap justify-between gap-2 text-sm'>
						<h3>{t(prefix + 'sentBody')}</h3>
						{wire ? (
							<span className='text-muted-foreground text-xs'>
								{t(
									prefix +
										(props.result?.meta?.wireBody
											? 'sentBodySourceSent'
											: 'sentBodySourcePreview')
								)}
							</span>
						) : null}
					</div>
					<p className='text-muted-foreground text-xs'>
						{t(prefix + 'serverPreviewHelp')}
					</p>
					<pre className={playgroundCode + ' min-h-60'}>
						{wire ?? t(prefix + 'sentBodyEmpty')}
					</pre>
					{props.preview && !props.preview.ready ? (
						<p role='status' className='text-xs'>
							{t(
								prefix +
									(props.preview.missing_upload === 'images'
										? 'referenceImagesRequired'
										: 'audioFileRequired')
							)}
						</p>
					) : null}
					{props.preview?.truncated || props.result?.meta?.truncated ? (
						<p className='text-xs'>{t(prefix + 'previewTruncated')}</p>
					) : null}
					{props.preview?.auth_resolution_deferred && !props.result?.meta ? (
						<p className='text-muted-foreground text-xs'>
							{t(prefix + 'previewAuthDeferred')}
						</p>
					) : null}
				</div>
			</div>
			<div className='space-y-1'>
				<h3 className='text-sm'>{t(prefix + 'requestTargetUrl')}</h3>
				<pre className={playgroundCode}>
					{target ?? t(prefix + 'requestTargetUrlEmpty')}
				</pre>
				<p className='text-muted-foreground text-xs'>
					{t(
						prefix +
							(realtime ? 'requestTargetUrlRealtimeHint' : 'safeWireHelp')
					)}
				</p>
			</div>
		</section>
	)
}
