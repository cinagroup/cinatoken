/** Private lookup contract for OAuth's tenant-bound accounting actor; no HTTP DTO exposes it. */
export type OAuthActorKeyLookup = {id:string;userId:string;workspaceId:string;tokenId:string};
export function oauthActorKeyHash(row:{id:string;user_id:string;workspace_id:string;status:string;metadata:string|null;key_hash:string|null}|null|undefined,input:OAuthActorKeyLookup):string|null {
 if(!/^oauth:[A-Za-z0-9._:-]{1,150}$/.test(input.id) || input.id!==`oauth:${input.tokenId}` || !input.userId || !input.workspaceId)return null;
 if(!row || row.id!==input.id || row.user_id!==input.userId || row.workspace_id!==input.workspaceId || row.status!=='active' || !/^sha256:[a-f0-9]{64}$/.test(row.key_hash ?? ''))return null;
 let metadata:unknown;try{metadata=JSON.parse(row.metadata ?? '{}');}catch{return null;}
 if(!metadata || typeof metadata!=='object' || !('credential_kind' in metadata) || metadata.credential_kind!=='oauth_access_token' || !('oauth_access_token_id' in metadata) || metadata.oauth_access_token_id!==input.tokenId)return null;
 return row.key_hash;
}
