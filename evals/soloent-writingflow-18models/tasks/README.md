# 外部运行清单

清单记录三个独立项目的运行结果。顶层字段固定为：

- `manifest_version`: `1`
- `eval_id`: `soloent-writingflow-18models`
- `protocol_revision`: `1`
- `upstream_commit`: `46c5573259dd1802c808a4063899e99bd8e1f54c`
- `participant`: `model`、`harness`，以及可选 `harness_version`
- `run_date`: 真实 `YYYY-MM-DD` 日期
- `runs`: 恰好三项

每项运行都要有唯一 `run_id` 和 `status`。`status=valid` 时必须提供相对清单目录的 `artifact_path`、正文 `artifact_sha256`
和完整过程证据包 `evidence_sha256`；`status=failed` 时必须提供具体 `failure_reason` 与 `evidence_sha256`，且不能提供正文路径或正文哈希。
至少要有一篇有效首章，才能进入作者评分流程。

转换器拒绝未知字段、绝对路径、路径逃逸、软链接、非普通文件、空文件、超过 2 MiB 的正文、不合法 UTF-8、控制字符、
哈希不符和重复正文。`example-submission.json` 只展示结构，执行前必须替换其中的文件和哈希。
