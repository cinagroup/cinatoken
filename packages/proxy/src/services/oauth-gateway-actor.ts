import {
 createKey, defaultWorkspaceId, getAccessibleWorkspaceForSubject,
 type GatewayRepositories,
} from '@octafuse/core';
import { authenticateApiKeyByLookupHash, type AuthenticatedApiKey } from './api-key-auth';

/** OAuth actors use the same tenant, Guardrail and reservation path as Gateway keys. */
export async function authenticateOAuthGatewayActor(
 repos: GatewayRepositories,
 token: { oauthAccessTokenId: string; userId: string; clientId: string },
): Promise<{ key: AuthenticatedApiKey; lookupHash: string } | null> {
 const id = `oauth:${token.oauthAccessTokenId}`;
 if (!/^oauth:[A-Za-z0-9._:-]{1,150}$/.test(id)) return null;
 const user = await repos.users.getById(token.userId);
 if (!user || user.status !== 'active' || user.external_system !== 'cinaauth' || !user.external_user_id) return null;
 const workspaceId = defaultWorkspaceId('personal', user.id);
 let row = await repos.apiKeys.getApiKeyById(id);
 if (!row) {
  const workspace = await getAccessibleWorkspaceForSubject(repos.client, {
   userId: user.id, subject: user.external_user_id, workspaceId,
  });
  if (!workspace || workspace.id !== workspaceId || workspace.scopeType !== 'personal') return null;
  try {
   await createKey(repos, {
    user_id: user.id, workspace_id: workspaceId,
    name: `OAuth · ${token.clientId}`,
    metadata: JSON.stringify({ credential_kind: 'oauth_access_token', oauth_access_token_id: token.oauthAccessTokenId }),
    actor_id: `portal:${user.id}`, actor_type: 'user', provision_reason: 'OAuth tenant-bound accounting actor',
   }, id);
  } catch (error) {
   // Only a matching concurrent creator is recoverable. Never recreate a revoked actor.
   if (!await repos.apiKeys.getApiKeyById(id)) throw error;
  }
  row = await repos.apiKeys.getApiKeyById(id);
 }
 if (!row || row.user_id !== user.id || row.workspace_id !== workspaceId || row.status !== 'active') return null;
 let metadata: unknown;
 try { metadata = JSON.parse(row.metadata ?? '{}'); } catch { return null; }
 if (!metadata || typeof metadata !== 'object'
  || !('credential_kind' in metadata) || metadata.credential_kind !== 'oauth_access_token'
  || !('oauth_access_token_id' in metadata) || metadata.oauth_access_token_id !== token.oauthAccessTokenId
  ) return null;
 const lookupHash=await repos.apiKeys.getOAuthActorKeyLookupHash({id,userId:user.id,workspaceId,tokenId:token.oauthAccessTokenId});
 if(!lookupHash)return null;
 const key=await authenticateApiKeyByLookupHash(repos,lookupHash);
 if (!key || key.keyId !== id || key.userId !== user.id || key.workspaceId !== workspaceId) return null;
 return { key, lookupHash };
}
