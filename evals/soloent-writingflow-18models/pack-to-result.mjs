import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { EvalDefSchema, ResultFileSchema, validateResultForEval } from "@evalhub/schemas";
import { parse as parseYaml } from "yaml";

const EVAL_ID = "soloent-writingflow-18models";
const PROTOCOL_REVISION = 1;
const UPSTREAM_COMMIT = "46c5573259dd1802c808a4063899e99bd8e1f54c";
const RUNNER_VERSION = "soloent-writingflow-18models/pack-to-result@1.0.0";
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const MANIFEST_MAX_BYTES = 64 * 1024;
const ARTIFACT_MAX_BYTES = 2 * 1024 * 1024;
const MANIFEST_KEYS = ["manifest_version", "eval_id", "protocol_revision", "upstream_commit", "participant", "run_date", "runs"];
const PARTICIPANT_KEYS = ["model", "harness", "harness_version"];
const RUN_KEYS = ["run_id", "status", "artifact_path", "artifact_sha256", "failure_reason", "evidence_sha256"];

class PackError extends Error {
  name = "PackError";
}

function fail(message) {
  throw new PackError(message);
}

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} 必须是 JSON 对象`);
  return value;
}

function knownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${label} 含未知字段 ${JSON.stringify(key)}`);
  }
}

function text(value, max, label) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max || CONTROL_CHARACTERS.test(value)) {
    fail(`${label} 必须是 1 到 ${max} 个不含控制字符的文本`);
  }
  return value.trim();
}

function realDate(value) {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= lengths[month - 1];
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseArgv(argv) {
  let inputPath = null;
  let outputPath = null;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--out") {
      if (outputPath !== null) fail("--out 只能出现一次");
      index += 1;
      if (index >= argv.length) fail("--out 缺少文件名");
      outputPath = argv[index];
    } else if (token.startsWith("--")) {
      fail(`未知参数 ${JSON.stringify(token)}`);
    } else if (inputPath === null) {
      inputPath = token;
    } else {
      fail("只接受一个输入清单路径");
    }
  }
  if (inputPath === null) fail("缺少输入清单路径");
  if (outputPath === null || !outputPath.endsWith(".json")) fail("--out 必须提供 .json 文件名");
  return { inputPath, outputPath };
}

function readManifest(inputPath) {
  const absolute = resolve(inputPath);
  const stat = lstatSync(absolute, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isFile() || stat.isSymbolicLink()) fail("输入清单必须是普通文件且不能是软链接");
  if (stat.size > MANIFEST_MAX_BYTES) fail("输入清单超过 64 KiB");
  const bytes = readFileSync(absolute);
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("输入清单不是合法 UTF-8");
  }
  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch {
    fail("输入清单不是合法 JSON");
  }
  return { manifest: object(manifest, "输入清单"), absolute, sha256: digest(bytes) };
}

function readChapter(manifestPath, artifactPath, expectedSha256) {
  if (typeof artifactPath !== "string" || artifactPath.length < 1 || artifactPath.length > 240 || isAbsolute(artifactPath)) {
    fail("artifact_path 必须是长度 1–240 的相对路径");
  }
  const root = realpathSync(dirname(manifestPath));
  const candidate = resolve(root, artifactPath);
  const fromRoot = relative(root, candidate);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) fail(`artifact_path 越出清单目录：${artifactPath}`);
  const stat = lstatSync(candidate, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isFile() || stat.isSymbolicLink()) fail(`正文不存在、不是普通文件或是软链接：${artifactPath}`);
  if (realpathSync(candidate) !== candidate) fail(`正文路径含软链接：${artifactPath}`);
  if (stat.size < 1 || stat.size > ARTIFACT_MAX_BYTES) fail(`正文必须大于 0 且不超过 2 MiB：${artifactPath}`);
  const bytes = readFileSync(candidate);
  const actual = digest(bytes);
  if (actual !== expectedSha256) fail(`正文 sha256 不匹配：${artifactPath}`);
  let chapter;
  try {
    chapter = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(`正文不是合法 UTF-8：${artifactPath}`);
  }
  if (chapter.trim().length === 0 || CONTROL_CHARACTERS.test(chapter)) fail(`正文为空或含控制字符：${artifactPath}`);
  return { bytes: stat.size, sha256: actual };
}

function validateManifest(manifest, manifestPath) {
  knownKeys(manifest, MANIFEST_KEYS, "输入清单");
  if (manifest.manifest_version !== 1) fail("manifest_version 必须是 1");
  if (manifest.eval_id !== EVAL_ID) fail(`eval_id 必须是 ${EVAL_ID}`);
  if (manifest.protocol_revision !== PROTOCOL_REVISION) fail(`protocol_revision 必须是 ${PROTOCOL_REVISION}`);
  if (manifest.upstream_commit !== UPSTREAM_COMMIT) fail(`upstream_commit 必须是 ${UPSTREAM_COMMIT}`);
  if (!realDate(manifest.run_date)) fail("run_date 必须是真实的 YYYY-MM-DD 日期");

  const participant = object(manifest.participant, "participant");
  knownKeys(participant, PARTICIPANT_KEYS, "participant");
  const normalizedParticipant = {
    model: text(participant.model, 255, "participant.model"),
    harness: text(participant.harness, 255, "participant.harness"),
  };
  if (participant.harness_version !== undefined) {
    normalizedParticipant.harness_version = text(participant.harness_version, 255, "participant.harness_version");
  }
  if (!Array.isArray(manifest.runs) || manifest.runs.length !== 3) fail("runs 必须恰好包含三次尝试");

  const runIds = new Set();
  const chapterDigests = new Set();
  let validRuns = 0;
  const runs = manifest.runs.map((rawRun, index) => {
    const run = object(rawRun, `runs[${index}]`);
    knownKeys(run, RUN_KEYS, `runs[${index}]`);
    if (typeof run.run_id !== "string" || !RUN_ID_PATTERN.test(run.run_id)) fail(`runs[${index}].run_id 格式不合法`);
    if (runIds.has(run.run_id)) fail(`run_id 重复：${run.run_id}`);
    runIds.add(run.run_id);
    if (typeof run.evidence_sha256 !== "string" || !SHA256_PATTERN.test(run.evidence_sha256)) {
      fail(`runs[${index}].evidence_sha256 必须是 64 位小写十六进制`);
    }
    if (run.status === "valid") {
      if (run.failure_reason !== undefined) fail(`有效运行不能提供 failure_reason：${run.run_id}`);
      if (typeof run.artifact_sha256 !== "string" || !SHA256_PATTERN.test(run.artifact_sha256)) {
        fail(`有效运行必须提供合法 artifact_sha256：${run.run_id}`);
      }
      const artifact = readChapter(manifestPath, run.artifact_path, run.artifact_sha256);
      if (chapterDigests.has(artifact.sha256)) fail("不同有效运行不能提交重复正文");
      chapterDigests.add(artifact.sha256);
      validRuns += 1;
      return {runId: run.run_id, status: "valid", artifactPath: run.artifact_path, artifactSha256: artifact.sha256, bytes: artifact.bytes, evidenceSha256: run.evidence_sha256};
    }
    if (run.status === "failed") {
      if (run.artifact_path !== undefined || run.artifact_sha256 !== undefined) fail(`失败运行不能提供正文：${run.run_id}`);
      return {runId: run.run_id, status: "failed", failureReason: text(run.failure_reason, 500, `runs[${index}].failure_reason`), evidenceSha256: run.evidence_sha256};
    }
    fail(`runs[${index}].status 必须是 valid 或 failed`);
  });
  if (validRuns < 1) fail("至少需要一篇有效首章才能进入作者评分流程");
  return { participant: normalizedParticipant, runDate: manifest.run_date, runs, validRuns };
}

function loadEval() {
  const evalPath = resolve(dirname(fileURLToPath(import.meta.url)), "eval.yaml");
  const parsed = EvalDefSchema.safeParse(parseYaml(readFileSync(evalPath, "utf8")));
  if (!parsed.success) fail(`本评测的 eval.yaml 自身不合法：${JSON.stringify(parsed.error.issues)}`);
  return parsed.data;
}

function writeAtomic(outputPath, source) {
  const target = resolve(outputPath);
  if (basename(target) !== basename(outputPath)) fail("--out 只接受当前目录下的文件名");
  const partial = `${target}.partial`;
  writeFileSync(partial, source, { encoding: "utf8", mode: 0o600 });
  renameSync(partial, target);
}

function main(argv) {
  const { inputPath, outputPath } = parseArgv(argv);
  const { manifest, absolute, sha256 } = readManifest(inputPath);
  const { participant, runDate, runs, validRuns } = validateManifest(manifest, absolute);
  const resultFile = {
    eval_id: EVAL_ID,
    submission: { kind: "run", runner_version: RUNNER_VERSION, run_date: runDate },
    results: [{
      participant,
      score: null,
      detail: `三次尝试中 ${validRuns} 次生成有效首章，等待评测作者匿名盲评后补分。清单 sha256=${sha256}。`,
      supplementary_views: [{
        type: "metric_table",
        id: "workflow-attempts",
        label: "运行证据",
        title: "三次独立写作工作流尝试",
        columns: ["运行", "状态", "正文文件", "字节数", "正文 SHA-256", "过程证据 SHA-256", "失败说明"],
        rows: runs.map((run) => ({cells: run.status === "valid"
          ? [run.runId, "有效首章", run.artifactPath, run.bytes, run.artifactSha256, run.evidenceSha256, null]
          : [run.runId, "失败", null, null, null, run.evidenceSha256, run.failureReason]})),
        note: "转换器只核验运行状态、正文文件与证据指纹，不生成分数；最终 score 是有效首章的真人编辑匿名百分制评分算术平均。",
      }],
    }],
  };
  const structural = ResultFileSchema.safeParse(resultFile);
  if (!structural.success) fail(`生成结果不符合结果结构：${JSON.stringify(structural.error.issues)}`);
  const aware = validateResultForEval(loadEval(), structural.data);
  if (!aware.success) fail(`生成结果不满足本评测约束：${JSON.stringify(aware.error.issues)}`);
  writeAtomic(outputPath, `${JSON.stringify(structural.data, null, 2)}\n`);
  process.stdout.write(`已写出 ${outputPath}：${validRuns}/3 次有效，等待作者补分。\n`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  if (error instanceof PackError) {
    process.stderr.write(`转换失败：${error.message}\n`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
