/**
 * Shared constants for the Build Visualization Block plugin. This module must
 * stay framework-agnostic (no client/server imports) so it can be consumed by
 * both runtimes and by tests.
 */

/** The plugin package name. */
export const PLUGIN_NAME = 'plugin-build-visualization-block';

/** The name of the collection that stores build records. */
export const COLLECTION_NAME = 'aiVisualizationBuilds';

/** The singleton collection that stores plugin-level default build settings. */
export const SETTINGS_COLLECTION_NAME = 'aiVisualizationBuildSettings';

/**
 * Server action names exposed by the {@link COLLECTION_NAME} resource.
 */
export const ACTIONS = {
  build: 'aiVisualizationBuilds:build',
  retry: 'aiVisualizationBuilds:retry',
  getResult: 'aiVisualizationBuilds:getResult',
} as const;

/**
 * The phase a build record progresses through during asynchronous generation.
 */
export type BuildPhase = 'idle' | 'queued' | 'analyzing' | 'generating' | 'completed' | 'failed';

/** All build phases, in their natural progression order. */
export const BUILD_PHASES: BuildPhase[] = ['idle', 'queued', 'analyzing', 'generating', 'completed', 'failed'];

/** Minimum number of target collections a build may select. */
export const MIN_COLLECTIONS = 1;

/** Maximum number of target collections a build may select. */
export const MAX_COLLECTIONS = 50;

/** Maximum length, in characters, of the natural-language requirement. */
export const MAX_REQUIREMENT_CHARS = 2000;

/** Timeout, in milliseconds, applied to a single LLM invocation. */
export const LLM_TIMEOUT_MS = 60000;

/** Timeout, in milliseconds, after which an in-progress build is failed. */
export const BUILD_TIMEOUT_MS = 30 * 60 * 1000;
