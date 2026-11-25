# 本机创作规则

在项目根目录的 `.local/video-editorial.json` 中保存团队自用的视频编剧与审片规则。启动服务时按字段覆盖程序自带的默认值，未填写的字段保留默认值。也可用环境变量 `STUDIO_VIDEO_EDITORIAL_FILE` 指定文件。显式指定的文件缺失、内容格式错误或含未知字段时，启动会报错。

```json
{
  "writingRules": ["在每个镜头旁标注预计秒数。"],
  "scriptFormat": "交稿前逐项检查\n{rules}",
  "reviewItems": ["核对片头和片尾时长。"],
  "reviewNote": "记录需要修改的时间点。"
}
```

| 字段 | 作用 |
| --- | --- |
| `writingRules`、`reviewChecklist` | 编剧和交付阶段各自的逐条检查项，使用字符串数组 |
| `scriptFormat`、`renderFormat` | 生成阶段指令的文本，须含用于插入检查项的 `{rules}` |
| `audioInstruction` | 音频制作指令 |
| `briefCompletion`、`scriptRole`、`scriptCompletion`、`audioCompletion` | 角色名称或对应阶段的完成标准 |
| `audioExecutor`、`visualExecutor`、`renderExecutor`、`probeExecutor` | 工具契约展示的执行器名称；执行权限和可用状态由程序管理 |
| `reviewItems`、`numberedReview`、`reviewNote` | 审片页面的清单、是否编号及补充说明 |

容器运行时可将宿主机配置文件只读挂载到 `/app/.local/video-editorial.json`，并给容器进程读取权限。配置在服务下次启动时生效。
