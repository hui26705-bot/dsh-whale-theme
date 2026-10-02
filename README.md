# dsh-whale-theme

深海主题 + 看板娘插件 for DeepSeek Harness。

- 开场动画、深海壁纸、循环看板娘（右下角）
- 悬浮看板娘弹出两个选项：今日 token 用量统计（含模型分项）、小鲸鱼图库
- 启用插件默认深色外观（可在设置里手动切换回来）

## 安装

DeepSeek Harness → 插件 → 右上角“+ 添加”→ 输入：

```
https://github.com/hui26705-bot/dsh-whale-theme
```

点安装，重启生效。升级时先卸载旧版再装新版（暂不支持自动更新）。

本地安装也可以：在添加框里粘贴解压后的文件夹路径。

## 目录

- `lib/` 运行代码（`client.js` 为预打包产物，改完 `client-src/` 后用 esbuild 重打）
- `assets/` 生效素材：`intro.mp4` / `mascot.webp` / `wallpaper.jpg`（同名替换即可）
- `cordis.patch.yml` 插件注册 + 深色外观默认值
