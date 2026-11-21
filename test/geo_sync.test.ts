// 地址包同步通道的纯逻辑：文件名白名单（与下载白名单同一套命名规则、
// 穿越一律拒）、分片规划数学、同步令牌形状。DB / 文件落盘部分在
// test/integration/geo_sync.int.test.ts 里走真实路径验。
process.env.PUBLIC_BASE_URL ||= "http://localhost:3000";
process.env.DATABASE_URL ||= "postgres://localhost:5432/bywave";
process.env.SESSION_SECRET ||= "test-session-secret-at-least-32-chars-long";

import { describe, it, expect } from "vitest";

const {
  classifyGeoSyncFile,
  planChunkCount,
  chunkLengthAt,
  looksLikeGeoSyncToken,
  geoSyncTokenPrefix,
  sha256Hex,
  MAX_PACK_BYTES,
} = await import("../src/lib/geo_sync.js");

describe("classifyGeoSyncFile", () => {
  it("管线既定命名全部放行且分类正确", () => {
    expect(classifyGeoSyncFile("pack-au.sqlite")).toMatchObject({ kind: "pack", packId: "au" });
    expect(classifyGeoSyncFile("pack-au-tas.sqlite")).toMatchObject({ kind: "pack", packId: "au-tas" });
    expect(classifyGeoSyncFile("pack-au-vic2.sqlite")).toMatchObject({ kind: "pack", packId: "au-vic2" });
    expect(classifyGeoSyncFile("manifest-au-tas.json")).toMatchObject({ kind: "manifest", packId: "au-tas" });
    expect(classifyGeoSyncFile("licence-manifest-au-tas.json")).toMatchObject({ kind: "licence-manifest", packId: "au-tas" });
    expect(classifyGeoSyncFile("ATTRIBUTION-au-tas.txt")).toMatchObject({ kind: "attribution", packId: "au-tas" });
    expect(classifyGeoSyncFile("manifest.json")).toMatchObject({ kind: "shared-manifest", packId: null });
    expect(classifyGeoSyncFile("licence-manifest.json")).toMatchObject({ kind: "shared-manifest", packId: null });
    expect(classifyGeoSyncFile("ATTRIBUTION.txt")).toMatchObject({ kind: "shared-attribution", packId: null });
    expect(classifyGeoSyncFile("licences/odbl-1.0.txt")).toMatchObject({ kind: "licence-text", packId: null });
    expect(classifyGeoSyncFile("licences/cc-by-4.0.txt")).toMatchObject({ kind: "licence-text", packId: null });
  });

  it("包的大小上限是 GiB 量级，文本类是 MiB 量级", () => {
    expect(classifyGeoSyncFile("pack-au.sqlite")!.maxBytes).toBe(MAX_PACK_BYTES);
    expect(MAX_PACK_BYTES).toBeGreaterThan(9.47 * 1024 * 1024 * 1024);
    expect(classifyGeoSyncFile("manifest-au.json")!.maxBytes).toBeLessThan(100 * 1024 * 1024);
  });

  it("穿越、错后缀、未登记形状一律拒", () => {
    const bad = [
      "../pack-au.sqlite",
      "pack-au.sqlite/../x",
      "licences/../../etc/passwd",
      "licences/..txt",
      "evil.exe",
      "pack-au.sqlite.exe",
      "pack-au.db",
      "manifest-au-tas.json.bak",
      "random.txt",
      "stray.json",
      "pack-.sqlite",
      "pack-au tas.sqlite",
      "licences/sub/dir.txt",
      "/etc/passwd",
      "",
    ];
    for (const name of bad) {
      expect(classifyGeoSyncFile(name), name).toBeNull();
    }
  });
});

describe("分片规划", () => {
  it("片数向上取整，最少一片", () => {
    expect(planChunkCount(1, 1024)).toBe(1);
    expect(planChunkCount(1024, 1024)).toBe(1);
    expect(planChunkCount(1025, 1024)).toBe(2);
    expect(planChunkCount(10 * 1024 * 1024, 8 * 1024 * 1024)).toBe(2);
  });

  it("每片精确长度：整片在前，尾片收余", () => {
    const bytes = 2500, size = 1024;
    expect(chunkLengthAt(bytes, size, 0)).toBe(1024);
    expect(chunkLengthAt(bytes, size, 1)).toBe(1024);
    expect(chunkLengthAt(bytes, size, 2)).toBe(452);
    expect(chunkLengthAt(bytes, size, 3)).toBe(0);
    // 整除时尾片也是整片
    expect(chunkLengthAt(2048, size, 1)).toBe(1024);
  });
});

describe("同步令牌形状", () => {
  const good = `bwgs_${"Ab3dEf7H"}_${"x".repeat(32)}`;
  it("bwgs_<8>_<32> 才算同步令牌", () => {
    expect(looksLikeGeoSyncToken(good)).toBe(true);
    expect(geoSyncTokenPrefix(good)).toBe("Ab3dEf7H");
  });
  it("个人 API Token（bwc_）与其它形状不算", () => {
    expect(looksLikeGeoSyncToken(`bwc_${"Ab3dEf7H"}_${"x".repeat(24)}`)).toBe(false);
    expect(looksLikeGeoSyncToken("bwgs_short")).toBe(false);
    expect(looksLikeGeoSyncToken("")).toBe(false);
    expect(geoSyncTokenPrefix("nonsense")).toBeNull();
  });
});

describe("sha256Hex", () => {
  it("与已知向量一致", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex(Buffer.from("abc"))).toBe(sha256Hex("abc"));
  });
});
