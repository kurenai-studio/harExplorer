---
name: wechat-minigame-analysis
description: >-
  分析本机已缓存的微信小游戏静态包，并写出 harExplore 查看器要展示的结果。
  在用户要看微信小游戏包、wxapkg、小游戏引擎、分包对照，或要在主查看器里看包内原图和音频时使用。
---

# 微信小游戏静态分析

harExplore 只展示结果。分析由本 skill 驱动，解密和拆包调用仓库里的脚本。主查看器里「微信小游戏」下面的「重新分析」会复制一段提示词，里面是本机缓存目录和产物路径。收到后按下面的步骤做，每个游戏单独一个来源，不要在查看器里另写一套扫描。

## 做一次分析

在 harExplorer 仓库根目录：

```bash
npm run minigame
npm run minigame -- --wxid wx0123456789abcdef
```

脚本只读微信缓存。主包用来写分析摘要。已缓存包和 `gamecaches` 里的图片、音频会进主查看器。`.astc` 会解码成 PNG。缓存 JSON 会按 HAR 的方式认序列帧、图集、Spine（必须同时有 skeleton 和 atlas）和位图字体。

写出：

- `dist/minigame/index.json`
- `dist/minigame/<wxid>-<version>.json`
- `dist/texture-viewer/catalog.json` 里的微信来源，以及 `embedded/`、`audio/`、`animations/`、`fonts/`

然后打开主查看器（`http://127.0.0.1:8765/`），点来源标签看纹理和音频。服务没开时：

```bash
npm run serve -- --host 127.0.0.1
```

## Agent 要核对的事

读结果 JSON，不要把整份 `game.js` 贴进对话。核对：

- `overview.engine` 是否和 `analysis.engine.mainScriptHits`、包文件名一致
- `analysis.subpackages.missing` 是还没下载，还是主包配置多写了
- 有 `StreamingAssets` 时，牌桌资源在 Unity 侧

确认这是 taxon 里还没有的类别时，把一句话写进该结果的 `taxonHint`。不要自动发给 taxon，也不要写入公网 Kura。

## 不要做

- 不改微信缓存，不把改过的包写回去
- 不在查看器的上传接口里做这次分析
- 不把第三方包的脚本全文写进结果或提交进 git
