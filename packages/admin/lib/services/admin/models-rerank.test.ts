import assert from "node:assert/strict";
import test from "node:test";
import type { GatewayRepositories } from "@octafuse/core";
import { createModelService, updateModelService } from "./models-service";

test("creating a rerank model keeps context_window and does not default max_tokens", async () => {
	const insertedRows: Record<string, unknown>[] = [];
	const repos = {
		models: {
			async insertModel(value: Record<string, unknown>) {
				insertedRows.push(value);
			},
			async replaceModelTags() {},
		},
	} as unknown as GatewayRepositories;

	await createModelService(repos, {
		id: "deepseek-reranker",
		vendor: "deepseek",
		context_window: 32_768,
		input_modalities: ["text"],
		output_modalities: ["rerank"],
		pricing_profile: {
			tiers: [{ upto: null, input_price: 0.1, output_price: 0 }],
		},
	});

	const inserted = insertedRows[0];
	assert.ok(inserted);
	assert.equal(inserted.contextWindow, 32_768);
	assert.equal(inserted.maxTokens, null);
	assert.equal(inserted.outputModalities, JSON.stringify(["rerank"]));
});


test('legacy pricing edits use the same atomic model CAS for catalog schedule alignment and tags', async () => {
 const calls: unknown[][] = [];
 const repos = {
  modelRouting: { getModelById: async () => { calls.push(['read']); return { id:'model',route_policy:' raw policy ' }; } },
  models: { updateModelWithPolicyPrecondition: async (...args: unknown[]) => { calls.push(['cas',...args]); return true; } },
 } as unknown as GatewayRepositories;
 await updateModelService(repos,'model',{pricing_profile:{tiers:[{upto:null,input_price:1,output_price:2}]},tags:['safe']});
 assert.deepEqual(calls.map(call=>call[0]),['read','cas']);
 assert.equal(calls[1][1],'model');
 assert.equal(typeof (calls[1][2] as {pricing_profile:unknown}).pricing_profile,'string');
 assert.equal(calls[1][3],' raw policy ');
 assert.deepEqual(calls[1][4],['safe']);
});
test('legacy pricing conflicts fail closed without sequential route writes', async () => {
 let attempts=0;
 const repos = {
  modelRouting: {getModelById:async()=>({id:'model',route_policy:null})},
  models: {updateModelWithPolicyPrecondition:async()=>{attempts++;return false;}},
 } as unknown as GatewayRepositories;
 await assert.rejects(updateModelService(repos,'model',{pricing_profile:null}), (error: unknown)=>(error as {status?:number}).status===409);
 assert.equal(attempts,1);
});
