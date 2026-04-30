export {
  WorkspaceConfigSchema,
  loadWorkspaceConfig,
  validateWorkspaceConfig,
  getAllowedChannelIds,
  getChannelRepoMap,
  resolveRepoDirectory,
  isAllowedDirectory,
  createConfigLoader,
  WORKSPACE_CONFIG_PATH,
  extractRepoFromCwd,
  getRepoUpstreams,
  getInstallationIdForOwner,
  interpolateEnv,
  interpolateHeaders,
} from "./workspace-config.js";
export { PROXY_NAMES, PROXY_REGISTRY, isProxyName, getProxyConfig } from "./proxies.js";
export { requireEnv } from "./env.js";
export type {
  WorkspaceConfig,
  RepoConfig,
  ProxyConfig,
  ProxyUpstream,
  ConfigLoader,
  OwnerConfig,
  ValidationIssue,
  ValidationResult,
} from "./workspace-config.js";
export type { ProxyName } from "./proxies.js";
export { writeToolCallLog, appendJsonlWorklog, appendJsonlWorklogOrThrow, writeSlackWebhookHistory } from "./worklog.js";
export type { ToolCallLogEntry, InboundWebhookHistoryEntry } from "./worklog.js";
export {
  SessionEventLogRecordSchema,
  AliasRecordSchema,
  appendSessionEvent,
  appendAlias,
  readTriggerSlice,
  findActiveTrigger,
  resolveAlias,
  listSessionAliases,
  sessionLogPath,
} from "./event-log.js";
export type { SessionEventLogRecord, AliasRecord, TriggerSlice, ActiveTriggerResult } from "./event-log.js";
export { createLogger, logInfo, logWarn, logError, truncate } from "./logger.js";
export type { Logger } from "./logger.js";
export { errorToMetadata } from "./errors.js";
export type { ErrorMetadataOptions } from "./errors.js";
export {
  WORKSPACE_REPOS_ROOT,
  WORKSPACE_WORKTREES_ROOT,
  THOR_WORKTREES_ROOT_ENV,
  getWorkspaceWorktreesRoot,
  isPathWithin,
  isPathWithinPrefix,
  realpathOrNull,
  resolveExistingDirectoryWithinRoot,
} from "./paths.js";
export {
  readNotes,
  createNotes,
  continueNotes,
  appendTrigger,
  appendSummary,
  findNotesFile,
  registerAlias,
  resolveCorrelationKeys,
  isAliasableTool,
  isAliasableGitCommand,
  isAliasableMcpTool,
  extractAliases,
  getNotesLineCount,
  hasSlackReply,
  ThorMetaSchema,
  ThorMetaAliasSchema,
  ThorMetaApprovalSchema,
  extractThorMeta,
  formatThorMeta,
  computeGitAlias,
  computeSlackAlias,
  inferRepoFromPath,
  extractBranchFromGitArgs,
} from "./notes.js";
export type {
  ToolArtifact,
  ExtractedAlias,
  ThorMeta,
  ThorMetaAlias,
  ThorMetaApproval,
} from "./notes.js";
export { ExecResultSchema, ExecStreamEventSchema } from "./exec-result.js";
export type { ExecResult, ExecStreamEvent } from "./exec-result.js";
export { deriveGitHubAppBotIdentity } from "./github-identity.js";
export type { GitHubAppBotIdentity, GitHubAppBotIdentityInput } from "./github-identity.js";
export {
  buildThorDisclaimerForSession,
  buildThorTriggerUrl,
  formatThorDisclaimerFooter,
  ThorDisclaimerError,
} from "./disclaimer.js";
export type { ThorDisclaimerContext, ThorDisclaimerErrorCode } from "./disclaimer.js";
export {
  ProgressStartSchema,
  ProgressToolSchema,
  ProgressMemorySchema,
  ProgressDelegateSchema,
  ProgressDoneSchema,
  ProgressErrorSchema,
  ProgressApprovalRequiredSchema,
  ProgressEventSchema,
} from "./progress-events.js";
export type {
  ProgressStart,
  ProgressTool,
  ProgressMemory,
  ProgressDelegate,
  ProgressDone,
  ProgressError,
  ProgressApprovalRequired,
  ProgressEvent,
} from "./progress-events.js";
