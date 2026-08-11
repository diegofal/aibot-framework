export {
  runWithModelFallback,
  resolveCandidatesFromConfig,
  AllCandidatesExhaustedError,
  type ModelCandidate,
  type ModelFallbackParams,
  type ModelFallbackResult,
  type FallbackAttempt,
} from './model-fallback';

export {
  FailoverError,
  classifyFailoverReason,
  isBackendScoped,
  shouldAbortChain,
  type FailoverReason,
} from './failover-error';

export {
  ProviderCooldownTracker,
  type CooldownStatus,
} from './cooldown-tracker';

export {
  runStartupModelValidation,
  validateConfiguredModels,
  collectConfiguredModels,
  resolveStartupValidationSettings,
  resolveProbeTimeout,
  createOllamaProbeClient,
  classifyProbeFailure,
  ModelProbeError,
  ModelValidationError,
  DEFAULT_STARTUP_VALIDATION,
  type ConfiguredModel,
  type DaemonProbeOutcome,
  type ModelProbeClient,
  type ModelRole,
  type ProbeFailureKind,
  type ModelValidationReport,
  type ModelValidationResult,
  type ModelValidationStatus,
  type StartupValidationSettings,
} from './model-validation';
