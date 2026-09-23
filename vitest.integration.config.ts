import { defineConfig } from "vitest/config";

// On-demand integration suite: real DB code paths against in-memory PGlite.
// Run with `npm run test:int` (NOT part of `npm test`, which stays pure-logic).
export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    environment: "node",
    testTimeout: 30000,
    hookTimeout: 30000,
    // **测试文件串行跑。**
    //
    // vitest 默认并行跑文件，而这里有三个文件在抢同一批磁盘路径
    // （data/desktop-binaries/、data/app-desktop-manifest.json）：
    // 一个刚写进去的安装包，会被另一个文件的 beforeEach 当成上一轮的残留删掉。
    //
    // 症状是**单独跑每个文件全绿、一起跑随机红几条** —— 而且红的位置每次不同。
    // 这一轮实测：单跑 13 条全过，全量跑挂 5 条。也就是说在发现它之前，
    // 好几次「全量绿」都是撞运气撞出来的。
    //
    // 更彻底的做法是让每个文件用自己的目录，但那几个路径是 lib 里
    // `path.join(process.cwd(), "data", ...)` 的模块级常量，按文件改不了。
    // 这一档本来就不快（每个文件起自己的 PGlite），串行的代价可以接受。
    fileParallelism: false,
  },
});
