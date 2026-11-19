# 悬浮看台生成器

在已有空间的快照上运行 `uv run --script build.py snapshot.json output --bindings scene.json`。输出目录包含生成的 GLB、物件列表和该次快照对应的地块操作。生成不会发布场景。省略绑定文件时，按快照中的空间编号从同目录的 `bindings.json` 读取现有配置。

最小绑定只需要内场区域和输出区域。内场按区域所有格子盒的外包围盒定位，默认取最低面，可用米制 `floorY` 指定楼层。示例配置如下。

```json
{
  "infieldRegion": "hall",
  "outputRegion": "plaza",
  "screen": { "entity": "display", "facePath": [0] }
}
```

`screen` 可省略。`facePath` 是从模型的 shape 根节点到四边形贴图面板的子节点索引路径，根节点自身就是面板时传空数组。楼身的过渡可以通过 `upperBuilding`、`facades`、`entrance`、`floorSlab` 和 `alwaysVisible` 绑定已有物件。具体的前厅配置见同目录的绑定文件。使用其他区域或模型时可以单独提供这个 JSON。
