# TODO

## Release / Packaging

- [ ] 限制 npm 发布内容（`files` 字段或 `.npmignore`），避免把 `src/`、`.github/` 等非运行时文件打进包。
- [ ] 增加 `release` 前置校验（工作区干净、版本合法、tag 未占用）。
- [ ] 在 README 增加「从源码运行」与「全局安装运行」两套命令的明确区分。

## Runtime / Ops

- [ ] 增加 `tangram doctor` 命令，检查 Node/npm/systemd/npm prefix/config 路径。
- [ ] 优化 `gateway status` 输出（可选 `--json` 结构化状态，便于自动化巡检）。
- [ ] 为 systemd service 增加更清晰的安装后提示（日志路径、常用排障命令）。

## Upgrade / Rollback

- [ ] `upgrade --dry-run` 输出更明确（当前版本、目标版本、是否会重启）。
- [ ] 回滚流程增加更清晰的失败恢复提示（例如推荐下一步命令）。

## Quality

- [ ] 为 CLI 参数解析补单元测试（`gateway` 子命令、`--config`、未知参数）。
- [ ] 为升级逻辑补单元测试（已是最新版本时 no-op、失败回滚路径）。
