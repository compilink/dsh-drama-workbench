# 提交与推送前检查

在每份新克隆中安装 Python 3.9+ 和官方 [Gitleaks 8.30.1](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1)，然后在仓库根目录执行：

```sh
git config --local core.hooksPath .githooks
python3 scripts/check-publication.py staged
```

第二行可随时重查整个暂存快照。若 Gitleaks 放在项目专用目录，可用 `git config --local studio.gitleaks /absolute/path/to/gitleaks` 指定。缺少工具、版本不符或扫描失败会阻止提交和推送。新克隆需要单独启用 Git hooks。

提交前按 Git 对象读取全部暂存文件，包括部分暂存和改名后的内容。检查会拦截强制添加的忽略文件、数据库和密钥路径、本机用户目录、已知私有内容及 Gitleaks 识别的凭据。普通提交、自动合并和应用邮件补丁也会检查提交说明。一般只需取消暂存或清理相关内容，再重新提交。推送前会检查待传递的每个提交及其文件、提交说明和附注标签，因此在后续提交删除敏感文件仍需先清理中间提交。新增远端分支时会核查完整祖先记录。

本机还可维护下列文件。用 `git rev-parse --git-path 文件名` 查询位置，文件只存在于本地 Git 目录。SHA-256 均指原始文件字节的哈希。

| 文件名 | 每行内容 | 用途 |
| --- | --- | --- |
| `studio-private-markers` | 一个 UTF-8 字面短语，区分大小写，跳过空行 | 发现复制到其他文件中的专有文字、标识或部署信息 |
| `studio-private-sha256` | 64 位十六进制 SHA-256 | 即使改名也能识别完整私有文件 |
| `studio-reviewed-binaries` | 64 位十六进制 SHA-256 | 对已人工检查的特定二进制版本放行，内容变化后需要重新检查 |

本地专用文件路径应写进版本化的 `.gitignore` 或本地 `.git/info/exclude`。忽略规则按每次提交自己的快照求值。二进制文件需要确认来源与内容，Git LFS 指针及子模块无法检查实际内容，默认拦截。扫描提示包含路径和规则名，匹配原文不写入日志。首次新建专用词表、文件变更后都可手动重查暂存内容。Git 本地 hooks 可以被人为跳过；远端接收策略由 Git 托管平台管理。
