# 单节点部署参考

## systemd

```bash
sudo useradd --system --home /var/lib/alexandria --shell /usr/sbin/nologin alexandria
sudo mkdir -p /opt/alexandria /var/lib/alexandria /etc
sudo rsync -a --exclude node_modules --exclude data ./ /opt/alexandria/
sudo install -m 0644 deploy/alexandria.service /etc/systemd/system/alexandria.service
sudo install -m 0600 /dev/null /etc/alexandria.env   # 写入生产环境变量
sudo systemctl daemon-reload
sudo systemctl enable --now alexandria
```

`/etc/alexandria.env` 至少包含：

```bash
ALEXANDRIA_HOST=127.0.0.1
ALEXANDRIA_PORT=4520
ALEXANDRIA_DATA_DIR=/var/lib/alexandria
ALEXANDRIA_PUBLIC_URL=https://kb.example.com
ALEXANDRIA_DSH_ENABLED=true
```

DSH 需要运行用户可读的 `~/.dsh` 凭据；若容器化/多副本，应把 DSH 放到独立 sidecar 或受控远程运行时，而不是把凭据放进镜像。

## Nginx 反向代理

```nginx
server {
  listen 443 ssl http2;
  server_name kb.example.com;
  client_max_body_size 100m;
  location / {
    proxy_pass http://127.0.0.1:4520;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 120s;
  }
}
```

## 上线检查

- `GET /api/health/ready` 返回 `database=true`。
- `GET /api/health` 显示 `dsh=true`（若启用 DSH）。
- 管理员「运行状态」队列为 0，备份存在且 manifest 校验通过。
- 安全审计无异常登录；2FA 已为高权限账号启用。
- 反向代理限制上传大小、超时与访问来源。
