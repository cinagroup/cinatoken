/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import {
	coercePublicChatRequest,
	PUBLIC_CHAT_MAX_ATTACHMENT_BYTES,
	PUBLIC_CHAT_MAX_ATTACHMENTS,
	PUBLIC_CHAT_MAX_TOTAL_ATTACHMENT_BYTES,
	type PublicChatMessage,
	type PublicChatStoredSession,
} from '../../../../core/src/lib/public-chat'

export type ChatAttachment = {
	id: string
	name: string
	size: number
	dataUrl: string
}
export type ChatMessage = {
	id: string
	role: 'user' | 'assistant'
	content: string
	attachments?: ChatAttachment[]
}
export type AttachmentError =
	| 'imagesUnsupported'
	| 'tooManyAttachments'
	| 'unsupportedAttachment'
	| 'attachmentTooLarge'
	| 'attachmentsTooLarge'
const IMAGE_TYPES = new Set([
	'image/png',
	'image/jpeg',
	'image/webp',
	'image/gif',
])

export function validateAttachmentFiles(
	files: readonly Pick<File, 'type' | 'size'>[],
	existing: readonly ChatAttachment[],
	supportsImages: boolean
): AttachmentError | null {
	if (!supportsImages) return 'imagesUnsupported'
	if (existing.length + files.length > PUBLIC_CHAT_MAX_ATTACHMENTS)
		return 'tooManyAttachments'
	if (files.some((file) => !IMAGE_TYPES.has(file.type)))
		return 'unsupportedAttachment'
	if (
		files.some(
			(file) => file.size < 1 || file.size > PUBLIC_CHAT_MAX_ATTACHMENT_BYTES
		)
	)
		return 'attachmentTooLarge'
	if (
		[...existing, ...files].reduce((sum, file) => sum + file.size, 0) >
		PUBLIC_CHAT_MAX_TOTAL_ATTACHMENT_BYTES
	)
		return 'attachmentsTooLarge'
	return null
}

export function toChatApiMessages(
	messages: readonly ChatMessage[]
): PublicChatMessage[] {
	return messages
		.filter((message) => message.content.trim() || message.attachments?.length)
		.map((message) => {
			if (message.role === 'assistant' || !message.attachments?.length)
				return { role: message.role, content: message.content }
			return {
				role: 'user',
				content: [
					...(message.content.trim()
						? [{ type: 'text' as const, text: message.content }]
						: []),
					...message.attachments.map((image) => ({
						type: 'image_url' as const,
						image_url: { url: image.dataUrl, detail: 'auto' as const },
					})),
				],
			}
		})
}

export function isValidAttachment(image: ChatAttachment): boolean {
	return (
		coercePublicChatRequest({
			model: 'image-validation',
			messages: toChatApiMessages([
				{ id: '', role: 'user', content: '', attachments: [image] },
			]),
		}) !== null
	)
}

/** The persisted projection cannot carry inference credentials or image payloads. */
export function toStoredChatSession(
	modelId: string,
	messages: readonly ChatMessage[],
	omittedImageText: (count: number) => string
): PublicChatStoredSession {
	return {
		version: 1,
		modelId,
		messages: messages
			.map((message) => ({
				role: message.role,
				content:
					message.content.trim() ||
					(message.attachments?.length
						? omittedImageText(message.attachments.length)
						: ''),
			}))
			.filter((message) => message.content)
			.slice(-50),
	}
}
