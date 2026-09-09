# Morrow 品牌资源

标记用连续上升的 **M** 表达持续推进；右侧的淡紫色太阳呼应 Morrow（明日）。深灰底与暖白字形延续应用已确认的灰白外壳，小尺寸优先保留轮廓和辨识度。

| 文件 | 用途 |
| --- | --- |
| [morrow-icon.png](morrow-icon.png) | 带真实透明外边距的 1254 × 1254 原始图稿，macOS 图标的唯一来源。 |
| [morrow-logo.png](morrow-logo.png) | 256 × 256 导出，用于 README。 |
| [morrow-mark.png](morrow-mark.png) | 64 × 64 导出，用于应用侧栏及浏览器预览图标。 |

图稿使用 Codex 内置 **imagegen** 生成，没有使用 CLI/API fallback。下列提示词是实际使用的生成规格；模型输出尺寸为 1254 × 1254，打包时导出标准 macOS 尺寸。

## 导出

在 macOS 上，从仓库根目录运行：

```bash
swift scripts/make-icon.swift assets/brand/morrow-icon.png .build/runtime-cache/AppIcon.iconset
cp .build/runtime-cache/AppIcon.iconset/icon_256x256.png assets/brand/morrow-logo.png
cp .build/runtime-cache/AppIcon.iconset/icon_32x32@2x.png assets/brand/morrow-mark.png
```

`npm run build:app` 会从原始图稿重新导出 iconset，再用 `iconutil` 生成 `.icns`。旧 SwiftUI 构建也读取同一份图稿；请不要在构建脚本中另画一枚 Logo。

## 生成提示词

```text
Use case: logo-brand.
Create ONE final production-ready logo image for Morrow, a refined native Mac app that lets Codex take ongoing responsibility for project goals. Brand idea: tomorrow, steady self-directed progress, learning from feedback. This is the actual application icon, NOT a presentation board or mockup.
Canvas: square 1024x1024 PNG, genuine transparent outer background.
Composition: a single macOS-style rounded-square tile centered in the canvas, occupying about 86% of the width and height with equal transparent margins. Tile is deep graphite (#252528), very subtle satin surface, no distracting gloss, almost flat. Inside it one custom geometric ivory (#F8F7F2) M-like symbol, centered, bold and highly legible at 16-32 pixels. The symbol is made of a continuous wide flowing ribbon that rises into two softly rounded arches, with the right arch subtly higher, suggesting progress and a dawning horizon. A compact circular periwinkle (#A89BFF) sun sits just above the right-hand shoulder of the mark, visually balanced and fully inside the tile. The letterform must feel intentionally designed, not typeset. Strong negative space, clean silhouette, simple precise edges, restrained and elegant like a premium productivity tool.
The mark should fill roughly 62% of the tile width, with ample breathing room. No thin lines, no tiny details. No gradients inside the ivory mark. No drop shadow outside the tile, no border outlines. No text, no wordmark, no slogan, no extra symbols, no sparkles, no robots, no brains, no circuit lines, no watermarks, no grids, no multiple alternatives. Export only the one icon on real transparency, clean front view, no perspective.
```
