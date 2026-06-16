import {
  appendCorrelationAlias,
  computeGitCorrelationKey,
  createLogger,
  logError,
  logInfo,
} from "@thor/common";
import { resolveOwnerRepoFromRemote } from "./github-app-auth.js";

const log = createLogger("remote-cli");

const GITHUB_ISSUE_URL_RE =
  /https:\/\/github\.com\/([^\s/]+)\/([^\s/]+)\/issues\/(\d+)(?:\b|[/?#])/;

export function registerGitCorrelationAlias(
  sessionId: string | undefined,
  args: string[],
  cwd: string,
): void {
  if (!sessionId) return;
  const correlationKey = computeGitCorrelationKey(args, cwd);
  if (!correlationKey) return;

  try {
    appendCorrelationAlias(sessionId, correlationKey);
  } catch (err) {
    logError(log, "alias_registration_error", err instanceof Error ? err.message : String(err), {
      sessionId,
      correlationKey,
    });
    return;
  }
  logInfo(log, "alias_registered", { sessionId, correlationKey, source: "git" });
}

function buildIssueCorrelationKey(owner: string, repo: string, number: string): string {
  return `github:issue:${repo}:${owner}/${repo}#${number}`;
}

function parseIssueUrl(
  stdout: string,
): { owner: string; repo: string; number: string } | undefined {
  const match = stdout.match(GITHUB_ISSUE_URL_RE);
  if (!match) return undefined;
  const [, owner, repo, number] = match;
  if (!owner || !repo || !number) return undefined;
  return { owner, repo, number };
}

function ownerRepoMatches(
  cwdRepo: ReturnType<typeof resolveOwnerRepoFromRemote> | undefined,
  owner: string,
  repo: string,
): boolean {
  return (
    !cwdRepo ||
    (cwdRepo.host === "github.com" &&
      cwdRepo.owner.toLowerCase() === owner.toLowerCase() &&
      cwdRepo.repo.toLowerCase() === repo.toLowerCase())
  );
}

export function parseCreatedIssueCorrelationKey(stdout: string, cwd: string): string | undefined {
  const issue = parseIssueUrl(stdout);
  if (!issue) return undefined;
  const cwdRepo = resolveOwnerRepoFromRemote(cwd);
  if (!ownerRepoMatches(cwdRepo, issue.owner, issue.repo)) return undefined;
  return buildIssueCorrelationKey(issue.owner, issue.repo, issue.number);
}

export function registerCreatedIssueCorrelationAlias(
  sessionId: string | undefined,
  cwd: string,
  stdout: string,
): void {
  if (!sessionId) return;
  const correlationKey = parseCreatedIssueCorrelationKey(stdout, cwd);
  if (!correlationKey) return;
  try {
    appendCorrelationAlias(sessionId, correlationKey);
  } catch (err) {
    logError(log, "alias_registration_error", err instanceof Error ? err.message : String(err), {
      sessionId,
      correlationKey,
    });
    return;
  }
  logInfo(log, "alias_registered", { sessionId, correlationKey, source: "gh" });
}
