# 机器与运行环境管理设计（grill 决议 2026-07-09）

## 背景与痛点

- 现状 NPU 项目用**单体大镜像**（如 `mindformers:ms2.7.2_cann9.1.0-beta.1_py3.11`），CANN×MindSpore 版本组合全焊死在镜像 tag 里，组合爆炸、切版本=换镜像。
- 机器接入已有反向 runner 模型 + 每机接入凭证（PR#78），但缺宿主机**运维通道**（装/升级/挡救 runner、预置大包）与**环境分发**能力。
- MindSpore 开发的真实形态：**每个 commit 一个 wheel（~250MB）**，日常用 master 日包甚至刚编出来的包；二分定位需要在同一容器内反复切版本且不丢现场。

## 七条决议

### ① SSH = 运维通道，执行面仍走 runner WS
SSH 负责：首次引导安装 runner、runner 升级/重启/挡救、CANN 等大包预置。
会话执行/docker 操作/心跳仍走 runner WS（低延迟、审计统一、断线重连已有）。SSH 掉线只影响运维动作，不影响在跑的活。

### ② 凭据：实例级密钥对，密码只做引导
- co 生成一对 ed25519（私钥 AES-256-GCM 加密落库，复用现有 crypto 服务）。
- 添加机器：填密码 → 首连自动写公钥进 authorized_keys，**密码用完即弃不落库**；不填密码 → UI 提供公钥下载/复制，人工放置后「测试连接」。
- key 管理 = 查看/复制/下载公钥 + 一键轮换（逐机重装）。每机存 host/port/user/认证方式（非密）。

### ③ CANN：低频大包，登记下发制
- 标准缓存路径：宿主 `<DATA_ROOT>/co/cache/cann/<版本>/`。
- 系统设置「组件源」登记表：版本 → 下载 URL + sha256。
- 分发三路：co 主动下发（目标机 runner wget+校验，不经 server 中转）＞ 机间同步（已有包的机器 rsync 到缺的，走 SSH 运维通道）＞ 人工预置（runner 扫描上报兜底）。
- 容器启动按项目 components 声明 **ro 挂载**对应版本，项目 `activate.sh` 只管 source——co 零领域代码不变。
- 调度只派到有所需版本缓存的机器。

### ④ MindSpore：commit 级海量 wheel，按需拉取三源一缓存
**不预分发**（1000 commit × 250MB 存储爆炸），按需拉取 + LRU 清理。三个来源统一落 `cache/wheels/mindspore/<标识>/`：

1. **master 日包**（最常用）：`https://repo.mindspore.cn/mindspore/mindspore/version/` 门禁日包，URL 规则拉取
2. **指定 commit 现编**：调现成编包 API `http://192.168.9.199:8666/`，等产物拉回缓存
3. **release**（少用）：`repo.mindspore.cn/pypi/simple` pip 源

### ⑤ 容器内 venv 多版本并存，切版本不杀容器
二分/对比场景在**同一容器**内反复切 MindSpore 且不能丢现场（用户决议，推翻"切版本=新容器"方案）。容器注入两个 shim：
- `co-fetch-ms <标识>`：按 ④ 三源拉取，flock 原子落宿主缓存（rw 挂载）、校验
- `msenv <标识>`：不存在则从本地 wheel 缓存建 venv（容器内层 `/opt/co-envs/`，~30-60s，**随容器丢**），存在则 source 切换；同容器内重切零成本

二分闭环：先日包粗分到天（拉取，快）→ 天内 commit 编包细分（~1h/步）→ `co-fetch-ms X && msenv X && 跑复现`，全程一个容器。

### ⑥ 编包不建子系统
直接调现成编包 API，co 只做"触发→等待→取产物→落缓存"。不自建 build 队列/产物管理。

### ⑦ 分期
- **B1**：系统设置「组件源」登记表；CANN 登记/扫描上报/主动下发；机器行显示已缓存组件版本
- **B2**：`co-fetch-ms`（三源）+ `msenv` shim 注入容器；项目 components 编辑 UI（基本信息区）
- **A**：添加机器表单扩 SSH 引导（密码即弃/公钥下载）；实例密钥对与轮换；runner 远程安装/升级/重启

B 不依赖 A（下发可走已有 runner 通道）；A 在机群扩张时上。

## 待定/实施时确认

- 编包 API 的请求格式与产物获取方式（实施 B2 时对着 `192.168.9.199:8666` 探明）
- 日包目录的精确 URL 规则（`version/` 下按日期/commit 的组织方式）
- wheel 缓存 LRU 的容量上限（按宿主数据盘定）
- venv 跨容器复用（宿主卷 + 按镜像分桶）——二期按需再评
