export type RequestPresetVisibility = 'private' | 'public';
export type RequestPresetStatus = 'active' | 'archived';

export type RequestPresetRow = {
	id: string;
	workspace_id: string;
	owner_user_id: string;
	slug: string;
	name: string;
	description: string | null;
	visibility: RequestPresetVisibility;
	status: RequestPresetStatus;
	designated_version: number;
	latest_version: number;
	created_at: string;
	updated_at: string;
};

export type RequestPresetVersionRow = {
	id: string;
	preset_id: string;
	version: number;
	system_prompt: string | null;
	config_json: string;
	created_by_user_id: string | null;
	created_at: string;
};

export type RequestPresetWithVersionRow = RequestPresetRow & {
	version_id: string;
	version_system_prompt: string | null;
	version_config_json: string;
	version_created_by_user_id: string | null;
	version_created_at: string;
};

export type CreateRequestPresetParams = {
	id: string;
	versionId: string;
	workspaceId: string;
	ownerUserId: string;
	slug: string;
	name: string;
	description: string | null;
	visibility: RequestPresetVisibility;
	systemPrompt: string | null;
	configJson: string;
	createdByUserId: string | null;
	nowIso: string;
};

export type AddRequestPresetVersionParams = {
	presetId: string;
	versionId: string;
	systemPrompt: string | null;
	configJson: string;
	createdByUserId: string | null;
	nowIso: string;
};

export type UpdateRequestPresetMetadataPatch = {
	name?: string;
	description?: string | null;
	visibility?: RequestPresetVisibility;
	status?: RequestPresetStatus;
	nowIso: string;
};
