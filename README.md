# dsh-session-delete

> 在 DSH 侧边栏对话菜单中**真正永久删除**会话 —— 从文件系统层面删除会话日志，而不是像归档那样仅仅隐藏。

DSH 官方客户端目前只提供「归档会话」（把会话从列表隐藏，日志文件仍留在磁盘）。本插件在会话行 `···` 菜单的「归档对话」下方新增「**删除对话**」入口：点击并确认后，会话的日志文件会从磁盘彻底删除，**不可恢复**。

## 功能特性

- ✅ **真实物理删除**：通过官方 `sessionPersistence.locate()` 定位会话目录并递归删除日志文件，非隐藏、非标记删除
- ✅ **运行中的会话也能删**：自动取消正在进行的回复 → 从内存摘除 → 删除文件，删除后不会被内存日志"复活"
- ✅ **记账同步清理**：`workspace.json` 的会话席位与全局归档集合一并清除，不留脏数据
- ✅ **即时刷新**：删除后会话行立即消失，无需刷新页面（复用官方 store 刷新与事件帧）
- ✅ **二次确认**：删除前弹出确认框，显示会话标题并明确提示不可恢复
- ✅ **识别准确**：依据官方快照 store + 侧边栏行序 + 标题三重校验定位会话，避免误删
- ✅ **零依赖**：仅使用 Node 内置模块与注入的官方服务，无第三方运行时依赖

## 使用场景

- 清理不再需要的实验性对话、临时会话，释放磁盘空间
- 删除包含敏感内容的会话，确保日志从磁盘彻底消失
- 归档无法满足的"彻底删除"需求（归档只是隐藏，文件仍可被搜索/导出找回）

## 安装

```sh
npx -p @deepseek-ai/dsh dsh plugin --profile web add <owner>/dsh-session-delete
```

安装完成后**重启 dsh web** 生效。

> 也可以从 GitHub 仓库地址安装：`npx -p @deepseek-ai/dsh dsh plugin --profile web add github:<owner>/dsh-session-delete`

## 使用

1. 在左侧对话列表找到目标会话，将鼠标移到该行，点击行尾的 `···` 按钮；
2. 菜单中「归档对话」下方点击「**删除对话**」（英文界面为 `Delete session`）；
3. 在确认弹窗中点击「确定」；
4. 会话行立即从列表消失，磁盘上的会话日志已永久删除。

> 删除**正在运行**的会话时，会先中止该会话的回复再执行删除。

## 工作原理

DSH 官方没有为会话行菜单提供扩展 slot，本插件采用 host + client 双半端实现：

- **Host 半端**（`lib/index.js`）：注册本地路由 `POST /session-delete/api/delete`。
  - 校验 `sessionId`（严格 `session-<uuid>` 格式，杜绝路径穿越）与请求来源：复用 DSH 官方 `connection` 服务的 Host/Origin 围栏与浏览器会话认证（旧版本 DSH 无该服务时回退到仅 localhost）；
  - 冷会话（不在内存中）的 header 通过官方 `sessionPersistence.list()` 的 `{ header, revision, sizeBytes, location }` 快照解析；
  - 若会话在内存中（打开/运行）：通过官方 `agents` 服务取消当前 turn，再通过 `sessions` store 的标准 `detach()` 路径摘除内存会话（触发官方 `host/session-removed` 帧），防止内存日志把文件"复活"；
  - 通过官方 `sessionPersistence.locate()` 定位会话目录（`~/.dsh/sessions/<workspace-key>/session-<uuid>/`），递归删除；
  - 通过官方 `workspaceRegistry` 的操作队列清理记账（workspace 的 `sessionIds` 席位与全局归档集合），前端经官方 `domain/changed` 帧自动同步。
- **Client 半端**（`lib/client.js`）：监听会话菜单渲染 DOM（`role="menu"`），在「归档会话」下方克隆注入「删除对话」项；点击时依据官方快照 store（`ctx.sessions.list` / `ctx.workspaces.list`，与 UI 渲染同一份数据）+ 侧边栏行序定位 sessionId，并以行标题（aria-label）二次校验；确认后调用删除路由，成功后通过官方 `ctx.sessions` / `ctx.workspaces` 运行时服务刷新列表。

## 安全与边界

- 删除请求复用 DSH Web 自身的信任围栏：仅接受来自 `trustedHosts`（或本机回环地址）且已通过浏览器会话认证的同源请求，反向代理（如 nginx 局域网入口）部署也可正常工作；
- `sessionId` 严格校验为 `session-<uuid>` 格式，杜绝路径穿越；
- 附件（图片等）是跨会话共享资源，**不随会话删除**，避免破坏其他会话的引用；
- 运行中会话的删除需要先中止其回复（不可恢复的操作，确认框中已明确提示）；
- 删除的是目标会话本身；其子代理会话（`subagents/`）各自独立存储，如需一并删除请逐个操作。

## 已知限制

- 菜单注入依赖官方客户端的 DOM 结构与「归档会话 / Archive session」菜单文本，DSH 官方升级若调整该菜单结构，本插件可能需要同步适配；
- 会话的查询/投影缓存不强制清理，官方缓存机制会在下次读取时自愈。

## 常见问题

| 问题 | 说明 |
| --- | --- |
| 点击后提示"无法识别该会话" | 侧边栏行与数据快照短暂不一致时可能出现；刷新页面后重试即可（控制台会输出诊断信息） |
| 提示"该会话当前处于打开状态且无法从内存移除" | 极少数情况下内存摘除不可用，重启 DSH 后即可正常删除 |
| 通过 nginx 等反向代理访问时提示"删除失败：forbidden" | 旧版本只接受 localhost 的请求；当前实现复用 DSH 的 `connection` 信任围栏，请确认启动参数里用 `--trusted-host` 声明了代理访问的 authority |
| 侧边栏能看到会话，删除时却提示"会话不存在" | 旧版本把 `sessionPersistence.list()` 的返回值当成 header 数组；当前实现按 `header.id` 解析，冷会话也可正常删除 |
| 删除后磁盘占用没有减少 | 附件为跨会话共享资源，不会被删除；仅会话日志目录被移除 |

## 免责声明

删除操作**不可恢复**，请确认后再点击。使用本插件造成的任何数据损失由使用者自行承担；本插件仅提供删除功能，不构成任何担保。

## License

MIT
