import { readFileSync } from "node:fs";

const files = {
  build: "docker/opencode/config/agents/build.md",
  coder: "docker/opencode/config/agents/coder.md",
  thinker: "docker/opencode/config/agents/thinker.md",
  compose: "docker-compose.yml",
};

function read(path) {
  return readFileSync(path, "utf8");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertIncludes(name, content, needles) {
  for (const needle of needles) {
    assert(content.includes(needle), `${name} missing ${JSON.stringify(needle)}`);
  }
}

function validateReadme(content, name) {
  const lines = content.split(/\r?\n/);
  const expectedPrefixes = ["Run-ID:", "Repo:", "Branch:", "Worktree:", "Lifecycle:", "Verdict:"];
  for (const [index, prefix] of expectedPrefixes.entries()) {
    assert(lines[index]?.startsWith(prefix), `${name} line ${index + 1} must start with ${prefix}`);
  }

  const lifecycle = lines[4].slice("Lifecycle:".length).trim();
  assert(["open", "merged", "abandoned"].includes(lifecycle), `${name} has invalid Lifecycle`);

  const verdict = lines[5].slice("Verdict:".length).trim();
  assert(
    verdict === "" || ["BLOCK", "SUBSTANTIVE", "NIT", "MERGED"].includes(verdict),
    `${name} has invalid Verdict`,
  );

  for (const section of ["## Goal", "## Artifacts", "## Log"]) {
    assert(content.includes(section), `${name} missing ${section}`);
  }
}

function extractReadmeSkeleton(buildMd) {
  const match = buildMd.match(/```\n(Run-ID:[\s\S]*?)\n```/);
  assert(match, `${files.build} missing README skeleton (no fenced block starts with 'Run-ID:')`);
  return match[1];
}

const build = read(files.build);
const coder = read(files.coder);
const thinker = read(files.thinker);
const compose = read(files.compose);

const sharedNeedles = [
  "Run dir:",
  "Role:",
  "^Run dir: (?<path>/workspace/runs/[^\\s]+)$",
  "^Role: (?<role>plan|implement|review)$",
  "BLOCK",
  "SUBSTANTIVE",
  "NIT",
  "MERGED",
  "Lifecycle:",
  "open",
  "merged",
  "abandoned",
  "ERROR:",
  "ERROR: missing Run dir header",
  "ERROR: missing Role header",
  "ERROR: Run dir outside /workspace/runs/",
  "ERROR: README not found",
  "ERROR: README missing",
  "realpath",
  "/workspace/runs/",
  "## Goal",
  "## Artifacts",
  "## Log",
];

assertIncludes(files.build, build, sharedNeedles);
assertIncludes(files.coder, coder, sharedNeedles);
assertIncludes(files.thinker, thinker, sharedNeedles);

const skeleton = extractReadmeSkeleton(build);
validateReadme(skeleton, `${files.build} skeleton`);

const sampleLines = skeleton.split(/\r?\n/);
sampleLines[0] = "Run-ID: 20260428-120000-agent-handoff";
sampleLines[1] = "Repo: thor";
sampleLines[2] = "Branch: feat/file-handoff";
sampleLines[3] = "Worktree: /workspace/worktrees/thor/feat-file-handoff";
sampleLines[5] = "Verdict: NIT";
validateReadme(sampleLines.join("\n"), "populated sample");

assert(
  compose.includes("./docker-volumes/workspace/runs:/workspace/runs"),
  "docker-compose.yml missing opencode /workspace/runs bind mount",
);
assert(
  compose.includes("./docker-volumes/workspace:/workspace"),
  "docker-compose.yml no longer exposes the workspace to runner; update the mount audit",
);

console.log("runs protocol lint passed");
