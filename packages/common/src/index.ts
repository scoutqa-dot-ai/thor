export {
  WorkspaceConfigSchema,
  loadWorkspaceConfig,
  getAllowedChannelIds,
  getChannelRepoMap,
  resolveRepoDirectory,
  isAllowedDirectory,
  createConfigLoader,
  WORKSPACE_CONFIG_PATH,
  getProxyConfig,
  extractRepoFromCwd,
  getRepoProxies,
  interpolateEnv,
  interpolateHeaders,
} from "./workspace-config.js";
export type {
  WorkspaceConfig,
  RepoConfig,
  ProxyConfig,
  ProxyUpstream,
  ConfigLoader,
} from "./workspace-config.js";
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
  extractAliases,
  getNotesLineCount,
  hasSlackReply,
  ThorMetaSchema,
} from "./notes.js";
export type { ToolArtifact, ExtractedAlias, ThorMeta } from "./notes.js";
export {
  ProgressStartSchema,
  ProgressToolSchema,
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
  ProgressDone,
  ProgressError,
  ProgressApprovalRequired,
  ProgressEvent,
  SlackProgressRequest,
  SlackReactionRequest,
  SlackApprovalRequest,
} from "./progress-events.js";
