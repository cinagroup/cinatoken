export type GuardrailStatus = 'active' | 'archived';
export type GuardrailScopeType = 'user' | 'api_key';

export type GuardrailRow = {
	id: string;
	workspace_id: string;
	owner_user_id: string;
	name: string;
	description: string | null;
	status: GuardrailStatus;
	designated_version: number;
	latest_version: number;
	created_at: string;
	updated_at: string;
};

export type GuardrailVersionRow = {
	id: string;
	guardrail_id: string;
	version: number;
	config_json: string;
	created_by_user_id: string | null;
	created_at: string;
};

export type GuardrailWithVersionRow = GuardrailRow & {
	version_id: string;
	version_config_json: string;
	version_created_by_user_id: string | null;
	version_created_at: string;
};

export type GuardrailAssignmentRow = {
	id: string;
	workspace_id: string;
	guardrail_id: string;
	scope_type: GuardrailScopeType;
	scope_id: string;
	created_by_user_id: string | null;
	created_at: string;
	guardrail_name?: string;
};

export type EffectiveGuardrailRow = GuardrailWithVersionRow & {
	assignment_id: string;
	assignment_scope_type: GuardrailScopeType;
	assignment_scope_id: string;
};

export type CreateGuardrailParams = {
	id: string;
	versionId: string;
	workspaceId: string;
	ownerUserId: string;
	name: string;
	description: string | null;
	configJson: string;
	createdByUserId: string | null;
	nowIso: string;
};

export type AddGuardrailVersionParams = {
	guardrailId: string;
	versionId: string;
	name: string;
	description: string | null;
	configJson: string;
	createdByUserId: string | null;
	nowIso: string;
	/** User-originated writes must fail once an administrator manages this guardrail. */
	preserveAdminManaged?: boolean;
};

export type UpdateGuardrailMetadataPatch = {
	name?: string;
	description?: string | null;
	status?: GuardrailStatus;
	nowIso: string;
	/** Apply the mutation only while no administrator-managed assignment exists. */
	preserveAdminManaged?: boolean;
};

export type GuardrailMutationOptions = {
	/** Apply the mutation only while no administrator-managed assignment exists. */
	preserveAdminManaged?: boolean;
};

export type UpsertGuardrailAssignmentParams = {
	id: string;
	workspaceId: string;
	guardrailId: string;
	scopeType: GuardrailScopeType;
	scopeId: string;
	createdByUserId: string | null;
	nowIso: string;
	/** User-originated writes must never replace an administrator-managed binding. */
	preserveAdminManaged?: boolean;
};
