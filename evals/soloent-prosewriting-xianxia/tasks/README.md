# 外部运行清单

把三次生成的完整正文保存为普通 UTF-8 文本文件，并在同一目录创建 JSON 清单。支持字段如下，未列出的字段会被拒绝：

- `manifest_version`：固定为 `1`
- `eval_id`：固定为 `soloent-prosewriting-xianxia`
- `protocol_revision`：固定为 `1`
- `upstream_commit`：固定为 `46c5573259dd1802c808a4063899e99bd8e1f54c`
- `participant.model`：EvalHub 注册表中的模型名，或待平台登记的清晰模型标识
- `participant.harness`：实际运行载体，例如 `SoloEnt`
- `participant.harness_version`：可选，实际版本号
- `run_date`：真实运行日期，格式 `YYYY-MM-DD`
- `runs`：恰好三项；每项含唯一 `run_id`、相对清单目录的 `artifact_path` 与 64 位小写 `artifact_sha256`

转换器拒绝绝对路径、路径逃逸、软链接、非普通文件、空文件、超过 2 MiB 的文件、不合法 UTF-8、控制字符、sha256 不符和重复正文。
结构示例见 `example-submission.json`；其中哈希只展示格式，执行前必须替换为真实文件的哈希。
