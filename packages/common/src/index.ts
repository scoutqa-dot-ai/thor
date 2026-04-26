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
export { writeToolCallLog } from "./worklog.js";
export type { ToolCallLogEntry } from "./worklog.js";
export { createLogger, logInfo, logWarn, logError, truncate } from "./logger.js";
export type { Logger } from "./logger.js";
export {
  readNotes,
  createNotes,
  continueNotes,
  appendTrigger,
  appendSummary,
  findNotesFile,
  getSessionIdFromNotes,
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
export {
  ProgressStartSchema,
  ProgressToolSchema,
  ProgressMemorySchema,
  ProgressDelegateSchema,
  ProgressDoneSchema,
  ProgressErrorSchema,
  ProgressApprovalRequiredSchema,
  ProgressEventSchema,
  SlackProgressRequestSchema,
  SlackReactionRequestSchema,
  SlackApprovalRequestSchema,
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
  SlackProgressRequest,
  SlackReactionRequest,
  SlackApprovalRequest,
} from "./progress-events.js";
