// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK tests for the config registry — specifically the getConfigLocation ↔ finalizeConfigRegistry
 * interaction. `getConfigLocation()` creates the config bucket eagerly (so co-located compute can
 * inject BLOCKS_CONFIG_BUCKET/KEY at construction); finalize must therefore still upload the config
 * object + wire the handler whenever a bucket exists, even if zero entries were registered — otherwise
 * that compute's loadConfigToProcessEnv() would 404 forever against a created-but-empty bucket.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { DEFAULT_NODE_RUNTIME } from './node-version.js';
import { finalizeConfigRegistry, getConfigLocation, registerConfig } from './config-registry.js';

// getConfigLocation reads globalThis.CURRENT_BLOCKS_STACK to place the bucket under the owning
// stack/backend; clear it between tests so one test's owner never leaks into another.
afterEach(() => {
	delete (globalThis as any).CURRENT_BLOCKS_STACK;
});

function stackWithHandler(id: string): { stack: cdk.Stack; handler: cdk.aws_lambda.Function } {
	const app = new cdk.App();
	const stack = new cdk.Stack(app, id);
	const handler = new cdk.aws_lambda.Function(stack, 'Handler', {
		runtime: DEFAULT_NODE_RUNTIME,
		handler: 'index.handler',
		code: cdk.aws_lambda.Code.fromInline('exports.handler = async () => {};'),
	});
	return { stack, handler };
}

test('finalize uploads + wires the handler even with zero entries when a bucket was created', () => {
	const { stack, handler } = stackWithHandler('EmptyWithBucket');
	// Simulate a co-located BB that creates the bucket but registers no config of its own.
	getConfigLocation(stack);
	finalizeConfigRegistry(stack, handler);

	const t = Template.fromStack(stack);
	assert.strictEqual(Object.keys(t.findResources('AWS::S3::Bucket')).length, 1, 'one config bucket');
	t.resourceCountIs('Custom::CDKBucketDeployment', 1); // the (empty) blocks-config.json is uploaded
	t.hasResourceProperties('AWS::Lambda::Function', {
		Environment: { Variables: Match.objectLike({ BLOCKS_CONFIG_KEY: 'blocks-config.json' }) },
	});
});

test('finalize is a no-op with zero entries and no bucket', () => {
	const { stack, handler } = stackWithHandler('EmptyNoBucket');
	finalizeConfigRegistry(stack, handler);

	const t = Template.fromStack(stack);
	assert.strictEqual(Object.keys(t.findResources('AWS::S3::Bucket')).length, 0, 'no config bucket created');
	t.resourceCountIs('Custom::CDKBucketDeployment', 0);
});

test('finalize uploads + wires the handler when config was registered (bucket auto-created)', () => {
	const { stack, handler } = stackWithHandler('WithEntries');
	registerConfig(stack, 'BLOCKS_SOMETHING', 'value');
	finalizeConfigRegistry(stack, handler);

	const t = Template.fromStack(stack);
	assert.strictEqual(Object.keys(t.findResources('AWS::S3::Bucket')).length, 1, 'one config bucket');
	t.resourceCountIs('Custom::CDKBucketDeployment', 1);
});

test('the config bucket is created under the owning stack/backend, not the (deep) caller scope', () => {
	// Mimic a BlocksBackend embedded in a customer stack: the owner is a nested construct, and the
	// first caller of getConfigLocation is a *deep* construct (like the AgentCore Runtime).
	const app = new cdk.App();
	const stack = new cdk.Stack(app, 'CustomerStack');
	const owner = new Construct(stack, 'Embedded'); // stands in for the BlocksBackend construct
	(globalThis as any).CURRENT_BLOCKS_STACK = owner;
	const deepScope = new Construct(new Construct(owner, 'agent'), 'runtime');

	getConfigLocation(deepScope);

	const t = Template.fromStack(stack);
	const bucketIds = Object.keys(t.findResources('AWS::S3::Bucket'));
	assert.strictEqual(bucketIds.length, 1, 'exactly one config bucket');
	// Logical IDs encode the construct path — under the owner it's `EmbeddedBlocksConfigBucket…`,
	// at the stack root it would be `BlocksConfigBucket…`. Pin that it follows the owner.
	assert.ok(bucketIds[0].startsWith('Embedded'), `bucket should be nested under the owner, got ${bucketIds[0]}`);
});

test('getConfigLocation creates exactly one bucket across repeated calls (idempotent)', () => {
	const { stack } = stackWithHandler('Idempotent');
	const a = getConfigLocation(stack);
	const b = getConfigLocation(stack);
	assert.strictEqual(a.key, b.key, 'same config key');
	assert.strictEqual(a.bucketName, b.bucketName, 'same bucket');
	const t = Template.fromStack(stack);
	assert.strictEqual(Object.keys(t.findResources('AWS::S3::Bucket')).length, 1, 'exactly one bucket');
});
