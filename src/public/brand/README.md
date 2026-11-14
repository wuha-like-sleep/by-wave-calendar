# ByWave 默认标识

`logo.svg` 是全平台共用的日历与波浪标识；`logo-small.svg` 是同一标识的小尺寸光学校正版。
所有生成资源均提交到仓库，普通编译不需要重新绘制图标。

在仓库根目录运行：

```bash
npm run build:branding
```

`scripts/brand-assets.mjs` 负责共用渲染规则，两个生成入口分别写入：

- `gen-icons.mjs`：网站 favicon、导航与启动标识、PWA、邮件 BIMI 默认图标、iOS 与 Android 启动图标。
- `build-desktop-branding.mjs`：Mac ICNS、Windows ICO、Linux PNG、窗口图标与安装器素材。

桌面和普通网页图标保留透明外边距；iOS 与 PWA maskable 使用不透明满版背景，
由操作系统裁切外形。Android 自适应图标分离背景、前景与单色层，前景保留 66dp 安全区；
单色层的波浪与分隔线采用透明镂空，保证系统着色后仍可识别。
BIMI 使用无滤镜、无外部引用的小尺寸矢量版本。

网站管理员上传的自定义 Logo 继续优先显示；修改这些资源不会覆盖上传内容。
手机端本次只更新图标，界面、版本号与发行附件不随此命令变动。
