import { readFileSync } from "node:fs";
import ejs from "ejs";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";
import { makeT } from "../src/lib/i18n.js";
import { buildGeoPackPageModel } from "../src/lib/geo_pack_page.js";
import type { GeoPackInfo, GeoPackListing } from "../src/lib/geo_packs.js";
import type { GeoPackFetchJobState, GeoReleaseIndex } from "../src/lib/geo_release.js";

// 后台地址包页改版的渲染冒烟：四种状态（无包 / 已装且最新 / 有新版
// +未安装 / 获取进行中）各渲一遍整页模板，断言信息架构——标题是
// 人话名、哈希与文件名只在折叠的技术详情里、获取进度区的轮询锚
// 点（#geo-fetch-status / #geo-pack-listing）与进度元素齐全。

const zh = makeT("zh-CN");
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const TEMPLATE = new URL("../src/views/admin/geo-packs.ejs", import.meta.url);

const doms: JSDOM[] = [];
afterEach(() => { for (const d of doms.splice(0)) d.window.close(); });

function pack(over: Partial<GeoPackInfo> = {}): GeoPackInfo {
  return {
    id: "au-nsw", file: "pack-au-nsw.sqlite", bytes: 2_320_121_856, rows: 4_500_000,
    sha256: SHA_A, buildDate: "2026-11-22T01:02:03Z", packVersion: "2026.11.4",
    region: "New South Wales, Australia", companions: [], embedded: null,
    ...over,
  };
}

function indexPack(over: Partial<GeoReleaseIndex["packs"][number]> = {}): GeoReleaseIndex["packs"][number] {
  return {
    packId: "au-nsw", file: "pack-au-nsw.sqlite", bytes: 2_320_121_856, sha256: SHA_A,
    rows: 4_500_000, region: "New South Wales, Australia", packVersion: "2026.11.4", parts: 0,
    ...over,
  };
}

async function render(args: {
  packs: GeoPackInfo[];
  releaseIndex: GeoReleaseIndex | null;
  configured?: boolean;
  fetchJob?: GeoPackFetchJobState | null;
}) {
  const listing: GeoPackListing = {
    configured: args.configured ?? true,
    packs: args.packs,
    sharedFiles: [],
  };
  const model = buildGeoPackPageModel({ t: zh, packs: args.packs, releaseIndex: args.releaseIndex, syncByFile: {} });
  const html = await ejs.renderFile(TEMPLATE.pathname, {
    t: zh, currentLocale: "zh-CN", csrfToken: "fake", flash: null,
    activeNav: "/admin/geo-packs",
    listing, provider: "pack", packDir: "/srv/geo-packs",
    syncByFile: {}, syncTokens: [], recentUploads: [],
    releaseBaseUrl: "https://example.invalid/releases",
    fetchJob: args.fetchJob ?? null,
    packGroups: model.groups, summary: model.summary,
    packNamesJson: JSON.stringify(model.packNames).replace(/</g, "\\u003c"),
  });
  const dom = new JSDOM(html);
  doms.push(dom);
  return { html, doc: dom.window.document };
}

describe("admin geo-packs page (redesign)", () => {
  it("no packs: summary says so, no filenames or hashes anywhere", async () => {
    const { html, doc } = await render({ packs: [], releaseIndex: null });
    expect(doc.querySelector("#geo-pack-listing")).not.toBeNull();
    expect(html).toContain("尚未安装任何地址包");
    expect(html).toContain("未能检查更新");
    expect(html).not.toContain("pack-au");
    expect(html).not.toContain(SHA_A);
  });

  it("installed and latest: human names up front, hash and filename only inside details", async () => {
    const vic = pack({
      id: "au-vic", file: "pack-au-vic.sqlite", rows: 4_510_693, bytes: 2_032_271_360,
      sha256: SHA_B, region: "Victoria, Australia",
    });
    const { html, doc } = await render({
      packs: [pack(), vic],
      releaseIndex: {
        release: "geo-packs-au-v2", generatedAt: "2026-11-22T00:00:00Z",
        packs: [indexPack(), indexPack({ packId: "au-vic", file: "pack-au-vic.sqlite", sha256: SHA_B })],
      },
    });
    // 顶部一句话：装了 2 个、已是最新
    expect(html).toContain("已安装 2 个包");
    expect(html).toContain("已是最新");
    // 组标题是国家名，行标题是地区名
    expect(html).toContain("澳大利亚");
    expect(html).toContain("新南威尔士州");
    expect(html).toContain("维多利亚州");
    expect(html).toContain("已安装 · 最新");
    // 文件名与哈希：只出现在折叠区里，行首区域不许有
    const rows = [...doc.querySelectorAll("#geo-pack-listing li")];
    const nswRow = rows.find((li) => li.textContent?.includes("新南威尔士州"))!;
    expect(nswRow).toBeTruthy();
    const head = nswRow.querySelector(":scope > div")!;
    expect(head.textContent).not.toContain("pack-au-nsw.sqlite");
    expect(head.textContent).not.toContain(SHA_A);
    const details = nswRow.querySelector("details")!;
    expect(details).not.toBeNull();
    expect(details.textContent).toContain("pack-au-nsw.sqlite");
    expect(details.textContent).toContain(SHA_A);
    expect(details.hasAttribute("open")).toBe(false);
    // 包文件不许下到本地：行内没有下载链接，整页也没有任何指向包文件的下载入口
    expect(nswRow.querySelector('a[href^="/admin/geo-packs/download"]')).toBeNull();
    expect(html).not.toContain("/admin/geo-packs/download");
    // 预检脚本的名字表带上了人话名
    expect(html).toContain('"au-nsw":"新南威尔士州"');
  });

  it("update available + not installed: badges and summary call them out", async () => {
    const { html, doc } = await render({
      packs: [pack()],
      releaseIndex: {
        release: "geo-packs-au-v3", generatedAt: "2026-12-01T00:00:00Z",
        packs: [
          indexPack({ sha256: SHA_B, packVersion: "2026.12.0" }),
          indexPack({ packId: "au-qld", file: "pack-au-qld.sqlite", region: "Queensland, Australia", packVersion: "2026.12.0" }),
        ],
      },
    });
    expect(html).toContain("有新版可更新");
    expect(html).toContain("有 1 个包可更新");
    expect(html).not.toContain("/admin/geo-packs/download");
    expect(html).toContain("另有 1 个包未安装");
    expect(html).toContain("可更新到 v2026.12.0");
    const rows = [...doc.querySelectorAll("#geo-pack-listing li")];
    const qldRow = rows.find((li) => li.textContent?.includes("昆士兰州"))!;
    expect(qldRow).toBeTruthy();
    expect(qldRow.textContent).toContain("未安装");
    // 未安装的行没有本地文件：没有下载链接、没有技术详情
    expect(qldRow.querySelector("a")).toBeNull();
    expect(qldRow.querySelector("details")).toBeNull();
  });

  it("fetch running: both polling anchors and all progress elements are present", async () => {
    const job: GeoPackFetchJobState = {
      id: "job-1", status: "running", baseUrl: "https://example.invalid/releases",
      release: "geo-packs-au-v2", startedAt: "2026-11-24T00:00:00Z", finishedAt: null,
      recovered: false, error: null, lastError: null,
      totalBytes: 1000, downloadedBytes: 400, speedBps: 5000, etaSeconds: 120,
      currentFile: "pack-au-nsw.sqlite",
      files: [{ file: "pack-au-nsw.sqlite", status: "downloading", bytesTotal: 1000, bytesDone: 400, attempts: 1, error: null }],
    };
    const { html, doc } = await render({ packs: [], releaseIndex: null, fetchJob: job });
    expect(html).not.toContain("/admin/geo-packs/download");
    expect(doc.querySelector("#geo-pack-listing")).not.toBeNull();
    const status = doc.querySelector("#geo-fetch-status");
    expect(status).not.toBeNull();
    expect(doc.querySelector("#geo-fetch-progress")).not.toBeNull();
    expect(doc.querySelector("#geo-fetch-bar")).not.toBeNull();
    expect(doc.querySelector("#geo-fetch-pct")?.textContent).toContain("40%");
    expect(doc.querySelector("#geo-fetch-bytes")?.textContent).toContain("400 B / 1000 B");
    expect(doc.querySelector("#geo-fetch-rate")).not.toBeNull();
    expect(doc.querySelector("#geo-fetch-current-name")?.textContent).toBe("pack-au-nsw.sqlite");
    expect(doc.querySelector("#geo-fetch-current-bar")).not.toBeNull();
    const fileRow = doc.querySelector('[data-geo-file="pack-au-nsw.sqlite"]');
    expect(fileRow).not.toBeNull();
    expect(fileRow?.querySelector("[data-geo-file-bytes]")).not.toBeNull();
    expect(fileRow?.querySelector("[data-geo-file-status]")).not.toBeNull();
    // 进行中时获取按钮禁用
    expect(doc.querySelector<HTMLButtonElement>("#geo-fetch-btn")?.disabled).toBe(true);
    expect(doc.querySelector("#geo-preview-btn")).not.toBeNull();
    expect(doc.querySelector("#geo-preview")).not.toBeNull();
  });

  it("fetch done: the terminal status block still renders (polling finish() swaps it in)", async () => {
    const job: GeoPackFetchJobState = {
      id: "job-2", status: "done", baseUrl: "https://example.invalid/releases",
      release: "geo-packs-au-v2", startedAt: "2026-11-24T00:00:00Z", finishedAt: "2026-11-24T01:00:00Z",
      recovered: false, error: null, lastError: null,
      totalBytes: 0, downloadedBytes: 0, speedBps: 0, etaSeconds: null, currentFile: null, files: [],
    };
    const { html, doc } = await render({ packs: [pack()], releaseIndex: null, fetchJob: job });
    expect(doc.querySelector("#geo-fetch-status")).not.toBeNull();
    expect(html).toContain("上次获取已完成");
    expect(html).not.toContain("/admin/geo-packs/download");
    expect(doc.querySelector<HTMLButtonElement>("#geo-fetch-btn")?.disabled).toBe(false);
  });

  it("not configured: guidance renders inside the listing anchor", async () => {
    const { html, doc } = await render({ packs: [], releaseIndex: null, configured: false });
    expect(doc.querySelector("#geo-pack-listing")).not.toBeNull();
    expect(html).toContain("未配置包目录");
  });

  it("template file itself carries no leftover card-wall markup for packs", () => {
    const src = readFileSync(TEMPLATE.pathname, "utf8");
    // 旧版每包一张 rounded-2xl 卡片的标志类不许回来（签发令牌的一次性警告框除外）
    expect(src.match(/rounded-2xl border/g)?.length ?? 0).toBe(1);
  });
});
