# Docker 部署

使用支持 Compose v2 和 BuildKit 的 Docker。工作台可与其他服务共存，端口、数据目录、Compose 项目名和镜像名都可独立选择。

## 构建依赖

准备一个本地 Linux DSH 构建镜像，默认名为 `dsh-build:local`，也可用 `DSH_BUILD_IMAGE` 指定其他名称。镜像需要提供 Node，并在 `/opt/dsh` 下保留已构建的 DSH 工作区、依赖及 TypeScript 编译器。所需包版本和编译产物指纹见仓库根目录的 `compatibility.json`。构建工作台时会校验这些产物，再把运行所需依赖复制到独立的 Node 镜像。宿主系统生成的原生模块需要在 Linux 构建环境中重新安装。

Compose 默认使用 `searxng/searxng:latest` 提供公开搜索。可通过 `DRAMA_SEARCH_IMAGE` 固定兼容版本或镜像摘要。镜像需包含 `/usr/local/searxng/entrypoint.sh`、Python 虚拟环境和 `/healthz` 检查，且支持 `deploy/public-search.yml` 中选定的引擎。正式部署前应验证所用镜像和所需搜索来源。

## 启动

新建可写的数据目录，并将已有的 DSH 模型配置目录以只读方式提供给模型配置服务。在项目目录运行以下命令，将示例路径换成自己的目录。

```sh
mkdir -p .drama
export DRAMA_DATA_DIR="$PWD/.drama"
export DRAMA_DSH_HOME=/absolute/path/to/dsh-config
export DRAMA_UID="$(id -u)" DRAMA_GID="$(id -g)"
export DSH_BUILD_IMAGE=dsh-build:local
docker compose up -d --build --wait
docker compose ps
```

打开 [本机工作台](http://127.0.0.1:4318)。`DRAMA_PORT` 可更改宿主端口。要运行独立演示，可新建空模型配置目录，设置 `DRAMA_DEMO=1`、`DRAMA_DSH_HOME` 以及单独的 `DRAMA_DATA_DIR`。默认端口仅绑定本机。工作台容器只挂载自身数据和模型读取 socket，模型配置服务只读挂载指定的 DSH 目录。默认编排未暴露宿主 Docker socket。

公开网络只向获得授权的 Worker 开放。维基百科为直接搜索，其他勾选的引擎通过内置 SearXNG 或工作台配置的搜索地址查询。每个来源的可用性取决于网络和上游服务。

## 备份与验证

在任务到达可暂停的位置后停止本工作台，完整备份 `DRAMA_DATA_DIR`，再启动服务。恢复时把备份复制到新的空目录，将 `DRAMA_DATA_DIR` 指向该目录，再启动独立实例。一个数据目录只能有一个工作台进程持有写入锁。

```sh
docker compose stop
# 在此处复制完整数据目录
docker compose start
```

`docker compose logs --tail 50 workbench` 可以查看启动信息。若已构建并设置好 `DRAMA_IMAGE`，可运行 `node scripts/drama-docker-smoke.mjs` 检查临时实例的模型目录刷新、审核和导出，以及容器重建后的数据恢复。该脚本会创建独立的 Compose 项目和临时作品数据。
