export {
  WorkspaceConfigSchema,
  loadWorkspaceConfig,
  validateWorkspaceConfig,
  resolveSafeRepoDirectory,
  resolveSlackChannelRepoDirectory,
  resolveRepoDirectory,
  isAllowedDirectory,
  createConfigLoader,
  WORKSPACE_CONFIG_PATH,
  SLACK_CHANNEL_REPO_MEMORY_ROOT,
  extractRepoFromCwd,
  getInstallationIdForOwner,
  findUserBySlack,
  findUserByGithub,
  getProfileForSlackChannel,
  getProfileForRepo,
  isSlackChannelInProfile,
  resolveStrictProfileForSession,
} from "./workspace-config.ts";
export {
  PROXY_NAMES,
  getAvailableProxyNames,
  isProxyName,
  resolveAtlassianCloudId,
  resolveProxyConfig,
} from "./proxies.ts";
export {
  ApprovalArgsSchema,
  ApprovalRequiredEventPayloadSchema,
  CreateJiraIssueApprovalArgsSchema,
  AddCommentToJiraIssueApprovalArgsSchema,
  CreateFeatureFlagApprovalArgsSchema,
  GhIssueCreateApprovalArgsSchema,
  AwsExecApprovalArgsSchema,
  approvalToolRequiresDisclaimer,
  injectApprovalDisclaimer,
  validateDisclaimerCompatibleArgs,
} from "./approval-events.ts";
export type {
  ApprovalArgs,
  ApprovalRequiredEventPayload,
  ApprovalToolName,
} from "./approval-events.ts";
export {
  envOptionalString,
  envString,
  envInt,
  envCsv,
  envBaseUrl,
  getRunnerBaseUrl,
  matchesInternalSecret,
} from "./env.ts";
export type { EnvSource } from "./env.ts";
export {
  loadGatewayEnv,
  loadRunnerEnv,
  loadRemoteCliEnv,
  loadRemoteCliAppEnv,
  loadRemoteCliGitHubEnv,
  loadRemoteCliInternalEnv,
  loadAdminEnv,
  loadGitHubAppAuthEnv,
  loadDaytonaEnv,
} from "./service-env.ts";
export type {
  WorkspaceConfig,
  ProfileConfig,
  ConfigLoader,
  OwnerConfig,
  UserRecord,
  ValidationIssue,
  ValidationResult,
} from "./workspace-config.ts";
export type { ProxyName, ProxyUpstream } from "./proxies.ts";
export { resolvePsqlDatabases } from "./psql-databases.ts";
export type { PsqlDatabaseTarget } from "./psql-databases.ts";
export { writeToolCallLog, appendJsonlWorklog } from "./worklog.ts";
export type { ToolCallLogEntry, InboundWebhookHistoryEntry } from "./worklog.ts";
export {
  SessionEventLogRecordSchema,
  AliasRecordSchema,
  appendSessionEvent,
  appendAlias,
  readTriggerSlice,
  findActiveTrigger,
  findTriggerActor,
  findSlackTriggerCorrelationKey,
  findAnchorContext,
  resolveAlias,
  resolveSessionAnchorId,
  reverseLookupAnchor,
  anchorHasExternalKeyType,
  listAnchors,
  listAnchorSessionStates,
  currentSessionForAnchor,
  listSessionAliases,
  mintAnchor,
  sessionLogPath,
  iterateJsonlFileLinesSync,
  isUuidV7,
  UUID_V7_RE,
} from "./event-log.ts";
export type {
  SessionEventLogRecord,
  AliasRecord,
  TriggerSlice,
  ActiveTriggerResult,
  AnchorContextResult,
  ReverseAnchorEntry,
  AnchorSessionState,
  AnchorSessionStatus,
  ListAnchorSessionStatesOptions,
} from "./event-log.ts";
export {
  OpencodeEventSchema,
  ViewerPartSchema,
  ViewerToolPartSchema,
  ViewerTextPartSchema,
  ViewerReasoningPartSchema,
  ViewerStepFinishPartSchema,
  ViewerCompactionPartSchema,
  isOmittedMarker,
  parseOpencodeEvent,
  projectOpencodeEvent,
} from "./opencode-event.ts";
export type {
  OmittedMarker,
  OpencodeEvent,
  ViewerPart,
  ViewerToolPart,
  ViewerTextPart,
  ViewerReasoningPart,
  ViewerStepFinishPart,
  ViewerCompactionPart,
  ViewerPayloadOrOmitted,
  ParsedOpencodeEvent,
} from "./opencode-event.ts";
export { createLogger, logInfo, logWarn, logError, truncate } from "./logger.ts";
export { formatTokens, formatDuration, formatAge, formatBytes, formatCostUsd } from "./format.ts";
export type { Logger } from "./logger.ts";
export { errorMessage, errorToMetadata } from "./errors.ts";
export type { ErrorMetadataOptions } from "./errors.ts";
export {
  WORKSPACE_REPOS_ROOT,
  WORKSPACE_WORKTREES_ROOT,
  THOR_WORKTREES_ROOT_ENV,
  getWorkspaceWorktreesRoot,
  isPathWithin,
  realpathOrNull,
  resolveExistingDirectoryWithinRoot,
} from "./paths.ts";
export {
  MEMORY_DIR,
  normalizeMemoryPath,
  isMemoryPath,
  isBareMemoryDirectoryPath,
} from "./memory-paths.ts";
export {
  resolveCorrelationKeys,
  resolveCorrelationLockKey,
  hasSessionForCorrelationKey,
  ensureAnchorForCorrelationKey,
  appendCorrelationAlias,
  appendCorrelationAliasForAnchor,
  buildSlackCorrelationKey,
  computeGitCorrelationKey,
  computeSlackCorrelationKey,
  resolveAnchorForCorrelationKey,
  resolveSessionForCorrelationKey,
  SESSION_LOCK_PREFIX,
} from "./correlation.ts";
export type { EnsureAnchorResult } from "./correlation.ts";
export { withKeyLock } from "./key-lock.ts";
export { ExecResultSchema, ExecStreamEventSchema } from "./exec-result.ts";
export type { ExecResult, ExecStreamEvent } from "./exec-result.ts";
export { deriveGitHubAppBotIdentity } from "./github-identity.ts";
export type { GitHubAppBotIdentity, GitHubAppBotIdentityInput } from "./github-identity.ts";
export {
  buildThorDisclaimer,
  buildThorDisclaimerForSession,
  buildThorAnchorUrl,
  buildThorTriggerUrl,
  formatThorContextFooter,
} from "./disclaimer.ts";
export type { ThorDisclaimerContext } from "./disclaimer.ts";
export {
  ProgressToolSchema,
  ProgressMemorySchema,
  ProgressDelegateSchema,
  ProgressDoneSchema,
  ProgressEventSchema,
} from "./progress-events.ts";
export type {
  ProgressTool,
  ProgressMemory,
  ProgressDelegate,
  ProgressDone,
  ProgressEvent,
} from "./progress-events.ts";
export { handleProgressEvent, getRegistrySize, clearRegistry } from "./progress-manager.ts";
export type { ProgressTransport, ProgressTarget, ProgressBlock } from "./progress-manager.ts";
export {
  buildApprovalButtonValue,
  parseApprovalButtonValue,
  resolveSlackThreadTargetFromTrigger,
  buildApprovalPresentation,
  buildApprovalSlackMessage,
  buildApprovalPresentationBlocks,
} from "./approval-presentation.ts";
export type {
  SlackBlock,
  SlackThreadTarget,
  ApprovalButtonRoute,
  ApprovalPresentation,
  ApprovalSlackMessage,
} from "./approval-presentation.ts";
