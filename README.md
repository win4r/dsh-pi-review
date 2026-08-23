# dsh-pi-review

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供隔离、只读的 [Pi Agent](https://github.com/earendil-works/pi) Git 改动审查。它注册一个根 Agent 工具 `pi_review_diff`，冻结确定性的 Git 快照，在 Harness 的只读沙箱中启动独立 Pi SDK Worker，并返回可验证的结构化 finding。

> [!IMPORTANT]
> 只读沙箱保护的是本地文件不被 Worker 修改，不是数据保密边界。被选中的 diff 与变更文件内容会发送给配置的模型 Provider。不要用未经授权的外部 Provider 审查私有、敏感或受监管代码。

当前版本针对并锁定：

- DeepSeek Harness `0.1.1-rc.2`
- `@earendil-works/pi-coding-agent` `0.84.2`
- Node.js `>=22.19.0`

DeepSeek Harness 仍处于 developer preview。升级 Harness 或 Pi 前，应重新运行本仓库的完整检查、真实沙箱测试和真实模型冒烟测试。

## 为什么做成专用工具

```text
Root Agent 的 pi_review_diff 调用
  -> 固定 argv 的 Git 快照（HEAD/base/diff SHA-256）
  -> Harness read-only sandbox
  -> 独立 Node Worker + Pi SDK in-memory Session
  -> read / grep / find / ls / review_diff / submit_review
  -> 严格 JSON envelope
  -> 宿主复算快照并标记 stale
```

插件没有开放 Pi 的 `bash`、`write`、`edit`、扩展、Skill、Prompt 模板、上下文文件或持久化 Session。Pi 只能读取快照中的当前变更文件；删除文件和重命名旧路径只能通过固定 diff 审查。高危 finding 是成功的业务结果，不会被误报成工具故障。

## 安装

### 从本地 checkout 安装

```bash
git clone https://github.com/win4r/dsh-pi-review.git
cd dsh-pi-review
pnpm install --frozen-lockfile
pnpm run check

dsh plugin --profile web add -w .
dsh --profile web --dump-config
```

### 从 GitHub 安装

建议固定已审计的 commit：

```bash
dsh plugin --profile web add -w github:win4r/dsh-pi-review#<commit-sha>
```

rc.2 的 Profile 本身是 pnpm workspace root，因此这里显式传 `-w`；省略时，pnpm 10 可能以 `ERR_PNPM_ADDING_TO_ROOT` 拒绝安装。

Git 安装会从源码执行本包的 `prepare` 构建。pnpm 10 默认禁止依赖构建；首次失败时，把 dsh 输出的准确包名加入该 Profile 的 `pnpm-workspace.yaml`：

```yaml
allowBuilds:
  "@charlesqin/dsh-pi-review": true
```

然后重新执行 `plugin add`。这等于授权安装阶段在 Agent 沙箱外运行本仓库的构建脚本；只应对可信源码授权。若不希望授权 Git 构建，可在可信 checkout 中执行 `pnpm pack`，再安装生成的 `.tgz`。

安装、移除或更新 Bundle 后，重启对应 Profile。`--dump-config` 只验证最终组合配置，不会启动插件。

## 配置 Pi 认证与模型

默认以只读快照方式加载 Pi 的 `~/.pi/agent/auth.json` 和 `~/.pi/agent/models.json`；认证刷新和模型目录更新只保存在 Worker 内存中，不会写锁文件或回写 Pi 目录。可先在交互式 Pi 中执行 `/login`：

```bash
npx -y @earendil-works/pi-coding-agent@0.84.2
```

建议在 `cordis.patch.yml` 中显式配置 `provider/model-id`：

```yaml
- insert:
    - id: pi-review
      name: '@charlesqin/dsh-pi-review'
      config:
        authority: direct-human
        model: kimi-coding/k3
        thinkingLevel: high
        timeoutMs: 300000
        maxDiffBytes: 524288
        maxFiles: 200
        maxOutputBytes: 524288
        maxDiagnosticBytes: 65536
        disposeGraceMs: 3000
        requireFullSandbox: true
```

Bundle patch 的同 ID `config` 是整对象替换语义。覆盖 `pi-review` 行时，应重写希望保留的完整配置。

优先使用 Pi `auth.json` 中的字面 API key、OAuth，或显式环境变量引用，避免把密钥直接写入 Harness 配置。Worker 不执行 Pi 配置中的 `!command`：命令型认证 Provider 会被标记为不可用，其他安全 Provider 仍可使用；`models.json` 的 `apiKey`、header 或 env 中出现命令值则整个模型配置 fail closed。若认证或模型必须引用环境变量，可通过 `forwardEnvironment` 显式传入变量名；默认一个也不传。不要转发无关凭据。

自定义 Pi 目录可以用绝对路径配置：

```yaml
agentDir: /absolute/path/to/pi-agent-dir
forwardEnvironment:
  - MY_MODEL_API_KEY
```

例如，可在 `auth.json` 使用 `"key": "$MY_MODEL_API_KEY"`，再只转发 `MY_MODEL_API_KEY`。Worker 固定设置 `PI_OFFLINE=1`，关闭 Pi 的启动更新、包更新和遥测网络操作；模型请求本身仍需要访问所配置的 Provider。Windows 上当前仍可使用内置 Pi 模型和认证，但 v0.1 不加载自定义 `models.json`。

## 使用

安装并重启 Profile 后，在顶层对话中要求 Agent 调用 `pi_review_diff`。例如：

```text
请调用 pi_review_diff，以 working-tree 范围审查当前仓库全部未提交改动，
按严重度汇总 finding，并明确结果是否 stale。
```

工具参数：

| 参数 | 说明 |
| --- | --- |
| `scope: unstaged` | 工作区相对 index 的未暂存改动，并包含 untracked 文件 |
| `scope: staged` | index 相对 `HEAD` 的已暂存改动，不包含 untracked 文件；为避免混入未暂存内容，只开放冻结 diff，不开放当前文件读取/搜索 |
| `scope: working-tree` | 整个工作区相对 `HEAD`，包含 staged、unstaged 与 untracked 文件 |
| `scope: base` | 工作区相对解析后的 `base_ref` commit；必须提供 `base_ref` |
| `paths` | 可选、非空的仓库相对路径过滤列表 |

`base_ref` 只接受普通 ref 或对象 ID，不接受 `HEAD~2`、`A..B` 等 revision expression。它会先解析为不可变 commit，再执行与当前工作区的比较；本版本不会自动计算 merge base。

成功结果包含：

- `verdict`: `clean` 或 `findings`
- `assessment` 与按严重度排序的结构化 `findings`
- `snapshot.head`、可选 `base`、`diffHash`、变更路径与 `stale`
- 实际沙箱 enforcement、Pi 模型 ID 与耗时

若审查期间仓库发生变化，插件仍返回冻结快照上的结果，但把 `snapshot.stale` 标为 `true`；应在新快照上重新审查。

## 配置参考

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `authority` | `direct-human` | 只允许由当前顶层人类消息驱动；`root-turn` 可放行插件/定时来源的顶层轮次 |
| `model` | Pi 当前可用默认模型 | 可选的 `provider/model-id` |
| `thinkingLevel` | `high` | `off` 至 `xhigh` |
| `timeoutMs` | `300000` | 整个快照与审查事务的截止时间 |
| `maxDiffBytes` | `524288` | diff 上限；超限直接失败，不截断 |
| `maxFiles` | `200` | 变更文件上限 |
| `maxOutputBytes` | `524288` | Worker stdout 上限 |
| `maxDiagnosticBytes` | `65536` | Worker stderr 上限 |
| `disposeGraceMs` | `3000` | 子进程终止宽限期 |
| `requireFullSandbox` | `true` | 平台只能提供 partial enforcement 时拒绝运行；设为 `false` 会允许较弱隔离，是不安全的部署级 opt-out |
| `agentDir` | `~/.pi/agent` | 可选绝对 Pi 配置目录 |
| `forwardEnvironment` | `[]` | 显式传给 Worker 的环境变量名 |

`authority: root-turn` 会让 Cron、Plugin 等非人类来源的顶层轮次也能触发审查，适用于自动化，但扩大了调用权限。子 Agent、过期 Agent、无活动 driver、空闲状态或已结束轮次仍然不能调用。

## 安全边界与限制

- 默认要求 Harness 报告 `full` 的 read-only enforcement；实际 macOS 测试证明 Worker 子进程创建文件会被拒绝。
- Git 命令使用固定 argv、关闭 pager/textconv/ext-diff/交互提示、lazy fetch 与 ambient trace/SSH/helper 控制变量，并对路径、ref、输出字节数与文件数 fail-closed。
- v0.1 只支持带物理 `.git/` 目录的独立普通 worktree；linked worktree、`.git` indirection file、`commondir`、object alternates 和仓库级 clean/process/smudge filter 配置会在获取 diff 前被拒绝。普通 `.git/` 元数据属于宿主信任边界，工作树内容仍按不可信数据处理。
- 会从 live worktree 进入审查的 tracked/untracked 当前路径必须是稳定、单链接的普通文件；符号链接、硬链接、submodule 和其他特殊文件会被拒绝。`staged` 审查不会打开 live worktree 文件，以免把同路径的未暂存内容带入模型请求。
- Worker 只使用内存 Session，严格校验单个 stdin 请求、单个 stdout envelope、diff SHA-256、finding 路径/side/line 和输出大小。
- 仓库内容被视为不可信数据，并有 prompt-injection 指令隔离；LLM 仍可能犯错，finding 必须由人复核。
- 当前文件读取仅覆盖变更路径，可能漏掉依赖于未变更文件的跨文件缺陷。
- 二进制路径不开放额外文件读取；模型只能依据 Git binary patch/元数据，不能完成语义级二进制审计。
- 需要至少一个有效 `HEAD` commit；全新且尚未提交的仓库会失败。
- 只读沙箱不阻止模型网络请求，也不保证 Provider 不保留输入。数据治理取决于所选 Provider。
- 插件不会运行测试或编译目标仓库，也不会自动修复代码；它只审查被冻结的改动。

更多披露与报告方式见 [SECURITY.md](./SECURITY.md)。

## 开发与验证

```bash
pnpm run typecheck
pnpm run test
pnpm run build
pnpm audit --prod --audit-level moderate
pnpm pack
```

真实模型冒烟测试是显式 opt-in，会把故意构造的临时代码 diff 发送给指定 Provider。脚本不会执行 Pi `auth.json` 中的 `!command`；需要环境凭据时必须显式列出转发变量：

```bash
PI_REVIEW_SMOKE_FORWARD_ENV=OPENAI_API_KEY \
  pnpm run test:real -- openai/gpt-5.3-codex
```

也可以临时构造一个不落盘到仓库的 OpenAI-compatible 自定义 Pi Provider：

```bash
PI_REVIEW_SMOKE_FORWARD_ENV=MY_PROVIDER_KEY \
PI_REVIEW_SMOKE_CUSTOM_KEY_ENV=MY_PROVIDER_KEY \
PI_REVIEW_SMOKE_CUSTOM_BASE_URL=https://provider.example/v1 \
  pnpm run test:real -- smoke-provider/model-id
```

脚本要求本机 Harness 沙箱达到 `full` enforcement，并验证 Pi 对故意引入的授权回归返回 finding、目标文件及临时模型配置没有变化、Worker 没有创建工作区或 Pi 目录文件。普通 `pnpm test` 不访问模型 Provider。

许可证：MIT。
