export type GuardrailStatus = 'active' | 'archived';
export type GuardrailScopeType = 'user' | 'api_key';
export type GuardrailEffectiveScopeType = GuardrailScopeType | 'workspace' | 'account';
export type GuardrailAssignmentManagementSource = 'admin' | 'management_api';

export type GuardrailRow = {
	id: string;
	workspace_id: string;
	owner_user_id: string;
	name: string;
	description: string | null;
	status: GuardrailStatus;
	is_workspace_default?: boolean | number;
	is_account_default?: boolean | number;
	account_scope_key?: string | null;
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
	management_source: GuardrailAssignmentManagementSource | null;
	assigned_by_user_id: string | null;
	created_at: string;
	guardrail_name?: string;
};

export type EffectiveGuardrailRow = GuardrailWithVersionRow & {
	assignment_id: string;
	assignment_scope_type: GuardrailEffectiveScopeType;
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
	/** Privileged source; inferred as admin when createdByUserId is null. */
	managementSource?: GuardrailAssignmentManagementSource | null;
	/** Actor retained separately because createdByUserId=null protects the row. */
	assignedByUserId?: string | null;
	nowIso: string;
	/** User-originated writes must never replace an administrator-managed binding. */
	preserveAdminManaged?: boolean;
};

export function resolveGuardrailAssignmentProvenance(
	params: Pick<
		UpsertGuardrailAssignmentParams,
		'createdByUserId' | 'managementSource' | 'assignedByUserId'
	>
): {
	managementSource: GuardrailAssignmentManagementSource | null;
	assignedByUserId: string | null;
} {
	const managementSource =
		params.managementSource === undefined
			? params.createdByUserId === null
				? 'admin'
				: null
			: params.managementSource;
	const assignedByUserId = params.assignedByUserId ?? null;

	if (params.createdByUserId !== null) {
		if (managementSource !== null || assignedByUserId !== null) {
			throw new Error(
				'user-managed guardrail assignments cannot have privileged provenance'
			);
		}
		return { managementSource: null, assignedByUserId: null };
	}
	if (managementSource === null) {
		throw new Error('privileged guardrail assignments require a management source');
	}
	if (managementSource === 'management_api' && assignedByUserId === null) {
		throw new Error('management API guardrail assignments require an actor');
	}
	if (managementSource === 'admin' && assignedByUserId !== null) {
		throw new Error('admin guardrail assignments cannot have a management API actor');
	}
	return { managementSource, assignedByUserId };
}
