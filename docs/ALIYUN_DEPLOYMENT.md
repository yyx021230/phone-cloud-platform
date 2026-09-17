# 阿里云上线部署清单

## 已有生产环境更新约束（D-075，2026-09-11）

以下通用安装步骤不授权重装当前媒体服务。当前云端→浏览器已全局开启**每路8 Mbps / 2包一组的原生平滑发送**，必须保留自定义MediaMTX二进制和 `/etc/systemd/system/phone-cloud-mediamtx.service.d/75-viewer-pacing.conf`。官方原版不包含该功能，不能作为普通版本更新或业务回滚的一部分覆盖；旧 `install-mediamtx.sh` 已阻止此类覆盖。

- 基线与二进制SHA256记录在 `deploy/mediamtx-pacing/production-baseline.json`，变更须单独得到用户同意。
- 本地先运行 `node deploy/mediamtx-pacing/verify.mjs --repository` 和 `node --test scripts/media-pacing-baseline.test.mjs scripts/deployment-baseline.test.mjs`。
- 发布前后在媒体宿主机运行 `node deploy/mediamtx-pacing/verify.mjs --live`，用具备读取服务 `/proc` 权限的运维账户执行。校验仅只读，不输出环境中的密码/Token，不重启服务；失败则停止发布，不能自动降回官方原版。
- 常规compose部署无论 `RUN_PREFLIGHT` 是否关闭，都执行前后检查；检测到本机媒体二进制、unit或drop-in任一项即要求live核验。无本机媒体时只能报 `repository-only`，分机部署仍需对实际媒体宿主机额外核验，不得当作线上验收通过。
- 新建媒体宿主机应先按D-075审核自定义构建/安装方案，不能继续用旧官方安装入口。一般业务部署只更新业务容器，不动媒体、Windows、ADB或画质配置。
- 此防回退脚本是本地新增保护，未在记录本条要求时重新发布生产；后续必须从包含这些文件的已审核项目版本发布，旧checkout/绕过脚本的手工命令不受它自动保护。

目标架构：

- 阿里云 ECS 运行网站、API、Postgres 和 Nginx。
- Windows 管理器只主动访问阿里云 HTTPS，不开放公网端口。
- 阿里云安全组只放行 `80` 和 `443`，SSH 端口只允许你的固定 IP。
- 用户通过 HTTPS 网页使用短信接收和小红书扫码。

## 1. 服务器准备

推荐系统：Ubuntu 22.04 LTS 或 Ubuntu 24.04 LTS。

安全组：

- 入方向开放 `80/tcp`、`443/tcp`。
- SSH 端口只允许管理员固定 IP。
- 不开放平台内网端口 `8787`。

域名：

- 添加 A 记录指向 ECS 公网 IP。
- 等 DNS 生效后再申请 HTTPS 证书。

安装基础依赖：

```bash
sudo apt update
sudo apt install -y git curl ca-certificates nginx certbot python3-certbot-nginx docker.io docker-compose-plugin
sudo systemctl enable --now docker nginx
```

## 2. 部署平台

```bash
cd /opt
sudo git clone <your-repo-url> phone-cloud-platform
sudo chown -R "$USER":"$USER" /opt/phone-cloud-platform
cd /opt/phone-cloud-platform
PUBLIC_BASE_URL=https://phone.example.cn deploy/scripts/aliyun-docker-deploy.sh
```

脚本会完成：

- 生成生产 `.env`。
- 创建 `data/` 和 `logs/`。
- 执行生产预检。
- 构建并启动 `docker compose`。

记下脚本输出的管理员账号密码，并妥善保存 `.env` 中的三个机器 token：

- `ADMIN_API_TOKEN`
- `WINDOWS_AGENT_TOKEN`
- `DEVICE_AGENT_TOKEN`

## 3. 配置 Nginx 和 HTTPS

首次申请证书时先使用 HTTP 临时配置：

```bash
cd /opt/phone-cloud-platform
DOMAIN=phone.example.cn \
TEMPLATE=deploy/nginx/phone-cloud-http.conf.example \
OUTPUT=/tmp/phone-cloud-http.conf \
deploy/scripts/render-nginx-config.sh
sudo cp /tmp/phone-cloud-http.conf /etc/nginx/sites-available/phone-cloud.conf
sudo ln -sf /etc/nginx/sites-available/phone-cloud.conf /etc/nginx/sites-enabled/phone-cloud.conf
sudo mkdir -p /var/www/certbot
sudo nginx -t
sudo systemctl reload nginx
```

申请证书：

```bash
sudo certbot certonly --webroot -w /var/www/certbot -d phone.example.cn
```

证书成功后切换到 HTTPS 配置：

```bash
cd /opt/phone-cloud-platform
DOMAIN=phone.example.cn OUTPUT=/tmp/phone-cloud.conf deploy/scripts/render-nginx-config.sh
sudo cp /tmp/phone-cloud.conf /etc/nginx/sites-available/phone-cloud.conf
sudo ln -sf /etc/nginx/sites-available/phone-cloud.conf /etc/nginx/sites-enabled/phone-cloud.conf
sudo nginx -t
sudo systemctl reload nginx
```

证书成功后再确认：

```bash
curl -I https://phone.example.cn/healthz
curl https://phone.example.cn/readyz
```

## 4. 启用自动备份

```bash
cd /opt/phone-cloud-platform
APP_DIR=/opt/phone-cloud-platform deploy/scripts/install-backup-timer.sh
APP_DIR=/opt/phone-cloud-platform deploy/scripts/backup-current-storage.sh
```

`install-backup-timer.sh` 默认使用当前登录用户运行备份任务。如果你希望备份任务使用固定系统用户，可以设置：

```bash
BACKUP_USER=phonecloud BACKUP_GROUP=phonecloud APP_DIR=/opt/phone-cloud-platform deploy/scripts/install-backup-timer.sh
```

备份文件默认在：

```text
/opt/phone-cloud-platform/data/backups/
```

## 5. 上线核验

```bash
cd /opt/phone-cloud-platform
deploy/scripts/preflight-production.sh
SERVER_BASE_URL=https://phone.example.cn \
ADMIN_API_TOKEN=<admin-token> \
WINDOWS_AGENT_TOKEN=<windows-token> \
DEVICE_AGENT_TOKEN=<device-token> \
ADMIN_USERNAME=<admin-username> \
ADMIN_PASSWORD=<admin-password> \
deploy/scripts/smoke-test-platform.sh
```

后台页面核验：

- “诊断检查”没有失败项。
- “APK 发布”已经发布 Android Agent APK。
- “Windows 管理器”能看到 Windows 主机在线。
- “手机设备”能看到两台手机 ADB 在线。
- “诊断检查”能看到 Windows 管理器和 Airtest/Poco 状态。

## 6. Windows 管理器接入

Windows 上配置 `windows-agent/config.json`：

```json
{
  "serverBaseUrl": "https://phone.example.cn",
  "agentToken": "<WINDOWS_AGENT_TOKEN>",
  "adbPath": "C:\\platform-tools\\adb.exe",
  "apkPath": "",
  "cacheDir": "C:\\phone-cloud-cache"
}
```

启动：

```powershell
cd phone-cloud-platform\windows-agent
node src\index.mjs
```

Windows 侧只需要能访问 `https://phone.example.cn`，不需要公网入站端口。

## 7. 两台手机验收

1. 手机开启 USB 调试并授权 Windows 主机。
2. 后台“Windows 管理器”页确认手机 ADB 在线，Airtest/Poco 自动化环境就绪。
3. 后台“手机设备”页给手机绑定 SIM 手机号和小红书账号备注。
4. 创建普通用户。
5. 用第三方验证码接口或普通用户接口完成一次短信验证码接收。
6. 用普通用户提交一次小红书二维码扫码任务。

## 8. 日常运维命令

```bash
cd /opt/phone-cloud-platform
docker compose ps
docker compose logs -f --tail=200 phone-cloud
docker compose logs -f --tail=200 postgres
deploy/scripts/backup-current-storage.sh
deploy/scripts/preflight-production.sh
```

更新代码后：

```bash
cd /opt/phone-cloud-platform
git pull
deploy/scripts/aliyun-docker-deploy.sh
```
