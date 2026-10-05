/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import {
	listSupportedClientSurfaces,
	codeBlockClass,
	inputClass,
	labelClass,
	panelClass,
} from './simulator-utils'
import type { SimulatorState } from './use-simulator'

export function SimulatorRequest(props: { state: SimulatorState }) {
	const { t } = useTranslation()
	const state = props.state
	const selection = state.selection
	const surfaces = listSupportedClientSurfaces(
		state.context?.routes ?? [],
		selection.modelId,
		selection.routeGroup
	)
	let protocols = surfaces.protocols
	if (selection.kind === 'image')
		protocols = protocols.filter((value) => value === 'openai')
	if (selection.kind === 'audio')
		protocols = protocols.filter(
			(value) => value === 'openai' || value === 'dashscope'
		)
	const canUseMicrophone =
		state.realtime && selection.audioOperation === 'transcriptions'
	const isHttpMultimodal =
		selection.protocol === 'dashscope' &&
		selection.dashscopeOperation === 'audio.transcriptions.multimodal'
	let audioHint = 'audioSpeechHint'
	if (selection.audioOperation === 'transcriptions')
		audioHint = state.realtime
			? 'audioRealtimeDashScopeHint'
			: 'audioTranscriptionsHint'
	else if (state.realtime) audioHint = 'audioRealtimeSpeechHint'
	return (
		<section className={panelClass} aria-labelledby='simulator-request'>
			<div className='flex flex-wrap items-center justify-between gap-2'>
				<h2 id='simulator-request' className='font-semibold'>
					{t('cinatoken.adminSimulator.requestBody')}
				</h2>
				<button
					type='button'
					className='rounded-md border px-3 py-1.5 text-sm disabled:opacity-50'
					disabled={state.sending || !state.dirty}
					onClick={state.resetTemplate}
				>
					{t('cinatoken.adminSimulator.applyTemplate')}
				</button>
			</div>
			{selection.kind === 'tool' ? (
				<p className='text-muted-foreground text-xs'>
					{t('cinatoken.adminSimulator.toolProtocolHidden')}
				</p>
			) : (
				<>
					<div
						role='group'
						aria-label={t('cinatoken.adminSimulator.protocol')}
						className='flex flex-wrap gap-2'
					>
						{protocols.map((protocol) => (
							<button
								type='button'
								key={protocol}
								aria-pressed={selection.protocol === protocol}
								disabled={state.sending}
								className={
									'rounded-md border px-3 py-1.5 text-sm ' +
									(selection.protocol === protocol
										? 'border-primary bg-primary/10'
										: '')
								}
								onClick={() => state.changeSelection({ protocol })}
							>
								{protocol}
							</button>
						))}
					</div>
					{selection.modelId && protocols.length === 0 && (
						<p role='alert' className='text-destructive text-sm'>
							{t('cinatoken.adminSimulator.supportedSurfacesEmpty')}
						</p>
					)}
					{selection.kind === 'llm' && selection.protocol === 'openai' && (
						<>
							<div
								role='group'
								aria-label={t('cinatoken.adminSimulator.openaiOperation')}
								className='flex gap-2'
							>
								{surfaces.openaiLlmOperations.map((llmOperation) => (
									<button
										type='button'
										key={llmOperation}
										className={
											'rounded-md border px-3 py-1.5 text-sm ' +
											(selection.llmOperation === llmOperation
												? 'border-primary bg-primary/10'
												: '')
										}
										disabled={state.sending}
										aria-pressed={selection.llmOperation === llmOperation}
										onClick={() => state.changeSelection({ llmOperation })}
									>
										{llmOperation}
									</button>
								))}
							</div>
							<p className='text-muted-foreground text-xs'>
								{t('cinatoken.adminSimulator.openaiOperationHint')}
							</p>
						</>
					)}
					{selection.protocol === 'gemini' && (
						<>
							<label className={labelClass} htmlFor='simulator-gemini-action'>
								{t('cinatoken.adminSimulator.geminiAction')}
							</label>
							<select
								id='simulator-gemini-action'
								className={inputClass}
								disabled={state.sending}
								value={selection.geminiAction}
								onChange={(event) =>
									state.changeSelection({
										geminiAction:
											event.target.value === 'generateContent'
												? 'generateContent'
												: 'streamGenerateContent',
									})
								}
							>
								{surfaces.geminiActions.map((action) => (
									<option key={action} value={action}>
										{action}
									</option>
								))}
							</select>
						</>
					)}
				</>
			)}
			{selection.kind === 'image' && (
				<>
					<div
						role='group'
						aria-label={t('cinatoken.adminSimulator.imageOperation')}
						className='flex gap-2'
					>
						{surfaces.imageOperations.map((imageOperation) => (
							<label
								key={imageOperation}
								className='flex items-center gap-1.5 text-sm'
							>
								<input
									type='radio'
									name='simulator-image-operation'
									disabled={state.sending}
									checked={selection.imageOperation === imageOperation}
									onChange={() => state.changeSelection({ imageOperation })}
								/>
								{imageOperation}
							</label>
						))}
					</div>
					<p className='text-muted-foreground text-xs'>
						{t(
							selection.imageOperation === 'edits'
								? 'cinatoken.adminSimulator.imageEditsHint'
								: 'cinatoken.adminSimulator.imageGenerationsHint'
						)}
					</p>
					{selection.imageOperation === 'edits' && (
						<>
							<label className={labelClass} htmlFor='simulator-images'>
								{t('cinatoken.adminSimulator.referenceImages')}
							</label>
							<input
								id='simulator-images'
								key={selection.modelId + selection.imageOperation}
								className={inputClass}
								type='file'
								accept='image/*'
								multiple
								disabled={state.sending}
								onChange={(event) =>
									state.setEditFiles(Array.from(event.target.files ?? []))
								}
							/>
							<p className='text-muted-foreground text-xs'>
								{t('cinatoken.adminSimulator.imageLimits', {
									max: state.context?.limits.image_count ?? 5,
									bytes:
										state.context?.limits.image_file_bytes ?? 20 * 1024 * 1024,
								})}
							</p>
							<ul className='text-muted-foreground text-xs'>
								{state.editFiles.map((file, index) => (
									<li key={index}>
										{file.name} · {file.size} B
									</li>
								))}
							</ul>
							{!state.imageValidation.ok && state.editFiles.length > 0 && (
								<p role='alert' className='text-destructive text-sm'>
									{t('cinatoken.adminSimulator.invalidImages')}
								</p>
							)}
						</>
					)}
				</>
			)}
			{selection.kind === 'audio' && (
				<>
					<p className='text-muted-foreground text-xs'>
						{t('cinatoken.adminSimulator.' + audioHint)}
					</p>
					{isHttpMultimodal && (
						<p className='text-muted-foreground text-xs'>
							{t('cinatoken.adminSimulator.multimodalHttpHint')}
						</p>
					)}
					{canUseMicrophone && (
						<fieldset className='flex flex-wrap gap-3' disabled={state.sending}>
							<legend className={labelClass}>
								{t('cinatoken.adminSimulator.audioInputMode')}
							</legend>
							<label className='flex items-center gap-2 text-sm'>
								<input
									type='radio'
									name='simulator-audio-input'
									checked={state.audioInput === 'file'}
									onChange={() => state.setAudioInput('file')}
								/>
								{t('cinatoken.adminSimulator.audioInputFile')}
							</label>
							<label className='flex items-center gap-2 text-sm'>
								<input
									type='radio'
									name='simulator-audio-input'
									checked={state.audioInput === 'microphone'}
									onChange={() => state.setAudioInput('microphone')}
								/>
								{t('cinatoken.adminSimulator.audioInputMicrophone')}
							</label>
						</fieldset>
					)}
					{selection.audioOperation === 'transcriptions' &&
						!state.usesMicrophone &&
						!isHttpMultimodal && (
							<>
								<label className={labelClass} htmlFor='simulator-audio'>
									{t('cinatoken.adminSimulator.audioFile')}
								</label>
								<input
									id='simulator-audio'
									key={
										selection.modelId +
										selection.protocol +
										selection.dashscopeOperation
									}
									type='file'
									accept='audio/*,.mp3,.wav,.m4a,.webm,.ogg,.flac,.pcm'
									disabled={state.sending}
									className={inputClass}
									onChange={(event) =>
										state.setAudioFile(event.target.files?.[0] ?? null)
									}
								/>
								<p className='text-muted-foreground text-xs'>
									{t(
										state.realtime
											? 'cinatoken.adminSimulator.audioRealtimeFileDashScopeHint'
											: 'cinatoken.adminSimulator.audioFileHint'
									)}
								</p>
								<p className='text-muted-foreground text-xs'>
									{t('cinatoken.adminSimulator.audioLimit', {
										bytes:
											state.context?.limits.audio_file_bytes ??
											25 * 1024 * 1024,
									})}
								</p>
								{state.audioFile && (
									<p className='text-muted-foreground text-xs'>
										{state.audioFile.name} · {state.audioFile.size} B
									</p>
								)}
								{!state.audioValidation.ok && state.audioFile && (
									<p role='alert' className='text-destructive text-sm'>
										{t('cinatoken.adminSimulator.invalidAudio')}
									</p>
								)}
							</>
						)}
					{selection.audioOperation === 'speech' &&
						state.realtime &&
						!state.context?.realtime_tts_supported && (
							<p className='text-sm text-amber-700 dark:text-amber-400'>
								{t('cinatoken.adminSimulator.realtimeTtsRejected')}
							</p>
						)}
				</>
			)}
			<label className='sr-only' htmlFor='simulator-body'>
				{t('cinatoken.adminSimulator.requestBody')}
			</label>
			<textarea
				id='simulator-body'
				className={inputClass + ' min-h-64 font-mono'}
				rows={16}
				spellCheck={false}
				value={state.bodyText}
				onChange={(event) => state.setBodyText(event.target.value)}
				disabled={state.sending}
			/>
			{state.bodyError && (
				<p role='alert' className='text-destructive text-sm'>
					{t('cinatoken.adminSimulator.errBodyMustBeObject')}
				</p>
			)}
			{selection.kind !== 'tool' && selection.protocol !== 'gemini' && (
				<p className='text-muted-foreground text-xs'>
					{t('cinatoken.adminSimulator.infoModelOverwritten', {
						model: state.routingString,
					})}
				</p>
			)}
			<div className='flex flex-wrap items-center gap-3'>
				{state.sending ? (
					<button
						type='button'
						className='border-destructive text-destructive rounded-md border px-4 py-2 text-sm'
						onClick={state.stop}
					>
						{t('cinatoken.adminSimulator.stop')}
					</button>
				) : (
					<button
						type='button'
						className='bg-primary text-primary-foreground rounded-md px-4 py-2 text-sm disabled:opacity-50'
						disabled={!!state.blockReason}
						onClick={() => void state.send()}
					>
						{t('cinatoken.adminSimulator.send')}
					</button>
				)}
				{state.blockReason && (
					<p className='text-muted-foreground text-xs'>
						{t('cinatoken.adminSimulator.' + state.blockReason)}
					</p>
				)}
			</div>
			<div className='text-xs break-all'>
				<span className='font-medium'>
					{t('cinatoken.adminSimulator.requestTargetUrl')}:{' '}
				</span>
				<code>
					{state.wirePreview?.url ??
						t('cinatoken.adminSimulator.requestTargetUrlEmpty')}
				</code>
			</div>
			<details className='rounded-md border p-3'>
				<summary className='cursor-pointer text-sm'>
					{t('cinatoken.adminSimulator.wirePreview')}
				</summary>
				{state.wirePreview ? (
					<div className='mt-3 space-y-2'>
						<pre className={codeBlockClass}>
							{state.wirePreview.method} {state.wirePreview.url}
						</pre>
						<h3 className='text-xs font-medium'>
							{t('cinatoken.adminSimulator.wireHeaders')}
						</h3>
						<pre className={codeBlockClass}>
							{JSON.stringify(state.wirePreview.headers, null, 2)}
						</pre>
						<h3 className='text-xs font-medium'>
							{t('cinatoken.adminSimulator.wireBody')}
						</h3>
						<pre className={codeBlockClass}>{state.wirePreview.bodyText}</pre>
					</div>
				) : (
					<p className='text-muted-foreground mt-2 text-xs'>
						{t('cinatoken.adminSimulator.wirePreviewEmpty')}
					</p>
				)}
			</details>
		</section>
	)
}
