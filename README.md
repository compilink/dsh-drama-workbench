# DSH 剧本工作台

在浏览器中管理作品、资料和分集，在同一张画布上组织调研、设定、写作、审稿和导出。每个作品拥有独立的工作流和总编会话。Agent、Skill 和版本化模板可跨作品复用。

## 启动本地演示

准备 Node.js 22.19 以上的 22.x 或 Node.js 24 以上，以及一个独立、已经构建的 DeepSeek Harness 源码目录。项目通过公开包接口读取 DSH 的编译产物。使用的 DSH 包版本为 `0.1.1-rc.2`，具体依赖和校验值见 `package.json` 和 `compatibility.json`。在对应 DSH 源码目录按该版本说明安装依赖并完成构建，然后在工作台目录执行以下命令。

```sh
export DSH_ROOT=/absolute/path/to/deepseek-harness
npm run bootstrap
npm run workbench:demo -- --data-dir .drama-demo --port 4318
```

打开 [本机工作台](http://127.0.0.1:4318)。演示模式使用确定性的模拟角色，可以体验建图、执行、审稿和导出。真实模型使用另一个数据目录启动。

```sh
npm run workbench -- --dsh-home /absolute/path/to/dsh-config --data-dir .drama --port 4318
```

`--dsh-home` 指向已配置模型的 DSH 用户配置目录。打开模型目录刷新并测试连接，再在 Agent 页面选择模型、推理等级、允许委派的下属和所需权限。请把作品资料、凭据、导出和备份留在工作目录以外或已忽略的目录中。Docker 运行方式和数据迁移见[部署指南](docs/drama-docker.md)。

## 从创作到交付

1. 在 Agent 页选择总编（Orchestrator）、主编（Manager）和执行者（Worker）。总编与主编可以编排分工和验收，Worker 执行创作或调研。调研授权和搜索来源在工作台配置。
2. 在作品库创建作品，选择模板或用空白画布起步。在画布空白处右键添加节点，拖拽连线，设置指令、输入和输出检查，以及人工审核条件。保存草稿后再执行。
3. 从资料页或节点面板提供内容。节点准备好后调度器读取上游批准版本。可以暂停、恢复、重跑或追加独立任务。在总编对话中也可以查看进度、提出画布修改和管理运行。
4. 在成果页审阅或退回确切版本。选中原文可以提交批注、派发修订并对照采纳。节点成果和分集可导出为 Word 或 Markdown。归档作品后，可单独选择删除。

画布、模板和审核操作见[工作台操作](docs/drama-workbench-controls.md)。任务委派、重跑和上下文见[角色执行](docs/drama-role-execution.md)。总编可以在对话中完成的操作见[总编对话管理](docs/drama-editor-control.md)。

## 开发与验证

```sh
npm run check
```

该命令校验 DSH 依赖、编译 TypeScript、运行 Node 测试。普通测试使用临时数据和模拟模型。依赖 Docker、浏览器或真实提供方的验证需要另行准备对应环境。组件分工和持久化数据见[架构说明](docs/architecture.md)。

开发时请先[启用提交和推送前检查](docs/commit-checks.md)。
