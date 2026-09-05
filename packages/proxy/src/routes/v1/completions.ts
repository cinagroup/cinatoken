/**
 * OpenAI legacy `POST /v1/completions` compatibility surface.
 * The shared Chat handler retains the gateway's single auth, routing, budget,
 * failover, guardrail, cancellation, usage-settlement and metadata control path.
 */
import { Hono } from 'hono';
import { requireApiKey } from '../../middleware/auth';
import { assignGenerationId } from '../../middleware/generation-id';
import { handleChatCompletion, type ChatEnv } from './chat';

export const completionsRoutes = new Hono<ChatEnv>();

completionsRoutes.use('*', requireApiKey);
completionsRoutes.use('*', assignGenerationId);
completionsRoutes.post('/', (c) => handleChatCompletion(c, 'legacy-completions'));
