# 生产部署与运维手册

> 目标：把 Alexandria 作为组织内部知识基础设施运行，而不是单机演示。当前版本是**单节点 SQLite + 本机 DSH** 架构，适合中小团队；高可用/多节点需要外置数据库与对象存储。

## 1. 进程与端口

```bash
cd alexandria
node server/src/main.ts
```

- 默认监听 `127.0.0.1:4520`；生产放在 Nginx/Caddy 后，仅暴露 HTTPS。
- 建议使用 launchd / systemd 托管，失败自动重启。
- 健康检查：`GET /api/health`，关注 `ok`、`dsh`、`llm`；`GET /api/health/ready` 用于编排系统就绪探针。
- 巡检：管理员「运行状态」或 `GET /api/admin/observability` 查看队列、内容规模、SQLite/WAL、备份和进程内存。
- 维护任务：每小时清理过期会话/登录挑战/SSO state；回收站超过 `ALEXANDRIA_TRASH_RETENTION_DAYS`（默认 30 天）自动清理；`ALEXANDRIA_AUTO_BACKUP_HOURS>0` 时按周期自动备份。
- 登录限流：同一 IP + 邮箱 15 分钟 8 次失败后返回 429；多副本需替换为 Redis 限流。
- 已启用 CSP、HSTS（HTTPS）、Secure Cookie、X-Frame-Options、nosniff。
- 企业微信 Mock 仅用于联调，生产关闭或限制在内网。

## 2. 必配环境

```bash
ALEXANDRIA_PORT=4520
ALEXANDRIA_PUBLIC_URL=https://kb.example.com
ALEXANDRIA_DATA_DIR=/var/lib/alexandria
ALEXANDRIA_WEB_DIR=/opt/alexandria/web
ALEXANDRIA_DSH_ENABLED=true
ALEXANDRIA_WECOM_MODE=wecom
ALEXANDRIA_WECOM_CORP_ID=...
ALEXANDRIA_WECOM_AGENT_ID=...
ALEXANDRIA_WECOM_SECRET=...
ALEXANDRIA_WECOM_CALLBACK_TOKEN=...
ALEXANDRIA_WECOM_ENCODING_AES_KEY=...
```

- DSH 凭据放在运行用户可读的 `~/.dsh/.credentials.yaml`，或只注入 `DEEPSEEK_API_KEY`；**不要**写入数据库/前端。
- 企业微信 Secret、Token、EncodingAESKey 通过环境变量或管理端写入 meta；接口不回显 Secret。
- 企业 SSO：配置 `ALEXANDRIA_OIDC_ISSUER/CLIENT_ID/CLIENT_SECRET/REDIRECT_URI`；仅映射已存在的本地 active 账号，不自动创建账号。
- 2FA：管理员/高权限账号建议启用 TOTP；密码策略要求 ≥10 位且含大小写、数字与符号。
- 异常登录：同一 IP+邮箱触发限流时，向组织管理员发送站内/企微告警。
- SCIM：配置 `ALEXANDRIA_SCIM_TOKEN` 后启用 `/scim/v2/Users`、`/scim/v2/Groups`；令牌放在 IdP 的 provisioning secret 中，不写前端。SCIM 删除为停用，不物理删除人员。
- 生产必须使用企业微信加密 XML 回调 `/api/wecom/callback`，不要使用 JSON Mock 回调。

## 3. 数据与备份

数据目录包含：

```text
data/
  alexandria.db        # SQLite 主库（WAL）
  uploads/             # 原始文件、附件
  thumbnails/          # 缩略图
  dsh-home/            # 本机 DSH profile（可重建）
  seed/                # 演示资产（可删）
```

备份建议：

1. 运行 `npm run backup`（可用 `ALEXANDRIA_BACKUP_KEEP_DAYS` 控制保留天数），生成 `data/backups/alexandria-<timestamp>/`（数据库 + uploads + thumbnails + manifest）；
   或应用停机后复制 `data/alexandria.db`；
2. 同步备份 `uploads/` 与 `thumbnails/`（原始证据不可重建）；
3. 备份文件加密后异地保存，保留 30/90 天；
4. 备份 manifest 会记录 `integrity_check`、schema 版本与人数/页面/文献计数；恢复前复核后再切换。
5. 定期在隔离环境恢复演练：`ALEXANDRIA_DATA_DIR=/tmp/restore npm run restore -- <backupDir>`，确认 `PRAGMA integrity_check` 与账号/权限/文件后再切换。

## 4. 权限上线检查

- 团队树与负责人已按真实组织配置；
- 知识库 `owner_team_id` 正确；
- 私有库、受限页面、受限文献的共享对象经过复核；
- 组织管理员数量最小化；
- API Key 按“只读/读写”最小权限发放，离职/项目结束及时吊销；
- 检查 `audit_events` 与 `library_grants`，避免“internal = 全员可见”的旧假设。

## 5. 质量与容量

- 入库 DSH 编译已移入 worker；检索 DSH 重排有 2.5s 上限，超时回退本地排序；知识合成异步补入页面，不阻塞结果首屏。
- FTS5 中文单字/双字切分适合中小规模；十万级页面建议增加独立索引服务或 PGroonga/Meilisearch 适配层。
- 资料处理使用 worker_threads 队列（`ALEXANDRIA_INGEST_CONCURRENCY`，默认 1），避免 DSH 编译阻塞 HTTP；进程重启时会恢复排队任务。
- 多节点/高可用仍需外部队列（Redis/SQS）、共享数据库与对象存储，当前版本未实现。
- 页面/文献 ACL 在应用层过滤；所有新增查询必须走 `effectivePageRole` / `effectiveSourceRole`，并补充权限测试。

## 6. 监控与审计

- 健康检查 + 进程存活；
- 任务失败率、DSH 超时率、平均编译耗时、队列深度；
- 登录失败、API Key 使用、权限变更、导出行为；`security_events` 记录登录成功/失败/限流、API Key、授权与 ACL 变更；
- 权限变更会给受影响成员创建站内通知，并尝试企微应用消息；
- SQLite 文件大小、WAL 增长、备份成功；
- 建议把 `/api/tasks` 与 `audit_events` 接入组织日志平台（当前无内置告警）。

## 7. 已知边界

- 无多租户隔离、无 SSO（除企业微信/OIDC 预留）、无实时协同；
- 旧版 DOC/WPS 解析质量依赖 LibreOffice；
- 纯矢量扫描 PDF 需外部渲染器；
- Redis 队列、对象存储、全文检索集群未实现；
- 本手册描述的是当前代码可验证的能力，不替代安全评审与渗透测试。
