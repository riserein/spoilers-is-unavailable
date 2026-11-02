# Lore Spoilers · 逐条权限版 (v1.1.0)

基于 [cha1latte/lore-spoilers](https://github.com/cha1latte/lore-spoilers) (MIT) 的**逐条可见性扩展**。原版的“一键把整本世界书显示成 ROT13”改为按条目标记「🌐 公开 / 🔒 隐藏 · AI 可读」。

## 能做到
- 对选中的世界书逐条指定 **公开** 或 **隐藏（仅 AI 可读）**。
- 支持搜索标题 / UID / 关键词；提供逐条下拉与全部公开/隐藏。
- 作者模式下编辑所有条目，关闭作者模式可预览玩家看到的界面。
- **不更改正文**，不更改世界书的关键字触发、常驻、预算、深度等 AI 注入规则。
- 权限标记写入 `entry.extensions.lore_spoilers_visibility`，使用 SillyTavern 原生的世界书保存机制；兼容原生角色卡世界书转换的扩展字段。
- 简体中文界面，兼容移动端窄屏。

## 关键安全限制（务必阅读）
这个版本只能隐藏 **装有并启用了本扩展的 SillyTavern 前端** 世界书显示内容。
**不是加密、防反编译或真正的玩家权限控制。** 原文仍然保存在世界书及导出角色卡文件中，也会正常传给 AI。
1. 玩家没安装插件，隐藏无效。
2. 玩家能自行开启「作者模式」、禁用扩展、打开开发者工具、查看角色卡 PNG/JSON 或世界书 JSON，从而读到所有原文。
3. 插件不能让一个运行在玩家机器上的 AI 请求既包含秘密明文、又保证玩家完全无法读到。
4. 不建议将真正需要保密的隐藏剧情直接随角色卡分发。需要真正保密时，必须把秘密存放在作者控制的服务端，并通过服务端代理调用模型。
5. 扩展不能自动安装给角色卡接收方；必须由玩家自行安装，或部署在你控制的 SillyTavern 环境中。

## 从 GitHub 安装（推荐）

- 打开 SillyTavern → 扩展 → 安装扩展（Install Extension）。
- Git 仓库地址填写：`https://github.com/riserein/spoilers-is-unavailable`
- 无需指定其他分支，使用 `main` 即可。
- 安装后刷新页面，在扩展设置中启用「世界书逐条权限」。

## 安装（本地 Windows SillyTavern）
1. 解压 ZIP，得到 `lore-spoilers-selective` 文件夹。
2. 放入 `SillyTavern/data/default-user/extensions/third-party/`（其他账号则在相应用户目录下）。
3. 最终路径应为 `.../third-party/lore-spoilers-selective/manifest.json`，不要多套一层文件夹。
4. 重启 SillyTavern 或重新加载页面，扩展设置中找到「世界书逐条权限」。
5. **作者**勾选「启用」和「作者编辑模式」，打开「世界书」并选择要编辑的世界书。
6. 每条条目的下拉框中选择「公开 / 隐藏」，也可在顶部批量搜索修改。自动保存到世界书。
7. 取消「作者编辑模式」检查玩家预览：隐藏条目不会显示在世界书编辑列表中。
8. 玩家若安装本扩展，默认进入非作者模式，自动隐藏被标记的条目。**玩家可以自行改变这一状态。**

如果你此前安装过原版 `lore-spoilers`，建议先禁用旧版，再使用此版本，以免两个扩展同时修改世界书界面。

## 元数据
扩展字段：`extensions.lore_spoilers_visibility`；值为 `public` 或 `hidden`。缺省视为公开。
此字段只控制本插件的界面呈现；SillyTavern 本身不会识别它为安全权限。

## 测试与适配
根据 SillyTavern 公开的 `world-info.js` 接口与 DOM 构造实现。
已进行静态语法和数据结构检查，**尚未在你的 SillyTavern 实例进行浏览器实际测试**。如遇到世界书没有出现按钮、主题样式覆盖等情况，请提供截图及版本号。

## 上游
原项目：<https://github.com/cha1latte/lore-spoilers>
原项目许可：MIT，源码归原贡献者所有；本扩展保留原项目出处并对 UI 逻辑进行了重新实现与扩展。许可说明见 `LICENSE`。
