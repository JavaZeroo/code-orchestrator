# Vendored from slopus/happy

- 来源：https://github.com/slopus/happy — `packages/happy-wire/src/`
- 许可：MIT（见 LICENSE.happy）
- 锁定 commit：`d2ef88deffa337546f0c477f28385d470188cb38`（2026-07-02）
- 策略：复制固化，此后由本仓库独立维护，不追上游；重大修复手工 cherry-pick

## 取用文件

| 文件 | 说明 | 修改 |
|---|---|---|
| `sessionProtocol.ts` | 会话消息 envelope（text / tool-call-start / tool-call-end / turn-start / turn-end …判别联合） | 仅替换文件头注释；正文与上游一致 |
| `messageMeta.ts` | 发送侧元数据（permissionMode / model / allowedTools…） | 仅加出处注释 |

## 明确不取的文件及原因

- `messages.ts` — happy-server 同步封套 + E2E 加密容器（`t: 'encrypted'`、VersionedEncryptedValue），本系统不用 E2E，传输封套由 `src/rpc.ts` 自定义
- `legacyProtocol.ts` — 上游生产在用的松散 passthrough 格式（`content: {type: string}.passthrough()`），历史遗留，不采纳
- `voice.ts` — 语音（LiveKit）相关，超出范围

## 上游状态注记

上游将 `sessionProtocol.ts` 标记为 "UNDER REVIEW / frozen"（其生产代码路径仍走 legacy 协议）。
本项目**采纳该 envelope 设计为正式线上协议**并自行演进；上游的冻结状态自 vendor 之日起与本仓库无关。
