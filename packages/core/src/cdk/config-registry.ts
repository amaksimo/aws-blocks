// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

const REGISTRY_KEY = Symbol.for('BLOCKS_CONFIG_REGISTRY');

/** The object key of the config JSON under {@link getConfigLocation}'s bucket. */
const CONFIG_KEY = 'blocks-config.json';

interface ConfigRegistryState {
	entries: Map<string, unknown>;
	finalized: boolean;
	/** The shared config bucket, created once per stack by {@link getConfigLocation}. */
	bucket?: s3.Bucket;
}

/**
 * Get or create the config registry for a given stack.
 * The registry collects BB config entries (env var key → CDK token value)
 * and serializes them to an S3 JSON file at synth time.
 */
function getRegistry(stack: cdk.Stack): ConfigRegistryState {
	let state = (stack as any)[REGISTRY_KEY] as ConfigRegistryState | undefined;
	if (!state) {
		state = { entries: new Map(), finalized: false };
		(stack as any)[REGISTRY_KEY] = state;
	}
	return state;
}

/**
 * Register a config entry for a Building Block. This replaces
 * `handler.addEnvironment(key, value)` for BB resource mappings.
 *
 * The entry will be serialized into a JSON config file in S3, loaded
 * by the Lambda at cold start. This avoids the 4KB env var limit.
 *
 * @param scope - The CDK construct (used to find the parent stack)
 * @param key - The config key (same string the runtime will use to look it up)
 * @param value - The config value (can be a CDK token that resolves at deploy time)
 */
export function registerConfig(scope: Construct, key: string, value: unknown): void {
	const stack = cdk.Stack.of(scope);
	const registry = getRegistry(stack);
	registry.entries.set(key, value);
}

/**
 * Ensure the shared config bucket exists and return where the config JSON lives
 * (`{ bucketName, key }`). The bucket is created **once per stack** (memoized on
 * the registry) and this is idempotent — the first caller creates it, later
 * callers get the same bucket regardless of order.
 *
 * Any compute that loads config at runtime (`loadConfigToProcessEnv()`) injects
 * these two values as `BLOCKS_CONFIG_BUCKET` / `BLOCKS_CONFIG_KEY`. The Lambda
 * handler gets them from {@link finalizeConfigRegistry}; other compute that runs
 * as the shared execution role (e.g. the Agent BB's AgentCore Runtime) calls this
 * at construction to inject them too, so it loads the same app config the handler
 * does. IAM is not granted here — `finalizeConfigRegistry` grants `s3:GetObject`
 * to the shared execution role, which such compute inherits.
 *
 * @param scope - Any construct in the stack; the bucket is created under the stack.
 */
export function getConfigLocation(scope: Construct): { bucketName: string; key: string } {
	const stack = cdk.Stack.of(scope);
	const registry = getRegistry(stack);
	if (!registry.bucket) {
		// Create under the owning BlocksStack/BlocksBackend (the same construct finalize historically
		// used), so the bucket's logical ID is stable regardless of which caller creates it first — a
		// BlocksBackend embedded in a customer stack keeps `Blocks/BlocksConfigBucket` (no replacement),
		// rather than moving to the stack root when a co-located BB (e.g. the AgentCore Runtime, a deep
		// construct) is the first to call getConfigLocation. Fall back to the stack when no owner is
		// registered (isolated unit tests). The registry stays keyed per-stack (see getRegistry).
		const owner = ((globalThis as any).CURRENT_BLOCKS_STACK as Construct | undefined) ?? stack;
		registry.bucket = new s3.Bucket(owner, 'BlocksConfigBucket', {
			removalPolicy: cdk.RemovalPolicy.DESTROY,
			autoDeleteObjects: true,
			encryption: s3.BucketEncryption.S3_MANAGED,
			blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
			lifecycleRules: [
				{ noncurrentVersionExpiration: cdk.Duration.days(1) },
			],
		});
	}
	return { bucketName: registry.bucket.bucketName, key: CONFIG_KEY };
}

/**
 * Finalize the config registry: create an S3 bucket, upload the config JSON,
 * set env vars on the handler, and grant read access.
 *
 * Must be called after all BBs are constructed (i.e., after the backendCDKPath
 * import completes in BlocksStack.create() / BlocksBackend.create()).
 *
 * @param scope - The CDK construct to create resources under
 * @param handler - The Lambda function that needs to read the config
 */
export function finalizeConfigRegistry(
	scope: Construct,
	handler: cdk.aws_lambda.IFunction,
): void {
	const stack = cdk.Stack.of(scope);
	const registry = getRegistry(stack);

	if (registry.finalized) return;
	registry.finalized = true;

	// Nothing to do only if no config was registered AND no bucket was created (via
	// getConfigLocation). If a co-located BB created the bucket, still upload (even an empty {}) and
	// wire the handler so that compute's loadConfigToProcessEnv() resolves instead of 404-ing forever.
	if (registry.entries.size === 0 && !registry.bucket) return;

	// Ensure the bucket exists (a BB may already have created it via getConfigLocation).
	const { bucketName, key } = getConfigLocation(scope);
	const configBucket = registry.bucket!;

	const configObject = cdk.Lazy.any({
		produce: () => Object.fromEntries(registry.entries),
	});

	new s3deploy.BucketDeployment(scope, 'BlocksConfigDeployment', {
		sources: [s3deploy.Source.jsonData(key, configObject)],
		destinationBucket: configBucket,
		prune: false,
	});

	(handler as cdk.aws_lambda.Function).addEnvironment(
		'BLOCKS_CONFIG_BUCKET',
		bucketName,
	);
	(handler as cdk.aws_lambda.Function).addEnvironment(
		'BLOCKS_CONFIG_KEY',
		key,
	);

	// Scope IAM grant to the specific config key
	(handler as cdk.aws_lambda.Function).addToRolePolicy(new iam.PolicyStatement({
		actions: ['s3:GetObject'],
		resources: [`${configBucket.bucketArn}/${key}`],
	}));
}
