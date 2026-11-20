// by-wave-calendar single-page calendar app

// ---- 事件表单的纯逻辑（提醒 / 下拉反显）----
// 这一组函数不碰 DOM：入参出参都是普通对象和数组，浏览器那边只负责把结果画出来，
// node 里可以直接 import 本文件打它们（test/event_form_reminder.test.js）。
//
// 为什么这几处值得单独拎出来：表单里每一个下拉的 value 都会原样进数据库
// （extra.alarms[].trigger 还是提醒幂等键的一部分），而服务端的 extra 是浅合并 ——
// 少发一个键 = 保留原值，多发一个 undefined = 这个键在 JSON.stringify 里直接消失。
// 这一类错法的共同点是：页面照常保存成功，什么都不报，用户几天后在别的设备上才发现。
// 只能靠断言挡。
(function () {
  "use strict";

  // 新建事件的默认档位。全天那档不能沿用 -PT15M：全天提醒锚的是「事件时区当天 00:00」，
  // 再减 15 分钟就成了前一晚 23:45 响。
  const REMINDER_DEFAULTS = { timed: "-PT15M", allday: "PT9H" };

  function reminderGroupOf(isAllDay) { return isAllDay ? "allday" : "timed"; }

  function groupHas(options, group, value) {
    return options.some((o) => o.value === value && (o.group === "both" || o.group === group));
  }

  // 下拉里认不出的值不许静默丢掉：临时插一个把原文显示出来的选项，并且选中它。
  // 浏览器在 value 设不上时会把 selectedIndex 置 -1，那个字段随即从 FormData 里
  // 整个消失 —— 于是保存出去的是「清空这个键」，用户在手机 / CalDAV 上设的那份
  // 存一次网页就没了，而页面照常提示保存成功。
  function withCustomOption(options, want, customLabel) {
    const value = String(want == null ? "" : want).trim();
    const list = options.slice();
    if (!value || list.some((o) => o.value === value)) {
      return { options: list, value: list.some((o) => o.value === value) ? value : "" };
    }
    list.push({ value: value, label: customLabel, group: "custom", custom: true });
    return { options: list, value: value };
  }

  // 重建提醒下拉：只留当前这一组档位，并保证 keepValue 一定选得上。
  function buildReminderOptions(allOptions, isAllDay, keepValue, customLabel) {
    const group = reminderGroupOf(isAllDay);
    const inGroup = allOptions.filter((o) => o.group === "both" || o.group === group);
    return withCustomOption(inGroup, keepValue, customLabel);
  }

  // 用户自己勾/去勾「全天」时换档：两组的语义不通用（-PT15M 挂到全天事件上按全天算法
  // 是前一天 23:45），不属于目标组的换成目标组的默认值 —— 换完下拉里看得见，不是静默改写。
  // 「不提醒」两组都有，原样留着。
  function nextReminderValue(allOptions, currentValue, isAllDay) {
    const group = reminderGroupOf(isAllDay);
    const cur = String(currentValue == null ? "" : currentValue);
    if (cur === "" || groupHas(allOptions, group, cur)) return cur;
    return REMINDER_DEFAULTS[group];
  }

  // 把事件的整组 alarms 拆成「进下拉的第一条」和「其余原样寄存的几条」。
  // 第二条起表单不提供编辑入口，但也绝不能吞掉：寄存在隐藏字段里，submit 时拼回去。
  function splitAlarmsForForm(alarms, isAllDay, isExisting) {
    const list = Array.isArray(alarms)
      ? alarms.filter((a) => a && typeof a.trigger === "string" && a.trigger.trim())
      : [];
    const first = list.length > 0
      ? list[0].trigger.trim()
      : (isExisting ? "" : REMINDER_DEFAULTS[reminderGroupOf(isAllDay)]);
    return { first: first, rest: list.slice(1) };
  }

  // submit 用：下拉选的那条 + 寄存的其余几条。选了「不提醒」返回 null。
  function collectAlarms(triggerRaw, extraRaw, description) {
    const trigger = String(triggerRaw == null ? "" : triggerRaw).trim();
    // 显式 null，不是 undefined：服务端的 extra 是浅合并，省略 = 保留原值，
    // 只有 null 才是「删掉这个键」。返回 undefined 的话 JSON.stringify 把 alarms
    // 这个键整个丢掉，用户选了「不提醒」永远关不掉。
    if (!trigger) return null;
    const out = [{ trigger: trigger, action: "DISPLAY", description: description }];
    let rest = [];
    try { rest = JSON.parse(extraRaw || "[]"); } catch (_e) { rest = []; }
    if (Array.isArray(rest)) {
      for (const a of rest) {
        if (!a || typeof a.trigger !== "string") continue;
        const t = a.trigger.trim();
        // 同 trigger 会撞幂等键 (event_id, trigger, instance_start)，服务端也会去重；
        // 这里先挡一道，省得白占掉 8 条上限里的一格。
        if (!t || t === trigger) continue;
        out.push(Object.assign({}, a, { trigger: t }));
      }
    }
    return out;
  }

  globalThis.bwcEventForm = {
    REMINDER_DEFAULTS,
    reminderGroupOf,
    groupHas,
    withCustomOption,
    buildReminderOptions,
    nextReminderValue,
    splitAlarmsForForm,
    collectAlarms,
  };
})();

// ---- 本地地址簿：地点输入的联想来源（纯逻辑，node 里可直接打）----
// 产品口径：地址只存在本机，靠「用过」一点点攒起来。这一版把簿子做成
// 正经的结构化条目（IndexedDB 持久化在主 IIFE 里，这一层只管逻辑）：
//   条目 = { address 展示串, normalized 规范键, useCount, lastUsedAt,
//            firstSeenAt, source: seed|typed|online,
//            street/suburb/city/state/postcode/country/lat/lon（在线
//            结果带回的组件，可空）, keywords: { 标题关键词: 次数 } }
// 规范化：小写、去标点、缩写展开（Rd→road 等），大小写/标点/缩写不同
// 的写法都归到同一条。学习有三路：保存记使用（含标题关键词关联）、
// 选中又改了再保存按「编辑学习」把原条目改成新写法（不裂成两条）、
// 在线结果选中即以 online 来源 + 组件入库。
// 匹配不只是子串：整串包含 > 词元全命中（任意序）> 词元部分命中；
// 词元级还认前缀、缩写（已规范化）、小编辑距离（打错字）、中文词的
// 拼音首字母。排序 = 匹配质量 + 使用次数 + 新近度 + 标题上下文关联。
(function () {
  "use strict";

  const MAX_ENTRIES = 300;
  const MAX_KEYWORDS_PER_ENTRY = 12;

  // 缩写 → 展开形。规范键与查询都过一遍展开，所以两边怎么写都能对上。
  // 注意 st 同时是 Saint 的缩写：这里按街道后缀展开，是有意的取舍。
  const ABBREV = {
    rd: "road", st: "street", ave: "avenue", av: "avenue", blvd: "boulevard",
    dr: "drive", ln: "lane", ct: "court", pl: "place", hwy: "highway",
    fwy: "freeway", stn: "station", ctr: "centre", cntr: "centre",
    apt: "apartment", ste: "suite", n: "north", s: "south", e: "east",
    w: "west", ne: "northeast", nw: "northwest", se: "southeast",
    sw: "southwest", mt: "mount", univ: "university",
  };

  // 拼音首字母表（常用地名/地址/姓氏字，按首字母分组）。全量拼音库太
  // 重，这里只覆盖高频字：查不到的字不参与首字母匹配，其它匹配照常。
  // iOS 端用系统 transliteration 覆盖全量，那边不依赖这张表。
  const PINYIN_INITIALS = {
    a: "阿安爱奥澳",
    b: "北百本白滨宝保八办步",
    c: "长城重川村场厂超朝车陈蔡曹崔程昌春成",
    d: "大东道学单街德定点店都",
    e: "二恩",
    f: "方福丰法飞凤府房发",
    g: "广国高工公馆港贵桂甘古光",
    h: "海河湖汉华黄杭后和合花红号会行",
    j: "江家金建街机京九嘉济局景江",
    k: "开科昆康口",
    l: "路老刘李林梁罗卢吕陆廖黎雷龙乐立里",
    m: "马门民明贸南",
    n: "南宁昌通阳内农",
    p: "平潘彭浦",
    q: "青清桥七区千秋桥",
    r: "人日仁瑞荣",
    s: "上山水三四苏深石狮商厦市省",
    t: "天太津台一铁同",
    w: "王吴汪万五无锡无文武",
    x: "西新小徐薛夏华兴心向",
    y: "杨余姚叶袁云一阳阳",
    z: "张郑周朱赵邹中正中山镇中州中站",
  };
  const PINYIN_OF = {};
  for (const [initial, chars] of Object.entries(PINYIN_INITIALS)) {
    for (const ch of chars) if (!PINYIN_OF[ch]) PINYIN_OF[ch] = initial;
  }

  /** 展示用归一化：去首尾空白、内部连续空白压成一个空格。 */
  function normalizeAddress(value) {
    return String(value == null ? "" : value).trim().replace(/\s+/g, " ");
  }

  /** 规范键：小写、标点变空格、缩写展开、词元以单空格连接。 */
  function canonicalize(value) {
    const lowered = normalizeAddress(value).toLowerCase().replace(/[.,，、;；:：'’‘"“”()（）·-]/g, " ");
    const tokens = lowered.split(/\s+/).filter(Boolean).map((t) => ABBREV[t] || t);
    return tokens.join(" ");
  }

  function tokensOf(canonical) {
    return canonical ? canonical.split(" ").filter(Boolean) : [];
  }

  /** 有界 Levenshtein：超过 maxDist 直接返回 maxDist+1（提前剪枝）。 */
  function editDistance(a, b, maxDist) {
    if (Math.abs(a.length - b.length) > maxDist) return maxDist + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      let rowMin = i;
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (cur[j] < rowMin) rowMin = cur[j];
      }
      if (rowMin > maxDist) return maxDist + 1;
      prev = cur;
    }
    return prev[b.length];
  }

  /** 中文词元的拼音首字母串；非汉字字符原样（小写）带过。 */
  function pinyinInitials(token) {
    let out = "";
    for (const ch of token) {
      if (PINYIN_OF[ch]) out += PINYIN_OF[ch];
      else if (/[a-z0-9]/.test(ch)) out += ch;
      else if (/[\u4e00-\u9fff]/.test(ch)) return ""; // 有查不到的汉字就整体放弃
    }
    return out;
  }

  const TITLE_STOPWORDS = new Set(["the", "a", "an", "and", "with", "to", "of", "at", "in", "on"]);

  /** 从事件标题抽关键词：英文词（≥2 字符，去停用词）+ 汉字二元组。 */
  function titleKeywords(title) {
    const out = [];
    const seen = new Set();
    const push = (kw) => {
      if (kw && !seen.has(kw) && !TITLE_STOPWORDS.has(kw)) { seen.add(kw); out.push(kw); }
    };
    const text = String(title == null ? "" : title).toLowerCase();
    for (const w of text.split(/[^\p{L}\p{N}]+/u)) {
      if (!w) continue;
      if (/^[\u4e00-\u9fff]+$/.test(w)) {
        if (w.length === 1) push(w);
        for (let i = 0; i + 2 <= w.length; i++) push(w.slice(i, i + 2));
      } else if (w.length >= 2) {
        push(w);
      }
    }
    return out.slice(0, 6);
  }

  function mergeKeywords(entry, title) {
    if (!title) return entry.keywords || {};
    const kw = { ...(entry.keywords || {}) };
    for (const k of titleKeywords(title)) kw[k] = (kw[k] || 0) + 1;
    const top = Object.entries(kw).sort((a, b) => b[1] - a[1]).slice(0, MAX_KEYWORDS_PER_ENTRY);
    return Object.fromEntries(top);
  }

  function fillComponents(entry, geo) {
    if (!geo) return entry;
    const out = { ...entry };
    for (const f of ["street", "suburb", "city", "state", "postcode", "country"]) {
      if (geo[f] && !out[f]) out[f] = geo[f];
    }
    if (typeof geo.lat === "number" && typeof out.lat !== "number") out.lat = geo.lat;
    if (typeof geo.lon === "number" && typeof out.lon !== "number") out.lon = geo.lon;
    return out;
  }

  /**
   * 卫生处理：近乎相同的条目合并（同一门牌号 + 词元 Jaccard ≥ 0.85，
   * 并入次数多的那条），然后按价值（次数优先、其次最近）封顶。
   * 每次写入后调用，保证簿子不裂、不无限长。
   */
  function hygiene(entries) {
    let list = (Array.isArray(entries) ? entries : []).filter(
      (e) => e && normalizeAddress(e.address) && e.normalized,
    );
    // 近合并：O(n²) 但 n ≤ 300+少量，直接双重循环即可。
    const merged = [];
    const used = new Array(list.length).fill(false);
    for (let i = 0; i < list.length; i++) {
      if (used[i]) continue;
      let acc = list[i];
      const aToks = new Set(tokensOf(acc.normalized));
      for (let j = i + 1; j < list.length; j++) {
        if (used[j]) continue;
        const b = list[j];
        const bToks = new Set(tokensOf(b.normalized));
        const firstNum = (ts) => [...ts].find((t) => /^\d+$/.test(t)) || "";
        if (firstNum(aToks) !== firstNum(bToks)) continue;
        const inter = [...aToks].filter((t) => bToks.has(t)).length;
        const union = new Set([...aToks, ...bToks]).size;
        if (union > 0 && inter / union >= 0.85) {
          const keep = acc.useCount >= b.useCount ? acc : b;
          const drop = keep === acc ? b : acc;
          acc = fillComponents({
            ...keep,
            useCount: acc.useCount + b.useCount,
            lastUsedAt: Math.max(acc.lastUsedAt || 0, b.lastUsedAt || 0),
            firstSeenAt: Math.min(acc.firstSeenAt || 0, b.firstSeenAt || 0) || keep.firstSeenAt,
            keywords: Object.fromEntries(
              Object.entries({ ...(drop.keywords || {}), ...(keep.keywords || {}) })
                .map(([k, v]) => [k, (keep.keywords?.[k] || 0) + (drop.keywords?.[k] || 0)])
                .sort((x, y) => y[1] - x[1]).slice(0, MAX_KEYWORDS_PER_ENTRY),
            ),
          }, drop);
          used[j] = true;
        }
      }
      merged.push(acc);
    }
    list = merged;
    if (list.length > MAX_ENTRIES) {
      list.sort((a, b) => (b.useCount || 0) - (a.useCount || 0) || (b.lastUsedAt || 0) - (a.lastUsedAt || 0));
      list = list.slice(0, MAX_ENTRIES);
    }
    return list;
  }

  /**
   * 记一次使用（保存成功 / 在线选中都走这里）。
   * opts: { source, title, geo }。已存在条目：计数 +1、刷新最近时间、
   * 采用新写法作展示串、合并标题关键词、补齐组件。
   */
  function upsertEntry(entries, address, now, opts) {
    const o = opts || {};
    const display = normalizeAddress(address);
    if (!display) return hygiene(entries);
    const key = canonicalize(display);
    const list = (Array.isArray(entries) ? entries : []).slice();
    const idx = list.findIndex((e) => e && e.normalized === key);
    if (idx >= 0) {
      const prev = list[idx];
      list[idx] = fillComponents({
        ...prev,
        address: display,
        useCount: (prev.useCount || 0) + 1,
        lastUsedAt: now,
        keywords: mergeKeywords(prev, o.title),
      }, o.geo);
    } else {
      list.push(fillComponents({
        address: display,
        normalized: key,
        useCount: 1,
        lastUsedAt: now,
        firstSeenAt: now,
        source: o.source || "typed",
        keywords: mergeKeywords({}, o.title),
      }, o.geo));
    }
    return hygiene(list);
  }

  /**
   * 播种：把一批已有地址并进来。已存在的条目一个字都不动；新条目
   * source=seed、计数 = 出现次数、lastUsedAt = 0、firstSeenAt = now。
   */
  function seedEntries(entries, locations, now) {
    const list = (Array.isArray(entries) ? entries : []).slice();
    const known = new Set(list.map((e) => e.normalized));
    const counts = new Map();
    for (const raw of Array.isArray(locations) ? locations : []) {
      const display = normalizeAddress(raw);
      if (!display) continue;
      const key = canonicalize(display);
      if (known.has(key)) continue;
      const prev = counts.get(key);
      counts.set(key, prev
        ? { ...prev, useCount: prev.useCount + 1 }
        : { address: display, normalized: key, useCount: 1, lastUsedAt: 0, firstSeenAt: now || 0, source: "seed", keywords: {} });
    }
    for (const entry of counts.values()) list.push(entry);
    return hygiene(list);
  }

  /** 两个地址「足够像」：词元 Jaccard ≥ 0.5、一方包含另一方、或编辑
   *  距离相对很小。编辑学习的触发条件——像，才认为是改出来的。 */
  function similarAddress(a, b) {
    const ka = canonicalize(a);
    const kb = canonicalize(b);
    if (!ka || !kb) return false;
    if (ka === kb) return true;
    if (ka.includes(kb) || kb.includes(ka)) return true;
    const aT = new Set(tokensOf(ka));
    const bT = new Set(tokensOf(kb));
    const inter = [...aT].filter((t) => bT.has(t)).length;
    const union = new Set([...aT, ...bT]).size;
    if (union > 0 && inter / union >= 0.5) return true;
    const maxLen = Math.max(ka.length, kb.length);
    return editDistance(ka, kb, Math.max(2, Math.floor(maxLen / 4))) <= Math.max(2, Math.floor(maxLen / 4));
  }

  /**
   * 编辑学习：用户选中了建议 picked、改了改、最后以 saved 保存。
   * 两者足够像 → 把 picked 那条原地改成 saved（计数/首次出现/关键词
   * 都保留，只换写法与规范键；saved 若另有一条则两条合并）。
   * 不像 → 当作全新地址正常记一次。picked 为空 → 正常记一次。
   */
  function learnFromSave(entries, picked, saved, now, opts) {
    const o = opts || {};
    const display = normalizeAddress(saved);
    if (!display) return Array.isArray(entries) ? entries.slice() : [];
    if (!picked || canonicalize(picked) === canonicalize(display) || !similarAddress(picked, display)) {
      return upsertEntry(entries, display, now, { source: "typed", title: o.title });
    }
    const list = (Array.isArray(entries) ? entries : []).slice();
    const pickedKey = canonicalize(picked);
    const savedKey = canonicalize(display);
    const pIdx = list.findIndex((e) => e && e.normalized === pickedKey);
    if (pIdx < 0) return upsertEntry(entries, display, now, { source: "typed", title: o.title });
    const pickedEntry = list[pIdx];
    const sIdx = list.findIndex((e, i) => i !== pIdx && e && e.normalized === savedKey);
    let base = pickedEntry;
    if (sIdx >= 0) {
      const other = list[sIdx];
      base = {
        ...pickedEntry,
        useCount: (pickedEntry.useCount || 0) + (other.useCount || 0),
        firstSeenAt: Math.min(pickedEntry.firstSeenAt || now, other.firstSeenAt || now),
        keywords: other.keywords,
      };
      base = fillComponents(base, other);
      list.splice(Math.max(pIdx, sIdx), 1);
      list.splice(Math.min(pIdx, sIdx), 1);
    } else {
      list.splice(pIdx, 1);
    }
    list.push(fillComponents({
      ...base,
      address: display,
      normalized: savedKey,
      useCount: (base.useCount || 0) + 1,
      lastUsedAt: now,
      keywords: mergeKeywords(base, o.title),
    }, null));
    return hygiene(list);
  }

  /** 一个查询词元是否命中一个条目词元：相等 / 前缀 / 模糊 / 拼音首字母。 */
  function tokenMatches(qTok, eTok) {
    if (qTok === eTok) return true;
    if (eTok.startsWith(qTok) || (qTok.length > eTok.length && qTok.startsWith(eTok))) return true;
    if (/^\d+$/.test(qTok) || /^\d+$/.test(eTok)) return false; // 数字词元不搞模糊，门牌号错一位是另一家
    if (qTok.length >= 4 && eTok.length >= 4) {
      const maxD = Math.max(qTok.length, eTok.length) >= 7 ? 2 : 1;
      if (editDistance(qTok, eTok, maxD) <= maxD) return true;
    }
    if (/^[a-z]+$/.test(qTok) && /[\u4e00-\u9fff]/.test(eTok)) {
      const ini = pinyinInitials(eTok);
      if (ini && ini.startsWith(qTok)) return true;
    }
    return false;
  }

  /**
   * 带打分的本地匹配。opts: { title, now, limit }。
   * 返回 [{ address, score }]（调用方一般只取 address）。
   * 分数 = 匹配质量（整串包含 100 / 词元全中 75，顺序对 +10 / 部分按
   * 比例）+ 次数加成（封顶）+ 新近加成（90 天线性衰减）+ 标题上下文
   * 关联加成。查询为空时按次数/新近给常去的几条。
   */
  function matchScored(entries, query, opts) {
    const o = opts || {};
    const limit = o.limit || 5;
    const now = o.now || Date.now();
    const qCanon = canonicalize(query);
    const qToks = tokensOf(qCanon);
    const ctx = titleKeywords(o.title);
    const scored = [];
    for (const e of Array.isArray(entries) ? entries : []) {
      if (!e || !normalizeAddress(e.address)) continue;
      let base = 0;
      if (!qCanon) {
        base = 50;
      } else if (e.normalized === qCanon) {
        base = 110;
      } else if (e.normalized.includes(qCanon)) {
        base = 100;
      } else if (qToks.length > 0) {
        const eToks = tokensOf(e.normalized);
        let matched = 0;
        let lastPos = -1;
        let inOrder = true;
        for (const qt of qToks) {
          const pos = eToks.findIndex((et) => tokenMatches(qt, et));
          if (pos >= 0) {
            matched++;
            if (pos < lastPos) inOrder = false;
            lastPos = Math.max(lastPos, pos);
          }
        }
        if (matched === qToks.length) base = inOrder ? 85 : 75;
        else if (matched >= Math.ceil(qToks.length / 2)) base = Math.round(55 * (matched / qToks.length));
      }
      if (base <= 0) continue;
      const freq = Math.min(e.useCount || 0, 25) * 1.2;
      const days = Math.max(0, (now - (e.lastUsedAt || 0)) / 86400000);
      const recency = Math.max(0, 12 * (1 - days / 90));
      let context = 0;
      if (e.keywords) {
        for (const k of ctx) context += Math.min(e.keywords[k] || 0, 5) * 3;
        context = Math.min(context, 30);
      }
      scored.push({ address: e.address, score: base + freq + recency + context, lastUsedAt: e.lastUsedAt || 0 });
    }
    scored.sort((a, b) => (b.score - a.score) || (b.lastUsedAt - a.lastUsedAt));
    return scored.slice(0, limit).map(({ address, score }) => ({ address, score }));
  }

  /** 只取地址串的便捷版（保持旧调用习惯）。 */
  function matchLocal(entries, query, opts) {
    const o = typeof opts === "number" ? { limit: opts } : (opts || {});
    return matchScored(entries, query, o).map((s) => s.address);
  }

  /**
   * 合并本地与在线建议：本地在前，在线去掉与本地重复（按规范键）的，
   * 总数封顶。返回 [{ address, online, geo }]。
   */
  function mergeSuggestions(localAddresses, onlineSuggestions, limit) {
    const cap = limit || 8;
    const out = [];
    const seen = new Set();
    for (const address of Array.isArray(localAddresses) ? localAddresses : []) {
      const display = normalizeAddress(address);
      if (!display) continue;
      seen.add(canonicalize(display));
      out.push({ address: display, online: false, geo: null });
    }
    for (const s of Array.isArray(onlineSuggestions) ? onlineSuggestions : []) {
      const display = normalizeAddress(typeof s === "string" ? s : (s && s.label));
      if (!display) continue;
      const key = canonicalize(display);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ address: display, online: true, geo: typeof s === "string" ? null : s });
    }
    return out.slice(0, cap);
  }

  globalThis.bwcAddressBook = {
    MAX_ENTRIES,
    normalizeAddress,
    canonicalize,
    addressKey: canonicalize,
    editDistance,
    pinyinInitials,
    titleKeywords,
    upsertEntry,
    seedEntries,
    similarAddress,
    learnFromSave,
    hygiene,
    matchScored,
    matchLocal,
    mergeSuggestions,
  };
})();

// ---- 导入弹窗：怎样才算「真的导入了」----
// 同样不碰 DOM，node 里可以直接打（test/import_dialog_result.test.ts）。
//
// 以前弹窗只看「请求有没有出错」：粘贴那条 redirect:"manual" 拿到 opaqueredirect 就算成功，
// 上传那条跟着 302 跳到日历页拿到 200 也算成功 —— 服务端放在 ?error= 里的报错一个都没读到。
// 文件过大、不是 .ics、粘贴超长，用户看到的都是「导入完成」，而实际上一条都没导进去。
//
// 现在弹窗带 Accept: application/json，服务端回 { ok, message }（见 src/web/index.ts 的
// wantsJson / importFailed / importDone）。**只有服务端明说 ok: true 才算成功**；
// 跳转、HTML 页面、令牌失效的 403、别的形状，一律按失败处理 —— 宁可让用户再点一次，
// 也不能说「导入完成」而什么都没有。
(function () {
  "use strict";

  /** 一个能直接显示给用户的错：message 已经是完整的一句话，不用再套「导入失败：」。 */
  function userFacingError(message) {
    const e = new Error(message);
    e.userFacing = true;
    return e;
  }

  /**
   * 把导入路由的响应读成 { message, partial } 或抛一个 userFacing 的错。
   * resp：fetch 的 Response（或形状相同的对象）；T：取文案的函数。
   */
  async function readImportResponse(resp, T) {
    let data = null;
    try { data = await resp.json(); } catch (_e) { data = null; }
    if (data && typeof data === "object" && data.ok === true) {
      return { message: typeof data.message === "string" ? data.message : "", partial: data.partial === true };
    }
    if (data && typeof data === "object" && data.ok === false && typeof data.message === "string" && data.message) {
      throw userFacingError(data.message);
    }
    // 不是导入结果：令牌失效（403）、会话过期被带去登录页、日历不属于自己被带回首页（都是跳转后的 200 HTML）。
    // 这几种都是「刷新一下页面再来」能解决的。
    const s = Number(resp && resp.status) || 0;
    if (s === 403 || (resp && resp.type === "opaqueredirect") || (s >= 200 && s < 400)) {
      throw userFacingError(T("app.js.import.reloadAndRetry"));
    }
    throw userFacingError(T("app.js.import.failed", { error: "HTTP " + s }));
  }

  globalThis.bwcImportResult = { readImportResponse };
})();

(function __bwcCalendarApp() {
  "use strict";
  // 没有 DOM 就只是被 import 进来取上面那组纯函数（测试），不启动应用。
  if (typeof document === "undefined") return;

  // toastui 改为动态加载（见 calendar-app.ejs 的内联加载器）：库还没到
  // 就先等它就绪、再整段重跑本函数，期间页面上的静态骨架
  // （#calendar-skeleton）保持显示；库已在场则直接继续，函数体只会
  // 完整执行一次。库加载失败时加载器已把骨架切到错误态，这里静默
  // 退出即可（重试按钮走整页刷新，会重新走一遍加载流程）。
  if (!(window.tui && window.tui.Calendar)) {
    if (window.__bwcTuiReady) {
      window.__bwcTuiReady.then(function () { __bwcCalendarApp(); }, function () {});
    }
    return;
  }

  const FORM = globalThis.bwcEventForm;
  const ctx = window.__bwc || { calendars: [], publicBaseUrl: "", csrfToken: "" };
  const headers = () => ({ "Content-Type": "application/json", "X-CSRF-Token": ctx.csrfToken });
  const fetchOpts = (extra = {}) => Object.assign({ credentials: "same-origin", headers: headers() }, extra);

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // ---------- i18n ----------
  // The server injects window.BWC_T (all app.js.* strings from the locale
  // dictionaries) and window.BWC_LOCALE from calendar-app.ejs. T() looks a
  // key up and substitutes {name}-style placeholders; unknown keys degrade
  // to the readable key text (same contract as the server-side t()).
  const T = (k, vars) => {
    let s = (window.BWC_T && window.BWC_T[k]) || k;
    if (vars) for (const [kk, v] of Object.entries(vars)) s = s.replaceAll("{" + kk + "}", String(v));
    return s;
  };
  const LOCALE = window.BWC_LOCALE || "zh-CN";
  // Localized month names (index 0 = January) and weekday names starting
  // Sunday, built from Intl so every locale gets its native forms without
  // shipping tables. 2021-08-01 was a Sunday; using local-midnight Dates
  // keeps the formatter in the browser's zone (no off-by-one-day).
  const MONTH_NAMES = Array.from({ length: 12 }, (_, m) =>
    new Intl.DateTimeFormat(LOCALE, { month: "long" }).format(new Date(2021, m, 1)));
  const dayNamesFor = (style) =>
    [0, 1, 2, 3, 4, 5, 6].map((d) => new Intl.DateTimeFormat(LOCALE, { weekday: style }).format(new Date(2021, 7, 1 + d)));

  // Animated modal show/hide. The CSS (input.css "Modal motion") keeps modals
  // in a closed state (opacity/transform) by default and reveals them on the
  // `.is-open` class; so EVERY show path must call openModal(). Accepts an id
  // string ("#modal-x") or the element itself.
  const MODAL_LEAVE_MS = 340; // ≥ the longest CSS leave transition
  function openModal(id) {
    const el = typeof id === "string" ? $(id) : id;
    if (!el) return;
    el.classList.remove("hidden");
    el.classList.add("flex");
    void el.offsetWidth;          // reflow so the enter transition starts closed
    el.classList.add("is-open");
  }
  function closeModal(id) {
    const el = typeof id === "string" ? $(id) : id;
    if (!el || el.classList.contains("hidden")) return;
    el.classList.remove("is-open");  // play the leave transition
    setTimeout(() => {
      // A re-open during the leave animation re-adds is-open — don't hide then.
      if (!el.classList.contains("is-open")) {
        el.classList.add("hidden");
        el.classList.remove("flex");
      }
    }, MODAL_LEAVE_MS);
  }

  // ---------- helpers used by event modal + drag/drop ----------

  // Snap a date to the nearest 5-minute boundary. Used by:
  //  - drag/resize end (so dropping an event on the grid doesn't lock to
  //    Toast UI's default 30-min cell — we re-quantize to 5 min)
  //  - the new-event "selectDateTime" path
  function roundTo5Min(date) {
    const STEP = 5 * 60 * 1000;
    const d = new Date(date);
    d.setTime(Math.round(d.getTime() / STEP) * STEP);
    return d;
  }

  // "下一个事件" banner — finds the soonest upcoming event in the next 24h
  // that isn't yet started, OR the currently-in-progress event if any.
  // Caller passes the raw events array (server shape) and current ms.
  function updateNextEventBanner(rawEvents, now) {
    const banner = $("#next-event-banner");
    const text = $("#next-event-text");
    const jump = $("#next-event-jump");
    if (!banner || !text) return;
    const horizonMs = now + 24 * 3600 * 1000;
    // Prefer in-progress (start <= now <= end), else soonest upcoming.
    let inProgress = null, nextUp = null;
    for (const e of rawEvents) {
      const s = +new Date(e.startsAt), en = +new Date(e.endsAt);
      if (s <= now && en > now && !inProgress) inProgress = { e, s, en };
      else if (s > now && s < horizonMs && (!nextUp || s < nextUp.s)) nextUp = { e, s, en };
    }
    const target = inProgress || nextUp;
    if (!target) { banner.classList.add("hidden"); return; }
    const fmt = (ms) => {
      const mins = Math.round((ms - now) / 60000);
      if (mins < 0) return T("app.js.banner.startedMinAgo", { n: Math.abs(mins) });
      if (mins < 60) return T("app.js.banner.startsInMin", { n: mins });
      const hours = Math.round(mins / 60);
      if (hours < 24) return T("app.js.banner.startsInHours", { n: hours });
      return new Date(target.s).toLocaleString(LOCALE, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    };
    const verb = inProgress ? T("app.js.banner.inProgress") : fmt(target.s);
    text.textContent = `${target.e.summary || T("app.js.untitled")} · ${verb}`;
    banner.classList.remove("hidden");
    if (jump) {
      jump.onclick = () => {
        try { cal.setDate(new Date(target.s)); refresh(); saveViewState(); } catch (_e) {}
      };
    }
  }

  // View vs edit mode for the event modal. View = read-only display
  // with an 编辑 button; edit = inputs enabled, 保存/删除 visible.
  // Set on every openEventModal call; new-event flow goes straight to
  // edit, click-existing goes to view first.
  function setModalMode(mode) {
    const form = $("#form-event");
    if (!form) return;
    const editing = mode === "edit";
    // Toggle ALL inputs / selects / textareas inside the form.
    form.querySelectorAll("input, select, textarea").forEach((el) => {
      // Hidden inputs (id / attendees JSON string) must stay enabled
      // so the form submits with their values.
      if (el.type === "hidden") return;
      el.disabled = !editing;
      el.classList.toggle("opacity-70", !editing);
      el.classList.toggle("cursor-not-allowed", !editing);
    });
    // Footer button visibility.
    const submitBtn = form.querySelector('button[type="submit"]');
    const cancelBtn = form.querySelector('.modal-close.rounded-lg');
    const deleteBtn = $("#btn-delete-event");
    const enterEditBtn = $("#btn-enter-edit");
    if (submitBtn) submitBtn.classList.toggle("hidden", !editing);
    if (cancelBtn) {
      cancelBtn.classList.toggle("hidden", false);
      // In view mode "Cancel" is misleading — there's nothing to cancel.
      // Swap the label to "Close" without changing the click behavior.
      cancelBtn.textContent = editing ? T("app.js.common.cancel") : T("app.js.common.close");
    }
    if (deleteBtn) deleteBtn.classList.toggle("hidden", !editing || !form.querySelector('[name="id"]').value);
    if (enterEditBtn) enterEditBtn.classList.toggle("hidden", editing);
    // Title
    const titleEl = $("#modal-event-title");
    if (titleEl) {
      const isExisting = !!form.querySelector('[name="id"]').value;
      titleEl.textContent = editing ? (isExisting ? T("app.js.modal.editEvent") : T("app.js.modal.newEvent")) : T("app.js.modal.eventDetails");
    }
  }
  $$(".modal-close").forEach((b) => b.addEventListener("click", (e) => {
    const m = e.target.closest("[id^=modal-]");
    if (m) closeModal("#" + m.id);
  }));
  ["#modal-event", "#modal-calendar", "#modal-cal-menu", "#modal-import"].forEach((id) => {
    const m = $(id);
    if (m) m.addEventListener("click", (e) => { if (e.target === m) closeModal(id); });
  });

  // ---------- Sidebar (mobile drawer + desktop collapse) ----------
  const sidebar = $("#cal-sidebar");
  const backdrop = $("#cal-sidebar-backdrop");
  const SIDEBAR_DESKTOP_KEY = "bwc.sidebar.desktop";
  const MOBILE_OPEN = ["flex", "fixed", "inset-y-0", "left-0", "z-50", "w-72"];
  const HIDDEN = ["hidden"];

  function isMobile() { return window.matchMedia("(max-width: 699px)").matches; }

  const DRAWER_LEAVE_MS = 300; // ≥ the CSS drawer/backdrop leave transition
  function showOnMobile() {
    MOBILE_OPEN.forEach(c => sidebar.classList.add(c));
    sidebar.classList.add("bwc-drawer");
    HIDDEN.forEach(c => sidebar.classList.remove(c));
    backdrop.classList.remove("hidden");
    void sidebar.offsetWidth;                 // reflow → slide/fade start off-screen
    sidebar.classList.add("is-open");
    backdrop.classList.add("is-open");
  }
  function hideOnMobile() {
    sidebar.classList.remove("is-open");       // slide out + fade backdrop
    backdrop.classList.remove("is-open");
    setTimeout(() => {
      if (sidebar.classList.contains("is-open")) return; // re-opened mid-leave
      MOBILE_OPEN.forEach(c => sidebar.classList.remove(c));
      sidebar.classList.remove("bwc-drawer");
      sidebar.classList.add("hidden");
      backdrop.classList.add("hidden");
    }, DRAWER_LEAVE_MS);
  }
  function showOnDesktop() {
    sidebar.classList.remove("hidden");
    sidebar.classList.add("duo:flex");
    localStorage.setItem(SIDEBAR_DESKTOP_KEY, "1");
    requestAnimationFrame(() => { try { cal.render(); } catch (e) {} });
  }
  function hideOnDesktop() {
    sidebar.classList.remove("duo:flex");
    sidebar.classList.add("hidden");
    localStorage.setItem(SIDEBAR_DESKTOP_KEY, "0");
    requestAnimationFrame(() => { try { cal.render(); } catch (e) {} });
  }
  function toggleSidebar() {
    if (isMobile()) {
      if (sidebar.classList.contains("hidden")) showOnMobile(); else hideOnMobile();
    } else {
      if (sidebar.classList.contains("hidden")) showOnDesktop(); else hideOnDesktop();
    }
  }

  // Restore desktop preference
  if (!isMobile() && localStorage.getItem(SIDEBAR_DESKTOP_KEY) === "0") {
    sidebar.classList.add("hidden");
    sidebar.classList.remove("duo:flex");
  }

  // Form-factor flip across the duo boundary (fold/unfold, rotation):
  // the drawer's fixed-position classes are meaningless in-flow and vice
  // versa — an open drawer would stay glued over the unfolded layout.
  // Reset to the canonical state for the new form factor, honouring the
  // saved desktop collapse preference, then re-render the grid.
  const duoMq = window.matchMedia("(max-width: 699px)");
  function onDuoFlip() {
    MOBILE_OPEN.forEach(c => sidebar.classList.remove(c));
    sidebar.classList.remove("bwc-drawer");
    sidebar.classList.remove("is-open");
    backdrop.classList.remove("is-open");
    backdrop.classList.add("hidden");
    if (duoMq.matches || localStorage.getItem(SIDEBAR_DESKTOP_KEY) === "0") {
      sidebar.classList.add("hidden");
      sidebar.classList.remove("duo:flex");
    } else {
      sidebar.classList.remove("hidden");
      sidebar.classList.add("duo:flex");
    }
    requestAnimationFrame(() => { try { cal.render(); } catch (e) {} });
  }
  if (duoMq.addEventListener) duoMq.addEventListener("change", onDuoFlip);
  else if (duoMq.addListener) duoMq.addListener(onDuoFlip);

  $("#btn-toggle-sidebar").addEventListener("click", toggleSidebar);
  $("#btn-close-sidebar")?.addEventListener("click", hideOnMobile);
  backdrop.addEventListener("click", hideOnMobile);

  // ---------- Toast UI Calendar setup ----------
  // Event text colour follows the calendar colour's luminance: white text
  // on a pale yellow/blue calendar colour is unreadable in BOTH modes, so
  // bright colours get black text instead. (WCAG relative luminance. The
  // switch point is the exact crossover where black and white give the
  // same ratio — 4.58:1 — so every calendar colour, preset or custom,
  // ends up with whichever of the two passes AA; a softer near-black
  // like #1e293b leaves mid-luminance colours such as #3b82f6 and
  // #6366f1 stranded below 4.5:1 with either choice.)
  function readableTextOn(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
    if (!m) return "#ffffff";
    const n = parseInt(m[1], 16);
    const lin = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    const lum = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
    return lum > 0.179 ? "#000000" : "#ffffff";
  }
  const tuiCalendars = ctx.calendars.map((c) => ({
    id: c.id,
    name: c.name,
    backgroundColor: c.color,
    borderColor: c.color,
    dragBackgroundColor: c.color,
    color: readableTextOn(c.color),
  }));

  // On phones the 7-column week view is unreadable — labels truncate to
  // 2 chars, drag-to-create misfires constantly. Default to "day" on
  // mobile; the view-switcher header still lets the user pick weekly.
  const isMobileViewport = window.matchMedia("(max-width: 640px)").matches;

  // ---------- 视图位置记忆 ----------
  // 视图(日/周/月)和当前日期原本只活在 JS 内存里,所以刷新一次、或者
  // 切个语言(切语言会带着 return_to 重新加载页面),就被打回「今天 + 默认
  // 视图」—— 用户正翻着下个月的日程,一刷新全没了。存 localStorage:
  //   - 视图:一直记住
  //   - 日期:只在 12 小时内有效。隔天再打开当然应该回到今天,而不是
  //     停在昨晚看的那一周。
  const VIEW_KEY = "bwc.view.mode";
  const ANCHOR_KEY = "bwc.view.anchor";      // "<ISO 日期>|<存的时间戳>"
  const ANCHOR_TTL_MS = 12 * 60 * 60 * 1000;

  function readSavedView() {
    try {
      const v = localStorage.getItem(VIEW_KEY);
      return ["day", "week", "month"].includes(v) ? v : null;
    } catch (_e) { return null; }
  }
  function readSavedAnchor() {
    try {
      const raw = localStorage.getItem(ANCHOR_KEY);
      if (!raw) return null;
      const [iso, savedAt] = raw.split("|");
      if (!iso || !savedAt) return null;
      if (Date.now() - Number(savedAt) > ANCHOR_TTL_MS) return null;
      const d = new Date(iso);
      return isNaN(d.getTime()) ? null : d;
    } catch (_e) { return null; }
  }
  function saveViewState() {
    try {
      localStorage.setItem(VIEW_KEY, currentView);
      // getDate() 是当前视图的锚点日期(周视图=该周内某天,月视图=该月内某天)
      const d = cal.getDate().toDate();
      localStorage.setItem(ANCHOR_KEY, `${d.toISOString()}|${Date.now()}`);
    } catch (_e) { /* 隐私模式下 localStorage 会抛,忽略即可 */ }
  }

  const savedView = readSavedView();
  const cal = new tui.Calendar("#calendar", {
    defaultView: savedView || (isMobileViewport ? "day" : "week"),
    useFormPopup: false,
    useDetailPopup: false,
    useCreationPopup: false,
    isReadOnly: false,
    week: {
      taskView: false,
      eventView: ["time", "allday"],
      // Show the full 0-24 range; we visually dim non-working hours via
      // CSS instead of clipping them, so users still see late-night
      // events without scrolling.
      hourStart: 0,
      hourEnd: 24,
      startDayOfWeek: 1,
      dayNames: dayNamesFor("short"),
      showNowIndicator: true,
    },
    month: {
      startDayOfWeek: 1,
      dayNames: dayNamesFor("narrow"),
      visibleWeeksCount: 0,
      isAlways6Weeks: false,
    },
    calendars: tuiCalendars,
    template: {
      monthDayName(model) { return `<span class="text-xs text-slate-500">${model.label}</span>`; },
      // Week header. Toast UI's default puts the weekday name and the date
      // number side by side, which needs more width than a column has on a
      // phone: at 375px each column is ~43px and "9 周日" overflowed it by
      // 14px, so Sunday was visibly cut off at the screen edge. Stack them
      // below sm (the shape Google/Apple Calendar use on phones) and keep the
      // familiar side-by-side layout from sm up.
      // No colours here on purpose: Toast UI puts a per-day `color` inline
      // style on the wrapper span (grey for past days, brand for today,
      // red for Sunday), and hardcoding our own would flatten all of that —
      // an earlier attempt painted every day the same brand colour and lost
      // the "today" cue entirely. We only set size and stacking, and let its
      // colour cascade in; opacity keeps the weekday label subordinate to the
      // date without pinning a colour.
      weekDayName(model) {
        return `<span class="flex h-full flex-col sm:flex-row items-center justify-center gap-0 sm:gap-1.5 leading-tight overflow-hidden">
          <span class="text-[10px] sm:text-xs opacity-75">${model.dayName}</span>
          <span class="text-sm sm:text-base font-medium">${model.date}</span>
        </span>`;
      },
    },
  });

  // Keep this in sync with the defaultView passed to tui.Calendar above —
  // otherwise the view-switcher buttons start out highlighting the wrong tab.
  let currentView = savedView || (isMobileViewport ? "day" : "week");
  // 恢复上次停留的日期(12 小时内)。要在第一次 refresh() 之前设好,
  // 否则会先闪一下今天再跳过去。
  {
    const savedAnchor = readSavedAnchor();
    if (savedAnchor) { try { cal.setDate(savedAnchor); } catch (_e) {} }
  }

  // Scroll the time grid so "now" is roughly in the middle on first load
  // (24-hour view means a lot of empty hours otherwise). Toast UI doesn't
  // expose a scrollToNow() API — we set the scrollTop of the time-grid pane
  // directly. Defer to next tick so the grid is in the DOM.
  function scrollGridToNow() {
    setTimeout(() => {
      const pane = document.querySelector(".toastui-calendar-time .toastui-calendar-columns")
                || document.querySelector(".toastui-calendar-time")
                || document.querySelector("[class*='toastui-calendar-time']");
      if (!pane) return;
      const hour = new Date().getHours();
      // Each hour ~ pane.scrollHeight / 24. Aim for the current hour minus 2
      // so a couple of past hours stay visible for context.
      const target = Math.max(0, (hour - 2)) / 24 * pane.scrollHeight;
      pane.scrollTop = target;
    }, 150);
  }

  function formatPeriodLabel() {
    const start = cal.getDateRangeStart().toDate();
    const end = cal.getDateRangeEnd().toDate();
    const fmt = new Intl.DateTimeFormat(LOCALE, { year: "numeric", month: "long", day: "numeric" });
    if (currentView === "month") {
      const mid = new Date((+start + +end) / 2);
      $("#period-label").textContent = new Intl.DateTimeFormat(LOCALE, { year: "numeric", month: "long" }).format(mid);
    } else if (currentView === "day") {
      $("#period-label").textContent = new Intl.DateTimeFormat(LOCALE, { year: "numeric", month: "long", day: "numeric", weekday: "long" }).format(start);
    } else {
      $("#period-label").textContent = `${fmt.format(start)} – ${fmt.format(end)}`;
    }
  }

  const visibleCalIds = new Set(ctx.calendars.map((c) => c.id));

  // Show pulse skeleton blocks while events load. Disappears as soon
  // as cal.createEvents runs (or loadEvents errors). On the local cache
  // path this barely flashes; on cold-start / slow network it prevents
  // the "white grid" feel that makes users think the page hung.
  function showLoadingSkeleton() {
    const host = document.getElementById("calendar");
    if (!host) return;
    let overlay = document.getElementById("calendar-skeleton");
    if (overlay) return; // already showing
    overlay = document.createElement("div");
    overlay.id = "calendar-skeleton";
    overlay.className = "absolute inset-0 pointer-events-none z-10 px-4 pt-16 flex flex-col gap-2";
    overlay.innerHTML =
      '<div class="h-7 rounded-md bg-slate-200/70 animate-pulse w-2/3"></div>' +
      '<div class="h-7 rounded-md bg-slate-200/70 animate-pulse w-1/2"></div>' +
      '<div class="h-7 rounded-md bg-slate-200/70 animate-pulse w-3/4"></div>' +
      '<div class="h-7 rounded-md bg-slate-200/70 animate-pulse w-1/3"></div>' +
      '<div class="h-7 rounded-md bg-slate-200/70 animate-pulse w-2/5"></div>';
    // Toast UI's calendar root needs `relative` so absolute overlay anchors.
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    host.appendChild(overlay);
  }
  function hideLoadingSkeleton() {
    document.getElementById("calendar-skeleton")?.remove();
  }

  // Friendly first-run nudge. Shows when the user has zero events across
  // any visible calendar (empty grid means "you've never used the app",
  // most of the time). Auto-hides as soon as they create or import one.
  function syncEmptyState(rawEventCount) {
    const banner = document.getElementById("empty-state");
    if (!banner) return;
    // Only show on first paint. If the user already has events anywhere,
    // hide; if they go to a future empty week, we still hide (it's normal
    // to have a quiet week). The signal is "no events anywhere in the
    // current view AND no events ever loaded since page load".
    if (rawEventCount > 0) {
      banner.classList.add("hidden");
      hasEverLoadedEvents = true;
      return;
    }
    if (!hasEverLoadedEvents) banner.classList.remove("hidden");
  }
  let hasEverLoadedEvents = false;

  // Mount the supplied event list into Toast UI Calendar. Pure render —
  // no fetching. Called twice from loadEvents() when stale-while-
  // revalidate is in play (first with cached data, then with fresh).
  function renderEventsToCalendar(rawEvents) {
    cal.clear();
    const now = Date.now();
    const events = rawEvents.map((e) => {
      // For all-day events the server stores UTC midnight (≈ pure date);
      // pass the YYYY-MM-DD string to Toast UI so it doesn't shift around
      // the user's local timezone boundary.
      const start = e.allDay ? e.startsAt.slice(0, 10) : e.startsAt;
      const end = e.allDay ? e.endsAt.slice(0, 10) : e.endsAt;
      // Past-event styling: events whose end is already in the past get
      // muted colors so the user's eye is drawn to upcoming + in-progress.
      // We don't move them out of the grid (still browsable in history),
      // just dim them.
      const endMs = +new Date(e.endsAt);
      const isPast = endMs < now;
      const darkMode = document.documentElement.getAttribute("data-mode") === "dark";
      const style = isPast
        ? darkMode
          ? {
              backgroundColor: "#334155",
              borderColor: "#475569",
              dragBackgroundColor: "#475569",
              color: "#cbd5e1",
            }
          : {
              backgroundColor: "#e2e8f0",
              borderColor: "#cbd5e1",
              dragBackgroundColor: "#cbd5e1",
              color: "#475569",
            }
        : {};
      return {
        id: e.id,
        calendarId: e.calendarId,
        title: e.summary,
        location: e.location || undefined,
        body: e.description || undefined,
        start,
        end,
        isAllday: !!e.allDay,
        category: e.allDay ? "allday" : "time",
        // Stash the master's RRULE so beforeUpdateEvent (drag/resize)
        // and clickEvent can detect "this is a recurring instance" and
        // prompt 仅此次/此后/系列 instead of silently editing the
        // whole series.
        raw: { rrule: e.rrule || null, isOccurrence: !!e.isOccurrence },
        ...style,
      };
    });
    cal.createEvents(events);
    // Force a render so the red now-line redraws after we just cleared.
    try { cal.render(); } catch (_e) {}
    // Update the "下一个事件" banner from the same data.
    updateNextEventBanner(rawEvents, now);
    syncEmptyState(rawEvents.length);
  }

  // Cheap fingerprint of an event list — used to decide whether stage 2
  // (fresh network data) differs from stage 1 (local cache). If the
  // server returned the same set of events with the same updatedAt
  // timestamps, skip the second render to avoid the cal.clear() jitter.
  function eventsFingerprint(list) {
    if (!list || list.length === 0) return "";
    // Sort by id so order changes don't trigger a re-render. Concat
    // id + startsAt + endsAt + (server-side updatedAt if present) to
    // catch edits while remaining fast on 3000-event lists.
    return list
      .map((e) => `${e.id}|${e.startsAt}|${e.endsAt}|${e.updatedAt || ""}`)
      .sort()
      .join("\n");
  }
  let lastRenderedFingerprint = "";

  async function loadEvents() {
    const startRaw = cal.getDateRangeStart().toDate();
    const endRaw = cal.getDateRangeEnd().toDate();
    // Normalize the visible range to a closed [start-of-day, end-of-day]
    // window. Toast UI's week & month views return `end` as the LAST day at
    // 00:00:00 local — so the server's `startsAt <= to` filter excludes any
    // event later in that day (e.g. 04:00 Sunday gets dropped for a
    // Mon-Sun week). Day view already returns end-of-day, but normalizing
    // here keeps every code path consistent. See v1.3.1 — fix
    // week-view-missing-events bug, root cause in TUI's getWeekDates.
    const start = new Date(startRaw);
    start.setHours(0, 0, 0, 0);
    const end = new Date(endRaw);
    end.setHours(23, 59, 59, 999);

    // Stage 1: paint instantly from IndexedDB cache if available.
    // Skipped on cold first load (no cache yet) and when bwcStore isn't
    // loaded (older client / no IndexedDB). When stage 1 paints, we
    // hide the skeleton immediately so nav feels instant; the skeleton
    // only flashes for cold loads.
    let stageOneEvents = null;
    if (window.bwcStore && window.bwcStore.getCached) {
      try {
        const cached = await window.bwcStore.getCached({
          from: start.toISOString(),
          to: end.toISOString(),
        });
        const filtered = (cached.events || []).filter((e) => visibleCalIds.has(e.calendarId));
        if (filtered.length > 0) {
          stageOneEvents = filtered;
          renderEventsToCalendar(filtered);
          lastRenderedFingerprint = eventsFingerprint(filtered);
          hideLoadingSkeleton();
        }
      } catch (_e) { /* fall through to network */ }
    }
    if (!stageOneEvents) showLoadingSkeleton();

    // Stage 2: fetch fresh from server in background.
    try {
      let data;
      if (window.bwcStore) {
        data = await window.bwcStore.getAll({
          from: start.toISOString(),
          to: end.toISOString(),
        });
      } else {
        const url = `/api/events?from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(end.toISOString())}`;
        const resp = await fetch(url, fetchOpts());
        if (!resp.ok) throw new Error("load_failed");
        data = await resp.json();
      }
      const rawEvents = (data.events || []).filter((e) => visibleCalIds.has(e.calendarId));
      const freshFp = eventsFingerprint(rawEvents);
      // Only re-render if data actually changed from what's on screen.
      // No-op skip avoids the cal.clear() → DOM teardown jitter every
      // 30s on the poll path.
      if (freshFp !== lastRenderedFingerprint) {
        renderEventsToCalendar(rawEvents);
        lastRenderedFingerprint = freshFp;
      }
    } catch (err) {
      console.error(err);
      // Only toast if stage 1 didn't paint — otherwise user already
      // sees their (cached) calendar, no need to alarm them.
      if (!stageOneEvents) {
        window.bwc && window.bwc.toast(T("app.js.toast.loadEventsFailed"), "error");
      }
    } finally {
      hideLoadingSkeleton();
    }
  }

  function refresh() { formatPeriodLabel(); loadEvents(); }

  // ---------- Live sync: pick up events added from phone / other tab ----------
  // Polls /api/events every 30 seconds while the tab is visible. Also fires
  // immediately on visibilitychange (when the user comes back to the tab).
  const POLL_INTERVAL_MS = 30_000;
  let pollHandle = null;
  function startPolling() {
    if (pollHandle) return;
    pollHandle = setInterval(() => {
      if (document.hidden) return;
      loadEvents().catch(() => {});
    }, POLL_INTERVAL_MS);
  }
  function stopPolling() {
    if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopPolling();
      stopNowTick();
    } else {
      loadEvents().catch(() => {});
      startPolling();
      startNowTick();
      // Snap the indicator back to "now" the moment we regain focus.
      try { cal.render(); } catch (_e) {}
    }
  });
  startPolling();

  // ---------- Now-indicator tick ----------
  // Toast UI's red "now line" auto-updates every minute internally — but our
  // cal.clear()/createEvents pair from loadEvents() can reset that internal
  // timer. Force a re-render at the top of each minute (and exactly once at
  // every minute boundary, not 60s after page-load) so the line actually
  // crawls down as time passes.
  let nowTickHandle = null;
  let nowAlignHandle = null;
  function tickNow() {
    if (document.hidden) return;
    try { cal.render(); } catch (_e) {}
  }
  function startNowTick() {
    if (nowTickHandle || nowAlignHandle) return;
    const msToNextMinute = 60_000 - (Date.now() % 60_000);
    // First tick aligned to the next wall-clock minute, then every 60s.
    nowAlignHandle = setTimeout(() => {
      nowAlignHandle = null;
      tickNow();
      nowTickHandle = setInterval(tickNow, 60_000);
    }, Math.max(1000, msToNextMinute));
  }
  function stopNowTick() {
    if (nowAlignHandle) { clearTimeout(nowAlignHandle); nowAlignHandle = null; }
    if (nowTickHandle) { clearInterval(nowTickHandle); nowTickHandle = null; }
  }
  startNowTick();

  // ---------- Toolbar ----------
  $("#btn-today").addEventListener("click", () => { cal.today(); refresh(); saveViewState(); scrollGridToNow(); });
  $("#btn-prev").addEventListener("click", () => { cal.prev(); refresh(); saveViewState(); });
  $("#btn-next").addEventListener("click", () => { cal.next(); refresh(); saveViewState(); });
  $$(".view-btn").forEach((b) => b.addEventListener("click", () => {
    currentView = b.dataset.view;
    cal.changeView(currentView);
    $$(".view-btn").forEach((x) => x.classList.remove("bg-brand-50", "text-brand-700", "font-semibold"));
    b.classList.add("bg-brand-50", "text-brand-700", "font-semibold");
    refresh();
    saveViewState();
    if (currentView !== "month") scrollGridToNow();
  }));
  // Highlight whichever view we started in (week on desktop, day on mobile).
  $(`.view-btn[data-view="${currentView}"]`)?.classList.add("bg-brand-50", "text-brand-700", "font-semibold");
  // Initial position: scroll the week grid to the current hour on first paint.
  scrollGridToNow();
  // 地址簿播种（只在首次）：不挡首屏，页面起来之后慢慢拉。
  setTimeout(() => { void seedAddressBook(); }, 1500);

  // ---------- Sidebar: search box filters calendar list by name ----------
  const calSearchEl = document.getElementById("cal-search");
  if (calSearchEl) {
    calSearchEl.addEventListener("input", () => {
      const q = calSearchEl.value.trim().toLowerCase();
      $$("#cal-list li").forEach((li) => {
        const name = (li.querySelector("span.text-sm")?.textContent || "").toLowerCase();
        li.classList.toggle("hidden", q !== "" && !name.includes(q));
      });
    });
  }

  // ---------- Empty-state CTA: "create first calendar" jumps to the same
  // flow as the sidebar "+" button.
  const emptyCreateBtn = document.getElementById("empty-create-cal");
  if (emptyCreateBtn) {
    emptyCreateBtn.addEventListener("click", () => {
      try { openCreateCalendar(); } catch (_e) { /* function defined below */ }
    });
  }

  // ---------- Shortcuts panel toggle ----------
  const shortcutsBtn = $("#btn-shortcuts");
  const shortcutsPanel = $("#shortcuts-panel");
  if (shortcutsBtn && shortcutsPanel) {
    shortcutsBtn.addEventListener("click", () => {
      shortcutsPanel.classList.toggle("hidden");
    });
    document.addEventListener("click", (e) => {
      if (!shortcutsPanel.contains(e.target) && e.target !== shortcutsBtn) {
        shortcutsPanel.classList.add("hidden");
      }
    });
  }

  // ---------- Keyboard shortcuts ----------
  // Mirror Google Calendar: T = today, M / W / D = month/week/day,
  // ← / → = prev/next, N = new event. Skipped when the user is typing in
  // an input / textarea / contenteditable.
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (e.target instanceof HTMLElement) ? e.target.tagName : "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" ||
        (e.target instanceof HTMLElement && e.target.isContentEditable)) return;
    // Don't fire when a modal is open — let Escape close it instead.
    const openModalEl = document.querySelector("[id^='modal-']:not(.hidden)");
    if (openModalEl && e.key === "Escape") {
      closeModal(openModalEl);
      return;
    }
    if (openModalEl) return;
    if (e.key === "?") {
      shortcutsPanel?.classList.toggle("hidden");
      return;
    }
    switch (e.key.toLowerCase()) {
      case "t": cal.today(); refresh(); saveViewState(); scrollGridToNow(); break;
      case "m": $('.view-btn[data-view="month"]')?.click(); break;
      case "w": $('.view-btn[data-view="week"]')?.click(); break;
      case "d": $('.view-btn[data-view="day"]')?.click(); break;
      case "n":
        e.preventDefault();
        $("#btn-new-event")?.click();
        break;
      case "arrowleft": cal.prev(); refresh(); saveViewState(); break;
      case "arrowright": cal.next(); refresh(); saveViewState(); break;
      case "escape": shortcutsPanel?.classList.add("hidden"); break;
      default: return;
    }
  });

  // ---------- Mini calendar (sidebar) ----------
  // A small month/year picker above the calendar list. Click a date → main
  // calendar jumps there in current view; click the month/year title →
  // toggles into a 12-month grid; click a month in that grid → back to
  // month view at that month.
  (function setupMiniCal() {
    const root = $("#mini-cal");
    if (!root) return;
    const monthGrid = $("#mini-month-grid");
    const yearGrid = $("#mini-year-view");
    const monthView = $("#mini-month-view");
    const periodBtn = $("#mini-period");
    const prevBtn = $("#mini-prev");
    const nextBtn = $("#mini-next");
    if (!monthGrid || !yearGrid || !monthView || !periodBtn || !prevBtn || !nextBtn) return;

    let viewKind = "month"; // "month" | "year"
    // Tracks which month/year the mini-cal is *showing*, not the main calendar.
    let cursor = new Date();
    cursor.setDate(1);

    function fmtPeriod() {
      if (viewKind === "month") return new Intl.DateTimeFormat(LOCALE, { year: "numeric", month: "long" }).format(cursor);
      return new Intl.DateTimeFormat(LOCALE, { year: "numeric" }).format(cursor);
    }
    function isSameYMD(a, b) {
      return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    }
    function isSameYM(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth(); }

    function renderMonth() {
      monthView.classList.remove("hidden");
      yearGrid.classList.add("hidden");
      yearGrid.classList.remove("grid");
      periodBtn.textContent = fmtPeriod();
      const year = cursor.getFullYear();
      const month = cursor.getMonth();
      // Week starts Monday (matches main grid)
      const first = new Date(year, month, 1);
      const startDow = (first.getDay() + 6) % 7; // 0 = Mon
      const daysInMonth = new Date(year, month + 1, 0).getDate();
      const prevMonthDays = new Date(year, month, 0).getDate();
      const today = new Date(); today.setHours(0, 0, 0, 0);
      let mainSelected;
      try { mainSelected = cal.getDate().toDate(); } catch (_e) { mainSelected = today; }

      const cells = [];
      // Leading days from previous month
      for (let i = startDow - 1; i >= 0; i--) {
        const d = new Date(year, month - 1, prevMonthDays - i);
        cells.push({ d, outside: true });
      }
      // Current month
      for (let i = 1; i <= daysInMonth; i++) {
        cells.push({ d: new Date(year, month, i), outside: false });
      }
      // Pad to 6 rows = 42 cells
      while (cells.length < 42) {
        const last = cells[cells.length - 1].d;
        const next = new Date(last); next.setDate(next.getDate() + 1);
        cells.push({ d: next, outside: true });
      }

      monthGrid.innerHTML = "";
      cells.forEach(({ d, outside }) => {
        const cell = document.createElement("button");
        cell.type = "button";
        cell.dataset.iso = d.toISOString();
        const isToday = isSameYMD(d, today);
        const isSelected = isSameYMD(d, mainSelected);
        cell.className = [
          "aspect-square inline-flex items-center justify-center rounded",
          "hover:bg-brand-50 hover:text-brand-700 transition-colors",
          outside ? "text-slate-300" : "text-slate-700",
          isToday && !isSelected ? "ring-1 ring-brand-300" : "",
          isSelected ? "bg-brand-600 text-white hover:bg-brand-700 hover:text-white font-semibold" : "",
        ].filter(Boolean).join(" ");
        cell.textContent = String(d.getDate());
        monthGrid.appendChild(cell);
      });
    }

    function renderYear() {
      monthView.classList.add("hidden");
      yearGrid.classList.add("grid");
      yearGrid.classList.remove("hidden");
      periodBtn.textContent = fmtPeriod();
      const today = new Date();
      let mainSelected;
      try { mainSelected = cal.getDate().toDate(); } catch (_e) { mainSelected = today; }

      yearGrid.innerHTML = "";
      for (let m = 0; m < 12; m++) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.dataset.month = String(m);
        const isCurrent = mainSelected.getFullYear() === cursor.getFullYear() && mainSelected.getMonth() === m;
        const isThisMonth = today.getFullYear() === cursor.getFullYear() && today.getMonth() === m;
        btn.className = [
          "py-2 rounded-md text-center font-medium",
          "hover:bg-brand-50 hover:text-brand-700",
          isCurrent ? "bg-brand-600 text-white hover:bg-brand-700 hover:text-white" : "text-slate-700",
          isThisMonth && !isCurrent ? "ring-1 ring-brand-300" : "",
        ].filter(Boolean).join(" ");
        btn.textContent = MONTH_NAMES[m];
        yearGrid.appendChild(btn);
      }
    }

    function render() { viewKind === "month" ? renderMonth() : renderYear(); }

    periodBtn.addEventListener("click", () => {
      viewKind = viewKind === "month" ? "year" : "month";
      render();
    });
    prevBtn.addEventListener("click", () => {
      if (viewKind === "month") cursor.setMonth(cursor.getMonth() - 1);
      else cursor.setFullYear(cursor.getFullYear() - 1);
      render();
    });
    nextBtn.addEventListener("click", () => {
      if (viewKind === "month") cursor.setMonth(cursor.getMonth() + 1);
      else cursor.setFullYear(cursor.getFullYear() + 1);
      render();
    });
    monthGrid.addEventListener("click", (e) => {
      const t = e.target.closest("button[data-iso]");
      if (!t) return;
      const d = new Date(t.dataset.iso);
      cal.setDate(d);
      refresh();
      saveViewState();
      if (currentView !== "month") scrollGridToNow();
      render(); // re-highlight the newly selected cell
    });
    yearGrid.addEventListener("click", (e) => {
      const t = e.target.closest("button[data-month]");
      if (!t) return;
      cursor.setMonth(Number(t.dataset.month));
      viewKind = "month";
      render();
    });

    render();
    // Keep mini-cal in sync when main view changes via toolbar / today buttons.
    const origRefresh = refresh;
    // eslint-disable-next-line no-global-assign
    refresh = function () { origRefresh(); try { render(); } catch (_e) {} };
  })();

  // ---------- Sidebar calendar visibility toggle ----------
  $$(".cal-toggle").forEach((cb) => cb.addEventListener("change", () => {
    const id = cb.dataset.calId;
    if (cb.checked) visibleCalIds.add(id); else visibleCalIds.delete(id);
    loadEvents();
  }));

  // ---------- Event modal ----------
  function pad(n) { return String(n).padStart(2, "0"); }
  function toLocalDateTimeValue(d) {
    const t = new Date(d);
    return `${t.getFullYear()}-${pad(t.getMonth()+1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}`;
  }
  function toLocalDateValue(d) {
    const t = new Date(d);
    return `${t.getFullYear()}-${pad(t.getMonth()+1)}-${pad(t.getDate())}`;
  }

  const allDayCheckbox = $('#form-event [name="allDay"]');
  const timeRow = $("#time-row");
  const dateRow = $("#date-row");
  const durationChips = $("#duration-chips");

  // 时长快捷片：点一下把结束时间设成开始时间 + 片上时长。只对定时
  // 事件有意义，全天时随 #time-row 一起隐藏（syncAllDayUI 里切换）。
  durationChips?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-duration-min]");
    if (!btn) return;
    const startInput = $('#form-event [name="startsAt"]');
    const endInput = $('#form-event [name="endsAt"]');
    if (!startInput?.value) return;
    const start = new Date(startInput.value);
    if (Number.isNaN(start.getTime())) return;
    endInput.value = toLocalDateTimeValue(new Date(start.getTime() + Number(btn.dataset.durationMin) * 60000));
    endInput.dispatchEvent(new Event("change", { bubbles: true }));
  });

  function syncAllDayUI() {
    const isAllDay = allDayCheckbox.checked;
    if (isAllDay) {
      timeRow.classList.add("hidden");
      durationChips?.classList.add("hidden");
      dateRow.classList.remove("hidden");
      // Mirror values
      const s = $('#form-event [name="startsAt"]').value;
      const e = $('#form-event [name="endsAt"]').value;
      if (s) $('#form-event [name="startsAtDate"]').value = s.slice(0, 10);
      if (e) $('#form-event [name="endsAtDate"]').value = e.slice(0, 10);
    } else {
      timeRow.classList.remove("hidden");
      durationChips?.classList.remove("hidden");
      dateRow.classList.add("hidden");
    }
  }
  allDayCheckbox.addEventListener("change", () => {
    syncAllDayUI();
    // 勾/去勾「全天」是用户自己动的手，而两组档位的语义不通用：-PT15M 挂到全天事件上
    // 按全天的算法是「当天 00:00 往前 15 分钟」= 前一天 23:45。所以切换时把不属于
    // 目标组的档位换成目标组的默认值 —— 换完下拉里看得见，不是静默改写。
    switchReminderGroup(allDayCheckbox.checked);
  });

  // ---- 提醒下拉：定时 / 全天 两组档位 ----
  // 档位的 value 和分组由 calendar-app.ejs 渲染（label 只有服务端 t() 拿得到，
  // 客户端 bundle 只收 app.js.* 那批串），这里开页时抄一份留底，
  // 之后每次重建下拉都从这份底稿来。
  const reminderSelect = $('#form-event [name="reminder"]');
  const reminderExtraInput = $('#form-event [name="extraAlarms"]');
  const reminderExtraHint = $("#reminder-extra-hint");
  const REMINDER_OPTIONS = reminderSelect
    ? Array.from(reminderSelect.options).map((o) => ({
        value: o.value,
        label: o.textContent,
        group: o.dataset.group || "both",
      }))
    : [];
  // 档位怎么挑、认不出的值怎么办，全在文件顶上那组纯函数里（FORM.*），
  // 这里只负责把算出来的结果画进 <select>。
  const collectAlarms = FORM.collectAlarms;

  // 分类下拉和提醒下拉是同一个形状的洞：手机 / API / CalDAV 存进来的分类不一定是
  // 这六个固定值里的一个。设不上时浏览器把 selectedIndex 置 -1，category 这个字段
  // 随即从 FormData 里消失，submit 里 `data.category || null` 就发出了显式 null，
  // 服务端浅合并照做把这个键删掉 —— 用户只是在网页上改了个标题，手机上设的分类没了。
  // 所以照提醒那边的办法：认不出就临时插一项，把原值显示出来并选中。
  const categorySelect = $('#form-event [name="category"]');
  const CATEGORY_OPTIONS = categorySelect
    ? Array.from(categorySelect.options).map((o) => ({ value: o.value, label: o.textContent, group: "both" }))
    : [];
  function setCategoryValue(value) {
    if (!categorySelect) return;
    const raw = String(value == null ? "" : value).trim();
    const built = FORM.withCustomOption(CATEGORY_OPTIONS, raw, T("app.js.form.customValue", { value: raw }));
    paintSelect(categorySelect, built.options, built.value);
  }

  // 重复下拉也是同一个洞，而且错了丢的是整个系列：下拉只有六个预设，手机写上来的
  // BYDAY=MO、「这次及以后」拆出来带 UNTIL 的、COUNT、隔周……以前一律显示成「不重复」，
  // 保存时发出 rrule:""（编辑时空串 = 清空，见 submit），只改个标题整个系列就不再重复；
  // 选「这次及以后」，拆出来的后半段变成单次。认不出就临时插一项「自定义（保持原样）」
  // 选中，保存时把原规则原样带回去；用户自己选了别的预设才是真的改。
  const repeatSelect = $('#form-event [name="rrule"]');
  const REPEAT_OPTIONS = repeatSelect
    ? Array.from(repeatSelect.options).map((o) => ({ value: o.value, label: o.textContent, group: "both" }))
    : [];
  function setRepeatValue(value) {
    if (!repeatSelect) return;
    const built = FORM.withCustomOption(REPEAT_OPTIONS, value, T("app.js.repeat.keep"));
    paintSelect(repeatSelect, built.options, built.value);
  }

  // 把一组 { value, label } 画进某个 <select>，并选中 picked。
  // picked 一定在 options 里（withCustomOption 保证），所以 selectedIndex 不会变 -1 ——
  // 变 -1 意味着这个字段从 FormData 里消失，保存出去就是「清空这个键」。
  function paintSelect(sel, options, picked) {
    sel.textContent = "";
    for (const o of options) {
      const el = document.createElement("option");
      el.value = o.value;
      el.textContent = o.label;
      el.dataset.group = o.group || "both";
      sel.appendChild(el);
    }
    sel.value = picked;
    if (sel.selectedIndex < 0) sel.value = "";
  }

  // 重建提醒下拉：只留 isAllDay 对应的那一组，并把 keepValue 选中。
  // keepValue 可能是两组里都没有的值（CalDAV 或手机端同步进来的 -PT10M 之类）——
  // 这种值会被临时插成一个选项，把原文显示出来并选中。以前的做法是静默显示成「无」，
  // 于是用户只是改个标题保存一下，那条提醒就被永久删掉了，页面还照常提示保存成功。
  function renderReminderOptions(isAllDay, keepValue) {
    if (!reminderSelect) return;
    const want = keepValue == null ? reminderSelect.value : keepValue;
    const built = FORM.buildReminderOptions(REMINDER_OPTIONS, isAllDay, want,
      T("app.js.reminder.customValue", { trigger: String(want == null ? "" : want).trim() }));
    paintSelect(reminderSelect, built.options, built.value);
  }

  function switchReminderGroup(isAllDay) {
    if (!reminderSelect) return;
    renderReminderOptions(isAllDay, FORM.nextReminderValue(REMINDER_OPTIONS, reminderSelect.value, isAllDay));
  }

  // 把事件的整组 alarms 灌进表单：第一条进下拉，其余原样寄存在隐藏字段里。
  function setReminderFromAlarms(alarms, isAllDay, isExisting) {
    if (!reminderSelect) return;
    const split = FORM.splitAlarmsForForm(alarms, isAllDay, isExisting);
    renderReminderOptions(isAllDay, split.first);
    // 第二条起我们不提供编辑入口，但也不能吞掉：原样带走，submit 时拼回去。
    const rest = split.rest;
    if (reminderExtraInput) reminderExtraInput.value = rest.length > 0 ? JSON.stringify(rest) : "";
    if (reminderExtraHint) {
      reminderExtraHint.textContent = rest.length > 0 ? T("app.js.reminder.extraKept", { n: rest.length }) : "";
      reminderExtraHint.classList.toggle("hidden", rest.length === 0);
    }
  }

  // ---- Timezone-aware "wall clock in event's TZ" hint ----
  // datetime-local inputs always render in the browser's local zone, no
  // matter what value we set. That's confusing when the event is anchored
  // to a different IANA zone — you type 14:00 thinking "14:00 New York",
  // but the input parses it as 14:00 wherever-you-are. To avoid that
  // bug-class we surface a yellow strip that shows what the typed time
  // means in the event's stored zone, side-by-side with the browser zone.
  const tzHintEl = $("#tz-hint");
  const browserTz = (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (_e) { return "UTC"; }
  })();
  function syncTzHint() {
    if (!tzHintEl) return;
    const form = $("#form-event");
    const tzInput = form.querySelector('[name="timezone"]');
    const startsInput = form.querySelector('[name="startsAt"]');
    const eventTz = (tzInput && tzInput.value || "").trim();
    const startsLocal = startsInput && startsInput.value;
    if (!eventTz || !startsLocal || eventTz === browserTz) {
      tzHintEl.classList.add("hidden");
      tzHintEl.textContent = "";
      return;
    }
    // The browser's interpretation of the datetime-local input — Date()
    // treats it as local time, which IS the user's intent (they typed
    // the wall clock in their browser zone). Re-render that same instant
    // in the event's stored zone so they can see the offset.
    const instant = new Date(startsLocal);
    if (isNaN(instant.getTime())) { tzHintEl.classList.add("hidden"); return; }
    let inEventTz;
    try {
      inEventTz = new Intl.DateTimeFormat(LOCALE, {
        timeZone: eventTz, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hour12: false,
      }).format(instant);
    } catch (_e) {
      // Bad/unknown zone — hide rather than show garbage.
      tzHintEl.classList.add("hidden"); return;
    }
    tzHintEl.textContent = T("app.js.tzHint", {
      browserTz,
      input: startsLocal.replace("T", " "),
      eventTz,
      converted: inEventTz,
    });
    tzHintEl.classList.remove("hidden");
  }
  // Trigger on every relevant input change. Debounced via the browser's
  // own event loop — these handlers are cheap (string + Intl format).
  $('#form-event [name="startsAt"]').addEventListener("input", syncTzHint);
  $('#form-event [name="timezone"]').addEventListener("input", syncTzHint);
  $('#form-event [name="timezone"]').addEventListener("change", syncTzHint);

  // ---- 地点联想：本地地址簿优先，在线兜底 ----
  // 纯逻辑在文件上方 bwcAddressBook；这里只管存储、播种、网络和下拉 UI。
  // 存储用 IndexedDB（库 bwc-address-book：entries 以规范键为主键，
  // meta 存播种标记）——地址簿是结构化数据（组件/坐标/关键词关联），
  // 不再塞 localStorage 的一坨 JSON。运行时以内存数组为准（同步读），
  // 写入时整表回写 IDB；旧 localStorage 数据首次加载时迁移进来。
  // 地址簿按浏览器存，不按账号分——同一台机器换账号播种会把新账号
  // 的地址并进来（seed 只加不覆盖），这是可接受的取舍。
  const ADDR = globalThis.bwcAddressBook;
  const ADDR_ONLINE_KEY = "bwc.geo.onlineSuggestions";
  const ADDR_LEGACY_KEY = "bwc.addressBook.v1";
  const ADDR_LEGACY_SEEDED_KEY = "bwc.addressBook.seeded.v1";
  let addressEntries = [];
  let addressSeeded = false;
  let addressStoreReady = false;

  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("bwc-address-book", 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("entries")) db.createObjectStore("entries", { keyPath: "normalized" });
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbLoadBook() {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["entries", "meta"], "readonly");
      const entriesReq = tx.objectStore("entries").getAll();
      const seededReq = tx.objectStore("meta").get("seeded");
      tx.oncomplete = () => resolve({
        entries: Array.isArray(entriesReq.result) ? entriesReq.result : [],
        seeded: !!(seededReq.result && seededReq.result.value),
      });
      tx.onerror = () => reject(tx.error);
    });
  }
  async function idbSaveBook() {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(["entries", "meta"], "readwrite");
      const store = tx.objectStore("entries");
      store.clear();
      for (const e of addressEntries) store.put(e);
      tx.objectStore("meta").put({ key: "seeded", value: addressSeeded });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  let persistTimer = null;
  function persistAddressBook() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => { idbSaveBook().catch(() => { /* IDB 不可用时内存簿照常工作 */ }); }, 120);
  }
  // 启动加载：IDB 为空且有旧 localStorage 数据 → 迁移一次后删旧键。
  async function initAddressBook() {
    if (!ADDR) return;
    try {
      const loaded = await idbLoadBook();
      addressEntries = loaded.entries;
      addressSeeded = loaded.seeded;
      if (addressEntries.length === 0) {
        try {
          const raw = localStorage.getItem(ADDR_LEGACY_KEY);
          const parsed = raw ? JSON.parse(raw) : [];
          if (Array.isArray(parsed) && parsed.length > 0) {
            addressEntries = parsed.map((e) => ({
              address: ADDR.normalizeAddress(e && e.address),
              normalized: ADDR.canonicalize(e && e.address),
              useCount: (e && e.useCount) || 1,
              lastUsedAt: (e && e.lastUsedAt) || 0,
              firstSeenAt: (e && e.lastUsedAt) || 0,
              source: "typed",
              keywords: {},
            })).filter((e) => e.address && e.normalized);
            addressSeeded = localStorage.getItem(ADDR_LEGACY_SEEDED_KEY) === "1";
            persistAddressBook();
          }
          localStorage.removeItem(ADDR_LEGACY_KEY);
          localStorage.removeItem(ADDR_LEGACY_SEEDED_KEY);
        } catch (_e) { /* 迁移失败不挡使用，从空簿开始 */ }
      }
    } catch (_e) { /* IDB 不可用：内存空簿，保存时靠 upsert 慢慢攒 */ }
    addressStoreReady = true;
    void seedAddressBook();
  }
  function onlineSuggestEnabled() {
    try { return localStorage.getItem(ADDR_ONLINE_KEY) !== "0"; } catch (_e) { return true; }
  }
  // 用户这次编辑里选中过的建议（在线/本地都记）：保存时若被改过，
  // 走编辑学习把原条目改成新写法，而不是裂出一条近重复。
  let pickedLocation = null;
  /** 保存成功后的学习入口（三个保存分支 + 一句话直存共用）。 */
  function learnLocationOnSave(saved) {
    if (!ADDR || !saved) return;
    const display = ADDR.normalizeAddress(saved.location);
    if (!display) { pickedLocation = null; return; }
    addressEntries = ADDR.learnFromSave(addressEntries, pickedLocation, display, Date.now(), { title: saved.summary });
    pickedLocation = null;
    persistAddressBook();
  }
  // 播种：每个日历拉一次全量事件列表，只取 location。失败静默——
  // 没播上种地址簿照样能靠保存慢慢攒，下次打开再试（不置标记）。
  async function seedAddressBook() {
    if (!ADDR || !addressStoreReady || addressSeeded) return;
    const calendars = (ctx.calendars || []).filter((c) => c && c.id);
    if (calendars.length === 0) return;
    try {
      const locations = [];
      for (const cal of calendars) {
        const resp = await fetch(`/api/calendars/${encodeURIComponent(cal.id)}/events`, fetchOpts());
        if (!resp.ok) continue;
        const rows = await resp.json().catch(() => null);
        const list = Array.isArray(rows) ? rows : (rows && Array.isArray(rows.events) ? rows.events : []);
        for (const ev of list) if (ev && ev.location) locations.push(ev.location);
      }
      if (locations.length > 0) {
        addressEntries = ADDR.seedEntries(addressEntries, locations, Date.now());
      }
      addressSeeded = true;
      persistAddressBook();
    } catch (_e) { /* 静默：见上 */ }
  }
  const locationInput = $('#form-event [name="location"]');
  const locationList = $("#location-suggest");
  if (ADDR && locationInput && locationList) {
    let suggestItems = [];   // [{ address, online, geo }]
    let activeIdx = -1;
    let onlineTimer = null;
    let onlineSeq = 0;       // 丢弃过期响应：序号不对就当没收到

    function closeSuggest() {
      locationList.classList.add("hidden");
      locationList.innerHTML = "";
      suggestItems = [];
      activeIdx = -1;
    }
    function renderSuggest() {
      if (suggestItems.length === 0) { closeSuggest(); return; }
      locationList.innerHTML = "";
      let lastOnline = false;
      suggestItems.forEach((item, idx) => {
        if (item.online && !lastOnline) {
          const head = document.createElement("li");
          head.className = "px-3 pt-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-slate-400 select-none";
          head.textContent = T("app.js.location.online");
          locationList.appendChild(head);
        }
        lastOnline = item.online;
        const li = document.createElement("li");
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "w-full truncate px-3 py-1.5 text-left text-sm " +
          (idx === activeIdx ? "bg-brand-50 text-brand-900" : "text-slate-700 hover:bg-slate-50");
        btn.textContent = item.address;
        btn.addEventListener("mousedown", (ev) => {
          ev.preventDefault(); // 抢在 blur 之前，别先被关掉
          pickSuggest(idx);
        });
        li.appendChild(btn);
        locationList.appendChild(li);
      });
      locationList.classList.remove("hidden");
    }
    function pickSuggest(idx) {
      const item = suggestItems[idx];
      if (!item) return;
      locationInput.value = item.address;
      pickedLocation = item.address;
      // 在线结果选中即以 online 来源 + 组件/坐标学进本地：下次同样的
      // 地址直接走本地，不再问在线。
      if (item.online) {
        addressEntries = ADDR.upsertEntry(addressEntries, item.address, Date.now(), {
          source: "online",
          geo: item.geo,
        });
        persistAddressBook();
      }
      closeSuggest();
      locationInput.focus();
    }
    async function refreshSuggest() {
      const query = locationInput.value;
      const summaryInput = $('#form-event [name="summary"]');
      const local = ADDR.matchLocal(addressEntries, query, {
        title: summaryInput ? summaryInput.value : "",
        now: Date.now(),
        limit: 5,
      });
      suggestItems = ADDR.mergeSuggestions(local, [], 8);
      activeIdx = -1;
      renderSuggest();
      // 本地命中够多就到此为止；不够且开关开着、查询够长，才问在线。
      if (local.length >= 3 || !onlineSuggestEnabled()) return;
      const q = ADDR.normalizeAddress(query);
      if (q.length < 3) return;
      const seq = ++onlineSeq;
      clearTimeout(onlineTimer);
      onlineTimer = setTimeout(async () => {
        try {
          const resp = await fetch(
            `/api/geo/suggest?q=${encodeURIComponent(q)}&lang=${encodeURIComponent(LOCALE)}`,
            fetchOpts(),
          );
          if (!resp.ok) return;
          const data = await resp.json().catch(() => null);
          const online = data && Array.isArray(data.suggestions) ? data.suggestions : [];
          // 输入已经变了 / 下拉已经关了：这批结果作废。
          if (seq !== onlineSeq || locationInput.value !== query) return;
          suggestItems = ADDR.mergeSuggestions(local, online, 8);
          renderSuggest();
        } catch (_e) { /* 在线失败静默：本地建议已经在屏上了 */ }
      }, 300);
    }
    locationInput.addEventListener("input", refreshSuggest);
    locationInput.addEventListener("focus", refreshSuggest);
    locationInput.addEventListener("blur", () => { setTimeout(closeSuggest, 120); });
    locationInput.addEventListener("keydown", (ev) => {
      if (locationList.classList.contains("hidden") || suggestItems.length === 0) return;
      if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        const delta = ev.key === "ArrowDown" ? 1 : -1;
        activeIdx = (activeIdx + delta + suggestItems.length) % suggestItems.length;
        renderSuggest();
      } else if (ev.key === "Enter" && activeIdx >= 0) {
        ev.preventDefault(); // 选建议，不是提交表单
        pickSuggest(activeIdx);
      } else if (ev.key === "Escape") {
        closeSuggest();
      }
    });
  }
  void initAddressBook();
  // ---- "编辑" button in view-mode modal switches to edit mode ----
  const enterEditBtn = $("#btn-enter-edit");
  if (enterEditBtn) {
    enterEditBtn.addEventListener("click", () => {
      const form = $("#form-event");
      const hasId = !!form.querySelector('[name="id"]').value;
      setModalMode("edit");
      // The delete button should be visible in edit mode for existing events.
      $("#btn-delete-event").classList.toggle("hidden", !hasId);
    });
  }

  // ---- Start/end time linkage ----
  // When the user changes 开始时间 in the modal, shift 结束时间 by the same
  // delta so the duration is preserved. Without this you have to manually
  // re-pick the end every time you bump the start by 10 minutes.
  //
  // Tracks the previously-known startsAt so we can compute the delta on
  // each change. Reset every time the modal opens (in openEventModal).
  const startsAtInput = $('#form-event [name="startsAt"]');
  const endsAtInput = $('#form-event [name="endsAt"]');
  const startsAtDateInput = $('#form-event [name="startsAtDate"]');
  const endsAtDateInput = $('#form-event [name="endsAtDate"]');
  let lastStartsAt = null;       // datetime-local
  let lastStartsAtDate = null;   // date
  function parseLocalDateTime(s) {
    // datetime-local has no timezone; treat as local.
    if (!s) return null;
    return new Date(s);
  }
  function fmtLocalDateTime(d) {
    if (!d || isNaN(+d)) return "";
    return toLocalDateTimeValue(d);
  }
  if (startsAtInput && endsAtInput) {
    startsAtInput.addEventListener("change", () => {
      const newStart = parseLocalDateTime(startsAtInput.value);
      const oldStart = parseLocalDateTime(lastStartsAt);
      const oldEnd = parseLocalDateTime(endsAtInput.value);
      lastStartsAt = startsAtInput.value;
      if (!newStart || !oldStart || !oldEnd) return;
      const delta = +newStart - +oldStart;
      if (delta === 0) return;
      endsAtInput.value = fmtLocalDateTime(new Date(+oldEnd + delta));
    });
  }
  if (startsAtDateInput && endsAtDateInput) {
    startsAtDateInput.addEventListener("change", () => {
      const newStart = startsAtDateInput.value ? new Date(startsAtDateInput.value + "T00:00") : null;
      const oldStart = lastStartsAtDate ? new Date(lastStartsAtDate + "T00:00") : null;
      const oldEnd = endsAtDateInput.value ? new Date(endsAtDateInput.value + "T00:00") : null;
      lastStartsAtDate = startsAtDateInput.value;
      if (!newStart || !oldStart || !oldEnd) return;
      const deltaDays = Math.round((+newStart - +oldStart) / 86400000);
      if (!deltaDays) return;
      const shifted = new Date(+oldEnd + deltaDays * 86400000);
      endsAtDateInput.value = toLocalDateValue(shifted);
    });
  }

  // Build a 3-option chooser modal for recurring-event edits/deletes.
  // Returns Promise<"instance"|"future"|"series"|null> — null means
  // the user cancelled (clicked outside or 取消). Used by both the
  // delete button and the form submit handler when the event has an
  // RRULE. The server's PATCH/DELETE handlers expect scope+recurrenceId
  // for "instance" and "future"; "series" routes through the normal
  // single-event code path.
  function promptRecurringScope(action) {
    return new Promise((resolve) => {
      const isDelete = action === "delete";
      const overlay = document.createElement("div");
      // Bottom-sheet on mobile (items-end + full-width), centered card
      // on desktop. Matches the visual language of the event modal so
      // users feel "I'm picking an option for the thing I just clicked".
      overlay.className = "fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-slate-900/60 p-0 sm:p-4";
      const card = document.createElement("div");
      card.className = "w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl bg-white shadow-2xl";
      card.innerHTML =
        '<div class="border-b border-slate-200 px-5 py-4">' +
          '<h3 class="text-base font-semibold text-slate-900">' + T(isDelete ? "app.js.recurring.deleteTitle" : "app.js.recurring.saveTitle") + '</h3>' +
          '<p class="mt-1 text-sm text-slate-500">' + T(isDelete ? "app.js.recurring.promptDelete" : "app.js.recurring.promptSave") + '</p>' +
        '</div>' +
        '<div class="space-y-2 p-5">' +
          '<button type="button" data-scope="instance" class="block w-full rounded-lg border border-slate-200 px-4 py-3 text-left hover:bg-slate-50">' +
            '<div class="text-sm font-medium text-slate-900">' + T("app.js.recurring.onlyThis") + '</div>' +
            '<div class="mt-0.5 text-xs text-slate-500">' + T(isDelete ? "app.js.recurring.onlyThisDeleteDesc" : "app.js.recurring.onlyThisSaveDesc") + '</div>' +
          '</button>' +
          '<button type="button" data-scope="future" class="block w-full rounded-lg border border-slate-200 px-4 py-3 text-left hover:bg-slate-50">' +
            '<div class="text-sm font-medium text-slate-900">' + T("app.js.recurring.thisAndFuture") + '</div>' +
            '<div class="mt-0.5 text-xs text-slate-500">' + T("app.js.recurring.thisAndFutureDesc") + '</div>' +
          '</button>' +
          '<button type="button" data-scope="series" class="block w-full rounded-lg border border-slate-200 px-4 py-3 text-left hover:bg-slate-50">' +
            '<div class="text-sm font-medium text-slate-900">' + T("app.js.recurring.all") + '</div>' +
            '<div class="mt-0.5 text-xs text-slate-500">' + T(isDelete ? "app.js.recurring.allDeleteDesc" : "app.js.recurring.allSaveDesc") + '</div>' +
          '</button>' +
        '</div>' +
        '<div class="flex justify-end border-t border-slate-200 px-5 py-3">' +
          '<button type="button" data-scope="" class="rounded-md px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100">' + T("app.js.common.cancel") + '</button>' +
        '</div>';
      overlay.appendChild(card);
      const cleanup = (s) => { try { overlay.remove(); } catch (_e) {} resolve(s || null); };
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) { cleanup(null); return; }
        const btn = e.target.closest("button[data-scope]");
        if (!btn) return;
        cleanup(btn.dataset.scope);
      });
      document.body.appendChild(overlay);
    });
  }

  // The 入会密码 field is meeting-specific: only reveal it when 分类 = 会议.
  // Toggled on modal open + on every category change. The save handler also
  // drops the passcode unless category === "meeting", so a lingering value in
  // the hidden input is never persisted for a non-meeting event.
  function syncMeetingPasswordField() {
    const form = $("#form-event");
    if (!form) return;
    const cat = form.querySelector('[name="category"]');
    const wrap = form.querySelector("#field-meeting-password");
    if (!cat || !wrap) return;
    // Hidden for non-meetings — UNLESS a passcode is already set (e.g. an event
    // created on a native client, which has no category picker), so an existing
    // passcode is never silently hidden and then dropped on save.
    const input = wrap.querySelector('[name="meetingPassword"]');
    const hasValue = !!(input && input.value.trim());
    wrap.classList.toggle("hidden", cat.value !== "meeting" && !hasValue);
  }

  // 时间框是 5 分钟一档（step=300），但已有事件不一定落在档位上：全天事件结束在 23:59，手机建的
  // 可能是 09:07。值对不上档位，表单校验就不过，保存点了没反应 —— 全天事件那两个时间框还是隐藏的，
  // 浏览器连提示都显示不出来。不在档位上的放宽到 1 分钟；两个框一起放宽，改开始时间时结束时间
  // 跟着平移，不会被挪到档位外面。
  function syncTimeStep(form) {
    const inputs = [form.querySelector('[name="startsAt"]'), form.querySelector('[name="endsAt"]')];
    const offGrid = inputs.some((el) => {
      const minutes = Number(String(el.value).slice(14, 16));
      return minutes % 5 !== 0;
    });
    for (const el of inputs) el.step = offGrid ? "60" : "300";
  }

  // 这一次的标识（RECURRENCE-ID）。全天事件存的是「那一天的 UTC 午夜」，而 Toast UI 给的是本地
  // 午夜：直接 toISOString 差一个时区偏移，「只删这一次」对不上，那一次还在，页面却提示成功。
  function occurrenceRefIso(start, isAllDay) {
    const d = start instanceof Date ? start : (start && typeof start.toDate === "function" ? start.toDate() : new Date(start));
    if (!d || isNaN(d.getTime())) return "";
    return isAllDay ? toLocalDateValue(d) + "T00:00:00.000Z" : d.toISOString();
  }

  function openEventModal(payload) {
    const form = $("#form-event");
    form.reset();
    form.querySelector('[name="id"]').value = payload.id || "";
    // Recurring-event scope tracking. The clickEvent handler passes
    // `recurrenceId` = the start of the specific occurrence the user
    // clicked (in TUI Calendar a recurring event renders N times, each
    // with its own .start). We stash it on the form dataset so submit
    // / delete handlers can ask "仅此次 / 此后 / 整个系列" and pass
    // the right recurrenceId to the API. Cleared for new events.
    let recIso = "";
    if (payload.recurrenceId) {
      try {
        const r = payload.recurrenceId;
        recIso = occurrenceRefIso(r, !!payload.allDay);
      } catch (_e) { /* ignore — recurrenceId is optional */ }
    }
    form.dataset.recurrenceId = recIso;
    form.dataset.seriesBase = payload.masterStartsAt || "";
    form.dataset.hasRrule = (payload.rrule && String(payload.rrule).trim()) ? "1" : "";
    if (payload.calendarId) form.querySelector('[name="calendarId"]').value = payload.calendarId;
    if (payload.summary) form.querySelector('[name="summary"]').value = payload.summary;
    if (payload.location) form.querySelector('[name="location"]').value = payload.location;
    if (payload.description) form.querySelector('[name="description"]').value = payload.description;
    form.querySelector('[name="startsAt"]').value = toLocalDateTimeValue(payload.startsAt || new Date());
    form.querySelector('[name="endsAt"]').value = toLocalDateTimeValue(payload.endsAt || new Date(Date.now() + 3600_000));
    syncTimeStep(form);
    form.querySelector('[name="startsAtDate"]').value = toLocalDateValue(payload.startsAt || new Date());
    form.querySelector('[name="endsAtDate"]').value = toLocalDateValue(payload.endsAt || new Date());
    // Remember the just-set start values so the change-listener can
    // compute deltas correctly (we want to track delta from the
    // user's most-recent typed value, not from form.reset()'s blank).
    lastStartsAt = form.querySelector('[name="startsAt"]').value;
    lastStartsAtDate = form.querySelector('[name="startsAtDate"]').value;
    form.querySelector('[name="allDay"]').checked = !!payload.allDay;
    const catSel = form.querySelector('[name="category"]');
    // 认不出的分类直接往下拉上赋值等于静默丢弃，走 setCategoryValue。
    setCategoryValue(payload.category);
    // Bind the category→passcode-visibility listener once. The initial
    // visibility sync runs further down, AFTER the passcode input is populated.
    if (catSel && !catSel.dataset.mpBound) {
      catSel.dataset.mpBound = "1";
      catSel.addEventListener("change", syncMeetingPasswordField);
    }
    // Attendees: hidden field holds the comma-joined list (preserved across
    // saves); summary text + manage link surface in the modal.
    const attendees = Array.isArray(payload.attendees) ? payload.attendees : [];
    form.querySelector('[name="attendees"]').value = attendees.join(",");
    const summary = $("#attendee-summary-text");
    const manage = $("#attendee-manage-link");
    if (summary) summary.textContent = attendees.length > 0
      ? T("app.js.attendees.count", { count: attendees.length, names: attendees.slice(0, 3).join(", ") }) + (attendees.length > 3 ? " …" : "")
      : T("app.js.attendees.none");
    if (manage) {
      manage.classList.toggle("hidden", !payload.id);
      if (payload.id) manage.href = `/app/events/${encodeURIComponent(payload.id)}/attendees`;
    }
    // Link field (separate from notes — stored at extra.url).
    const urlInput = form.querySelector('[name="url"]');
    if (urlInput) urlInput.value = payload.url || "";
    // Meeting join passcode (extra.meetingPassword).
    const pwInput = form.querySelector('[name="meetingPassword"]');
    if (pwInput) pwInput.value = payload.meetingPassword || "";
    // Category + passcode are both set now → compute the field's visibility.
    syncMeetingPasswordField();
    // Recurrence (RRULE)：认不出的规则原样保留，见 setRepeatValue。
    setRepeatValue(payload.rrule);
    // 提醒：第一条进下拉，其余寄存在 [name="extraAlarms"] 里等 submit 拼回去。
    // 下拉里没有的 trigger 会被临时插成一个选项（见 renderReminderOptions），
    // 不再静默显示成「无」——那等于用户存一次就把别的客户端设的提醒删了。
    setReminderFromAlarms(payload.alarms, !!payload.allDay, !!payload.id);
    // Timezone field is now a hidden <input> driven by the custom
    // searchable combobox (#modal-tz). Set the underlying value, then
    // ask the picker to refresh its visible label. For a NEW event with
    // no stored timezone, prefill the BROWSER-DETECTED zone (the OS's IANA
    // zone via Intl — already accurate; no geolocation needed) so the
    // picker reflects where the user actually is instead of a hardcoded
    // Asia/Shanghai. The user still sees + can change it in the picker.
    const tzInput = form.querySelector('[name="timezone"]');
    if (tzInput) {
      let detectedTz = "Asia/Shanghai";
      try { detectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone || detectedTz; } catch (_e) { /* keep fallback */ }
      tzInput.value = payload.timezone || detectedTz;
      const tzPicker = tzInput.closest("[data-tz-picker]");
      if (tzPicker && typeof window.bwcSyncTzPicker === "function") {
        window.bwcSyncTzPicker(tzPicker);
      }
    }
    syncAllDayUI();
    // Show tz hint immediately if the event is anchored to a non-browser zone.
    if (typeof syncTzHint === "function") syncTzHint();
    // Mode: existing events open in VIEW mode (read-only with 编辑 button);
    // new events go straight to EDIT mode. payload.forceEdit lets internal
    // callers override (e.g. the 编辑 button itself).
    const modeFlag = (payload.id && !payload.forceEdit) ? "view" : "edit";
    setModalMode(modeFlag);
    $("#btn-delete-event").classList.toggle("hidden", !payload.id || modeFlag !== "edit");
    openModal("#modal-event");
    // Clear the natural-language input every time the modal opens —
    // stale text from a previous session is more confusing than helpful.
    const nl = $("#nl-input");
    const nlHint = $("#nl-hint");
    if (nl) nl.value = "";
    if (nlHint) { nlHint.classList.add("hidden"); nlHint.textContent = ""; }
  }

  // ---------- Natural-language event parser ----------
  // Parses inputs like "明天下午三点开会" or "周五10点 1小时 团建" into
  // { summary, startsAt, endsAt }. Returns null if it can't pull out at
  // least one date+time. Pure regex — no LLM, no API call, runs entirely
  // in the user's browser, works offline. Kept behaviour-identical to the
  // server parser in src/lib/nl_parse.ts (guarded by test/nl_parse.test.ts)
  // so web / iOS / Android / desktop all understand the same phrasings.
  const NL_CN_DIGIT = {
    "零": 0, "〇": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4,
    "五": 5, "六": 6, "七": 7, "八": 8, "九": 9,
  };
  // ---------- Natural-language parsing ----------
  // The parser itself lives in src/lib/nl_parse.ts and is compiled to
  // /static/lib/nl-parse.js by scripts/build-nl-bundle.mjs. It used to be
  // duplicated here by hand, which meant every fix had to land twice and any
  // missed sync was a bug users could see; now the server, the native apps
  // and this live preview all run the exact same code.
  function parseNaturalLanguageEvent(text) {
    const nl = window.BWC_NL;
    if (!nl || typeof nl.parse !== "function") return null; // bundle failed to load
    // The parser is wall-clock based: hand it OUR local now, never UTC.
    const d = new Date();
    const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
      `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    let r;
    try { r = nl.parse(text, local); } catch { return null; }
    if (!r) return null;
    // The shared parser returns naive local strings ("2026-08-08T15:00:00");
    // showParsed() below wants Date objects (it calls toDateString/getHours).
    // A date-time string with no zone is parsed as LOCAL by spec, which is
    // exactly the wall-clock reading we want — no timezone shift here.
    // location / rrule / allDay ride along when the parser found them
    // (older bundles simply leave them undefined).
    return {
      summary: r.summary,
      startsAt: new Date(r.startsAt),
      endsAt: new Date(r.endsAt),
      location: r.location || null,
      rrule: r.rrule || null,
      allDay: !!r.allDay,
    };
  }

  // Wire the natural-language input. As the user types we show a LIVE
  // (debounced) preview of what we understood — but only touch the form
  // fields on an explicit commit (Enter or blur), so a half-typed phrase
  // never rewrites the form underneath them. Failures stay quiet during
  // typing and only nudge on commit.
  {
    const nlInput = $("#nl-input");
    const nlHint = $("#nl-hint");
    // Localized "Aug 6"-style date (zh-CN renders as 8月6日 via Intl).
    const fmtDate = (d) => new Intl.DateTimeFormat(LOCALE, { month: "long", day: "numeric" }).format(d);
    const fmtTime = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    // "7月4日 15:00–16:30 · 开会 · 星巴克" — collapse the end to just a time
    // when it's the same calendar day, so the duration reads at a glance.
    // All-day parses show just the date (00:00–23:59 would be noise).
    // Shared by the modal preview and the main-screen quick-add preview.
    function fmtParsed(parsed) {
      const title = parsed.summary || T("app.js.nl.untitled");
      const place = parsed.location ? ` · ${parsed.location}` : "";
      if (parsed.allDay) return `✓ ${fmtDate(parsed.startsAt)} · ${title}${place}`;
      const sameDay = parsed.startsAt.toDateString() === parsed.endsAt.toDateString();
      const endStr = sameDay ? fmtTime(parsed.endsAt) : `${fmtDate(parsed.endsAt)} ${fmtTime(parsed.endsAt)}`;
      return `✓ ${fmtDate(parsed.startsAt)} ${fmtTime(parsed.startsAt)}–${endStr} · ${title}${place}`;
    }
    function showParsed(parsed, commit) {
      if (!nlInput || !nlHint) return;
      if (!parsed) {
        if (commit && nlInput.value.trim()) {
          nlHint.classList.remove("hidden");
          nlHint.style.color = "rgb(100 116 139)";
          nlHint.textContent = T("app.js.nl.noTime");
        } else {
          nlHint.classList.add("hidden");
          nlHint.textContent = "";
        }
        return;
      }
      if (commit) {
        const form = $("#form-event");
        if (parsed.summary) form.querySelector('[name="summary"]').value = parsed.summary;
        form.querySelector('[name="startsAt"]').value = toLocalDateTimeValue(parsed.startsAt);
        form.querySelector('[name="endsAt"]').value = toLocalDateTimeValue(parsed.endsAt);
        // 地点 / 重复 / 全天：解析器给得出才填，给不出就不动表单现有的值。
        if (parsed.location) form.querySelector('[name="location"]').value = parsed.location;
        if (parsed.rrule) setRepeatValue(parsed.rrule);
        if (parsed.allDay) {
          form.querySelector('[name="allDay"]').checked = true;
          form.querySelector('[name="startsAtDate"]').value = toLocalDateValue(parsed.startsAt);
          form.querySelector('[name="endsAtDate"]').value = toLocalDateValue(parsed.endsAt);
          syncAllDayUI();
          switchReminderGroup(true);
        }
      }
      nlHint.classList.remove("hidden");
      nlHint.style.color = "rgb(67 56 202)"; // brand-700
      nlHint.textContent = fmtParsed(parsed);
    }
    function applyNl(commit) {
      if (!nlInput) return;
      showParsed(parseNaturalLanguageEvent(nlInput.value), commit);
    }
    if (nlInput) {
      let debounce;
      nlInput.addEventListener("input", () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => applyNl(false), 200); // live preview only
      });
      nlInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); clearTimeout(debounce); applyNl(true); }
      });
      nlInput.addEventListener("blur", () => { clearTimeout(debounce); if (nlInput.value.trim()) applyNl(true); });
    }

    // 主界面常驻快速添加框（#quick-add-input）：和弹窗里那个输入框共用同一个
    // 解析器和同一套回填（showParsed 的 commit 分支）。
    // 输入时只预览；回车打开新建表单并回填（解析不出来时也打开表单，
    // 原文放进标题和弹窗的 NL 输入框，用户接着手改即可，不丢字）。
    // 解析完整（有时间 + 有标题）时预览行里多两个动作：「直接保存」
    // 不弹窗直接建事件，保存后 toast 带「打开 / 撤销」；「打开表单
    // 核对」就是原来的回车路径。解析不完整仍只有回车开表单一条路。
    const qaInput = $("#quick-add-input");
    const qaHint = $("#quick-add-hint");
    if (qaInput && qaHint) {
      let qaDebounce;
      let qaSaving = false;
      // 最近一次「完整」解析（标题非空才算完整：只有时间没有标题的
      // 句子存下去是个无名事件，不给直接保存）。
      let qaParsed = null;
      const qaComplete = (p) => !!(p && p.summary && p.summary.trim());
      const openQaForm = () => {
        const text = qaInput.value.trim();
        if (!text) return;
        const parsed = parseNaturalLanguageEvent(text);
        openNewEvent();
        // openEventModal 会清掉弹窗 NL 输入框，所以原文要在打开之后再放回去。
        if (nlInput) nlInput.value = text;
        if (parsed) {
          showParsed(parsed, true);
        } else {
          const form = $("#form-event");
          if (form) form.querySelector('[name="summary"]').value = text;
          showParsed(null, true);
        }
        qaInput.value = "";
        showQa(null);
      };
      // 直接保存：请求体与表单新建分支同口径（日历取表单下拉的第一项
      // ——也就是回车开表单时 reset 后的默认值；时区取浏览器时区，与
      // openEventModal 给新事件预填的一致；提醒取新建默认档，和表单
      // 打开时的下拉默认值一致）。先走一遍软冲突检查：有冲突就不直存，
      // 改开表单，让用户在既有的冲突确认框里决定。
      const directSaveQa = async () => {
        const parsed = qaParsed;
        if (!parsed || qaSaving) return;
        const form = $("#form-event");
        const calSel = form?.querySelector('[name="calendarId"]');
        const calendarId = calSel?.options?.[0]?.value || "";
        if (!calendarId) { openQaForm(); return; }
        const isAllDay = !!parsed.allDay;
        const startsIso = isAllDay
          ? toLocalDateValue(parsed.startsAt) + "T00:00:00.000Z"
          : parsed.startsAt.toISOString();
        const endsIso = isAllDay
          ? toLocalDateValue(parsed.endsAt) + "T23:59:59.999Z"
          : parsed.endsAt.toISOString();
        let browserTz = "Asia/Shanghai";
        try { browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || browserTz; } catch (_e) { /* keep fallback */ }
        // extra 先建成变量再挂上 body：六个键与表单 submit 同口径
        // （该发的显式 null 一个不少）。不写成 body 里的内联字面量，
        // 是因为 reminder_enum_parity 测试按「文件里第一个 extra 字面量
        // = 表单 submit 的」来守这条口径，内联会把它带偏。
        const qaExtra = {
          category: null,
          timezone: browserTz,
          attendees: null,
          url: null,
          meetingPassword: null,
          alarms: FORM.collectAlarms(
            isAllDay ? FORM.REMINDER_DEFAULTS.allday : FORM.REMINDER_DEFAULTS.timed,
            "",
            parsed.summary,
          ),
        };
        const body = {
          calendarId,
          summary: parsed.summary,
          location: parsed.location || undefined,
          allDay: isAllDay,
          startsAt: startsIso,
          endsAt: endsIso,
          rrule: parsed.rrule || undefined,
          extra: qaExtra,
        };
        qaSaving = true;
        try {
          try {
            const cResp = await fetch("/api/events/conflicts", fetchOpts({
              method: "POST",
              body: JSON.stringify({ calendarId, startsAt: startsIso, endsAt: endsIso }),
            }));
            if (cResp.ok) {
              const { conflicts } = await cResp.json();
              if (Array.isArray(conflicts) && conflicts.length > 0) { openQaForm(); return; }
            }
          } catch (_e) { /* 软检查失败不挡保存，与表单口径一致 */ }
          const resp = await fetch("/api/events", fetchOpts({ method: "POST", body: JSON.stringify(body) }));
          if (!resp.ok) throw new Error(await resp.text());
          learnLocationOnSave({ location: parsed.location, summary: parsed.summary });
          const created = await resp.json().catch(() => null);
          qaInput.value = "";
          showQa(null);
          await loadEvents();
          const createdId = created && created.id;
          window.bwc && window.bwc.toast(
            T("app.js.quickadd.added", { title: parsed.summary }),
            "success",
            createdId ? {
              actions: [
                { label: T("app.js.quickadd.open"), onAction: () => { void openExistingEvent(calendarId, createdId, null, null); } },
                {
                  label: T("app.js.toast.undo"),
                  onAction: async () => {
                    try {
                      const dResp = await fetch(`/api/events/${createdId}`, fetchOpts({ method: "DELETE" }));
                      if (!dResp.ok) throw new Error(await dResp.text());
                      await loadEvents();
                      window.bwc && window.bwc.toast(T("app.js.quickadd.undone"), "success");
                    } catch (_e) {
                      window.bwc && window.bwc.toast(T("app.js.toast.deleteFailed"), "error");
                    }
                  },
                },
              ],
            } : undefined,
          );
        } catch (err) {
          console.error(err);
          const reason = describeSaveError(err);
          window.bwc && window.bwc.toast(
            reason ? T("app.js.toast.saveFailedReason", { reason }) : T("app.js.toast.saveFailed"),
            "error",
            { durationMs: 6000 },
          );
        } finally {
          qaSaving = false;
        }
      };
      const showQa = (parsed) => {
        qaParsed = qaComplete(parsed) ? parsed : null;
        if (!parsed) { qaHint.classList.add("hidden"); qaHint.textContent = ""; return; }
        qaHint.classList.remove("hidden");
        qaHint.textContent = "";
        const span = document.createElement("span");
        span.textContent = fmtParsed(parsed);
        qaHint.appendChild(span);
        if (qaParsed) {
          const mkBtn = (label, onClick) => {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "ml-2 rounded-full border border-brand-300 bg-white px-2 py-0.5 font-medium text-brand-700 hover:bg-brand-50";
            b.textContent = label;
            b.addEventListener("click", onClick);
            return b;
          };
          qaHint.appendChild(mkBtn(T("app.js.quickadd.saveDirectly"), () => { void directSaveQa(); }));
          qaHint.appendChild(mkBtn(T("app.js.quickadd.openForm"), openQaForm));
        }
      };
      qaInput.addEventListener("input", () => {
        clearTimeout(qaDebounce);
        qaDebounce = setTimeout(() => showQa(parseNaturalLanguageEvent(qaInput.value)), 200);
      });
      qaInput.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        clearTimeout(qaDebounce);
        openQaForm();
      });
    }
  }

  // Both the desktop toolbar button and the mobile FAB share this handler.
  // Default start = next half hour, matching the three apps (and the web
  // quick-add): a raw `new Date()` would prefill e.g. 21:47–22:47, a slot
  // nobody means. End keeps the 1h default duration from the rounded start.
  const openNewEvent = () => {
    const start = new Date();
    start.setSeconds(0, 0);
    if (start.getMinutes() < 30) start.setMinutes(30);
    else { start.setMinutes(0); start.setHours(start.getHours() + 1); }
    openEventModal({ startsAt: start, endsAt: new Date(start.getTime() + 3600_000) });
  };
  $("#btn-new-event").addEventListener("click", openNewEvent);
  $("#btn-new-event-fab")?.addEventListener("click", openNewEvent);
  // Empty-state nudge buttons reuse the same handlers.
  $("#empty-new-event")?.addEventListener("click", openNewEvent);
  $("#empty-import")?.addEventListener("click", () => openImportCalendar());

  cal.on("selectDateTime", (info) => {
    // Quantize the click-drag selection to 5 minutes — Toast UI by default
    // snaps to 30-minute cells which is too coarse for short meetings.
    const start = info.isAllday ? info.start : roundTo5Min(info.start);
    const end = info.isAllday ? info.end : roundTo5Min(info.end);
    openEventModal({ startsAt: start, endsAt: end, allDay: info.isAllday });
    cal.clearGridSelections();
  });

  // Open an existing event's editor. Shared by grid clicks and by the
  // ?event=&cal= deep link (push notifications and the in-app inbox point
  // here). occStart/occEnd are the clicked occurrence's bounds; deep
  // links don't know them and pass null → master bounds are used.
  async function openExistingEvent(calId, id, occStart, occEnd) {
    // Fetch just this one event (server filters by ?eventId) rather than
    // pulling the entire calendar's event list to find one by id. Falls back
    // gracefully on older servers that ignore the param (returns all → .find).
    const evs = await fetch(`/api/calendars/${calId}/events?eventId=${encodeURIComponent(id)}`, fetchOpts()).then((r) => r.json()).catch(() => []);
    const fresh = (evs || []).find((e) => e.id === id);
    if (!fresh) return;
    const extra = fresh.extra || {};
    openEventModal({
      id: fresh.id,
      calendarId: fresh.calendarId,
      summary: fresh.summary,
      location: fresh.location,
      description: fresh.description,
      url: extra.url || "",
      meetingPassword: extra.meetingPassword || "",
      // Show the clicked occurrence's start/end (not the master's) so
      // editing "仅此次" starts from the right slot. fresh.startsAt is
      // the master; occStart is the occurrence.
      startsAt: occStart || fresh.startsAt,
      endsAt: occEnd || fresh.endsAt,
      masterStartsAt: fresh.startsAt,
      allDay: fresh.allDay,
      rrule: fresh.rrule || "",
      // The occurrence's start doubles as the RECURRENCE-ID. The server
      // uses this to know which instance to add to exdates / split at.
      recurrenceId: occStart || null,
      category: extra.category,
      timezone: extra.timezone,
      attendees: Array.isArray(extra.attendees) ? extra.attendees : [],
      alarms: Array.isArray(extra.alarms) ? extra.alarms : [],
    });
  }

  cal.on("clickEvent", (info) => {
    void openExistingEvent(info.event.calendarId, info.event.id, info.event.start, info.event.end);
  });

  // Deep link: /app?event=<id>&cal=<calendarId> opens that event once, on
  // load. The params are stripped right away so a refresh (or the version
  // checker's silent reload) doesn't reopen the editor over the user's
  // work. Failures are silent — a deleted event just lands on the calendar.
  (function openDeepLinkedEvent() {
    let params;
    try { params = new URLSearchParams(window.location.search); } catch (_e) { return; }
    const eventId = params.get("event");
    const calId = params.get("cal");
    if (!eventId || !calId) return;
    params.delete("event");
    params.delete("cal");
    const rest = params.toString();
    try {
      window.history.replaceState(null, "", window.location.pathname + (rest ? "?" + rest : "") + window.location.hash);
    } catch (_e) { /* history unavailable — the params just stay */ }
    void openExistingEvent(calId, eventId, null, null);
  })();

  function parseEmails(s) {
    return String(s || "")
      .split(/[\s,;，；]+/)
      .map((x) => x.trim().toLowerCase())
      .filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
  }

  // 把一个「保存失败」的异常翻译成一句能直接给用户看的话。直连 fetch 的那几条路径
  // 抛的是 new Error(await resp.text())，body 多半是
  // {"error":"invalid_body","message":"<哪个字段不对>"}。拿不出话来就返回空串，
  // 由调用方退回那句笼统的「保存失败」。
  function describeSaveError(err) {
    const raw = (err && err.message ? String(err.message) : "").trim();
    if (!raw) return "";
    let data = raw;
    try { data = JSON.parse(raw); } catch (_e) { /* 不是 JSON 就按原文处理 */ }
    const core = globalThis.bwcOutboxCore;
    if (core && typeof core.describeServerError === "function") {
      const msg = core.describeServerError(data, 0);
      return msg === "HTTP 0" ? "" : msg;
    }
    return raw.length > 200 ? raw.slice(0, 200) + "…" : raw;
  }

  $("#form-event").addEventListener("submit", async (e) => {
    e.preventDefault();
    // Guard against double-submit. The handler awaits a conflict-check
    // round-trip before saving; a fast double-click (or Enter + click) in
    // that window would call bwcStore.put() twice, each minting a DIFFERENT
    // local id / clientUid — so the server's idempotency can't collapse
    // them and you'd get TWO events. Disable the button for the whole flow
    // (the `finally` re-enables it) and also surface a "保存中…" state.
    const submitBtn = e.target.querySelector('button[type="submit"]');
    if (submitBtn && submitBtn.dataset.saving === "1") return;
    const prevLabel = submitBtn ? submitBtn.textContent : "";
    if (submitBtn) { submitBtn.dataset.saving = "1"; submitBtn.disabled = true; submitBtn.textContent = T("app.js.saving"); }
    try {
    const data = Object.fromEntries(new FormData(e.target).entries());
    const id = data.id;
    const isAllDay = !!data.allDay;
    let startsIso, endsIso;
    if (isAllDay) {
      // Date-only inputs — store the calendar date as UTC midnight directly so
      // it never crosses a day boundary under a TZ shift.
      startsIso = data.startsAtDate + "T00:00:00.000Z";
      endsIso = data.endsAtDate + "T23:59:59.999Z";
    } else {
      // datetime-local gives "YYYY-MM-DDTHH:MM" interpreted as the user's
      // browser-local time; toISOString converts to UTC.
      startsIso = new Date(data.startsAt).toISOString();
      endsIso = new Date(data.endsAt).toISOString();
    }
    const attendees = parseEmails(data.attendees);
    const body = {
      calendarId: data.calendarId,
      summary: data.summary,
      location: data.location || (id ? "" : undefined),
      description: data.description || (id ? "" : undefined),
      allDay: isAllDay,
      startsAt: startsIso,
      endsAt: endsIso,
      // 编辑时空着要发**空串**，不能省略。服务端对 rrule 是「不传 = 保留原值」，
      // 于是把重复下拉改成「不重复」再保存，页面提示成功、事件照旧每周重复，
      // 怎么点都改不掉。（发 null 会被挡成 400，空串才是服务端认的清空写法。）
      // 新建时没有原值可清，省略即可，免得在库里留一串空字符串。
      rrule: (data.rrule || "").trim() || (id ? "" : undefined),
      // extra 的每个键在「用户清空了」时都要发**显式 null**，不能靠省略。
      // 服务端的 extra 现在是浅合并（传了才覆盖），省略的含义从「删除」变成了
      // 「保留原值」—— 这里漏掉任何一个键，用户就再也清不掉那个字段，
      // 而且页面照常保存成功、不报任何错。新增 extra 字段时记得一起加进来。
      extra: {
        category: data.category || null,
        timezone: data.timezone || null,
        attendees: attendees.length ? attendees : null,
        url: (data.url || "").trim() || null,
        meetingPassword: (data.meetingPassword || "").trim() || null,
        alarms: collectAlarms(data.reminder, data.extraAlarms, data.summary),
      },
    };
    // Conflict check (soft) — let user confirm overlap before saving.
    try {
      const cResp = await fetch("/api/events/conflicts", fetchOpts({
        method: "POST",
        body: JSON.stringify({ calendarId: body.calendarId, startsAt: body.startsAt, endsAt: body.endsAt, excludeId: id || undefined }),
      }));
      if (cResp.ok) {
        const { conflicts } = await cResp.json();
        if (Array.isArray(conflicts) && conflicts.length > 0) {
          const names = conflicts.slice(0, 3).map((c) => "• " + c.summary).join("\n");
          const more = conflicts.length > 3 ? `\n• ${T("app.js.conflict.more", { n: conflicts.length - 3 })}` : "";
          if (!(await window.bwc.confirm({
            title: T("app.js.conflict.title"),
            message: `${T("app.js.conflict.message")}\n${names}${more}\n\n${T("app.js.conflict.question")}`,
            confirmLabel: T("app.js.conflict.saveAnyway"),
          }))) return;
        }
      }
    } catch (_e) { /* soft check — never block save on a network glitch */ }
    // Recurring-event scope dialog: if we're editing an existing event
    // that has an RRULE, ask whether the change applies to just this
    // occurrence, this+future, or the whole series. New events skip
    // this (no RRULE yet) and series scope on a recurring event takes
    // the regular master-patch path so bwcStore can still cache it.
    const form = $("#form-event");
    let recurringScope = null;
    if (id && form && form.dataset.hasRrule === "1") {
      recurringScope = await promptRecurringScope("edit");
      if (!recurringScope) return; // user cancelled — leave modal open
    }
    try {
      // Scoped recurring edits (instance / future) must hit the server
      // directly — bwcStore's outbox doesn't yet model exdates or series
      // splits, so an offline scoped edit would silently misbehave on
      // sync. "Series" scope is equivalent to a normal master patch.
      const isScopedRecurring = recurringScope === "instance" || recurringScope === "future";
      if (isScopedRecurring) {
        const recurrenceId = form.dataset.recurrenceId || undefined;
        const resp = await fetch(`/api/events/${id}`, fetchOpts({
          method: "PATCH",
          body: JSON.stringify({ ...body, scope: recurringScope, recurrenceId }),
        }));
        if (!resp.ok) throw new Error(await resp.text());
        closeModal("#modal-event");
        await loadEvents();
        learnLocationOnSave(data);
        window.bwc && window.bwc.toast(T("app.js.toast.eventUpdated"), "success");
      } else if (window.bwcStore) {
        // Route through bwcStore when available — optimistic local update +
        // outbox queue means the modal can close instantly even on flaky network.
        // 「所有事件」要告诉服务端点开的是哪一次：表单里的时间是那一次的，不是系列开始的时间
        // （服务端按差值平移主事件，见 routes/events.ts 的 timesForSeriesEdit）。
        // seriesBase 防重发：发送队列超时会重发，平移不能做两遍。
        const seriesRef = recurringScope === "series" && form.dataset.recurrenceId
          ? { scope: "series", recurrenceId: form.dataset.recurrenceId, seriesBase: form.dataset.seriesBase || undefined }
          : {};
        await window.bwcStore.put(id ? { ...body, ...seriesRef, id } : body, body.calendarId);
        closeModal("#modal-event");
        await loadEvents();
        learnLocationOnSave(data);
        const offline = !window.bwcStore.isOnline();
        window.bwc && window.bwc.toast(
          offline
            ? T("app.js.toast.eventQueuedOffline")
            : (id ? T("app.js.toast.eventUpdated") : T("app.js.toast.eventAdded")),
          "success",
        );
      } else {
        const url = id ? `/api/events/${id}` : "/api/events";
        const method = id ? "PATCH" : "POST";
        const resp = await fetch(url, fetchOpts({ method, body: JSON.stringify(body) }));
        if (!resp.ok) throw new Error(await resp.text());
        closeModal("#modal-event");
        await loadEvents();
        learnLocationOnSave(data);
        window.bwc && window.bwc.toast(id ? T("app.js.toast.eventUpdated") : T("app.js.toast.eventAdded"), "success");
      }
    } catch (err) {
      console.error(err);
      // 服务端的拒绝里带着哪个字段不对（/api/events 的 400 是
      // { error, message }），以前这句话只进了 console，用户看到的是光秃秃一句
      // 「保存失败」—— 于是他只能反复点保存，每次都被同一个原因挡掉。
      const reason = describeSaveError(err);
      window.bwc && window.bwc.toast(
        reason ? T("app.js.toast.saveFailedReason", { reason: reason }) : T("app.js.toast.saveFailed"),
        "error",
        { durationMs: 6000 },
      );
    }
    } finally {
      // Re-enable on every exit path (success, validation cancel, error)
      // so the form is usable again. Harmless when the modal already closed.
      if (submitBtn) { submitBtn.dataset.saving = ""; submitBtn.disabled = false; submitBtn.textContent = prevLabel; }
    }
  });

  $("#btn-delete-event").addEventListener("click", async () => {
    const form = $("#form-event");
    const id = $('#form-event [name="id"]').value;
    if (!id) return;
    // For recurring events the scope dialog IS the confirmation.
    // For non-recurring, the styled bwc.confirm dialog.
    let recurringScope = null;
    if (form && form.dataset.hasRrule === "1") {
      recurringScope = await promptRecurringScope("delete");
      if (!recurringScope) return; // user cancelled
    } else {
      if (!(await window.bwc.confirm({ message: T("app.js.deleteEvent.confirm"), danger: true, confirmLabel: T("app.js.common.delete") }))) return;
    }
    // Scoped recurring delete (this / this+future): bypass bwcStore
    // and hit the server directly with ?scope=&recurrenceId= — the
    // offline outbox model can't represent partial-series deletes
    // safely.
    const isScopedRecurring = recurringScope === "instance" || recurringScope === "future";
    if (isScopedRecurring) {
      const recurrenceId = form.dataset.recurrenceId || "";
      const qs = `?scope=${recurringScope}&recurrenceId=${encodeURIComponent(recurrenceId)}`;
      try {
        const resp = await fetch(`/api/events/${id}${qs}`, {
          method: "DELETE",
          credentials: "same-origin",
          headers: { "X-CSRF-Token": ctx.csrfToken },
        });
        if (!resp.ok && resp.status !== 404) throw new Error(await resp.text());
        closeModal("#modal-event");
        await loadEvents();
        window.bwc && window.bwc.toast(
          recurringScope === "instance" ? T("app.js.toast.deletedInstance") : T("app.js.toast.deletedFuture"),
          "success",
        );
      } catch (err) {
        console.error("delete_recurring_scoped", err);
        window.bwc && window.bwc.toast(T("app.js.toast.deleteFailed"), "error");
      }
      return;
    }
    // Undo handler — POSTs to /api/events/:id/restore which clears
    // deletedAt. Used by both the bwcStore and direct-delete code
    // paths below. Re-fetches grid on success.
    async function undoDelete() {
      try {
        const resp = await fetch(`/api/events/${id}/restore`, fetchOpts({ method: "POST" }));
        if (!resp.ok && resp.status !== 404) throw new Error(await resp.text());
        // If bwcStore is in use, our local mirror still has the
        // delete-pending state — easiest fix is to invalidate the cache
        // and let getAll repopulate from the server.
        if (window.bwcStore && window.bwcStore.invalidate) {
          try { await window.bwcStore.invalidate(); } catch (_e) {}
        }
        await loadEvents();
        window.bwc && window.bwc.toast(T("app.js.toast.undoDone"), "success");
      } catch (err) {
        console.error("undo_delete", err);
        window.bwc && window.bwc.toast(T("app.js.toast.undoFailed"), "error");
      }
    }

    // Optimistic delete via bwcStore — works offline.
    if (window.bwcStore) {
      try {
        await window.bwcStore.remove(id);
        closeModal("#modal-event");
        await loadEvents();
        const offline = !window.bwcStore.isOnline();
        if (offline) {
          // No undo for offline deletes — restore would race with the
          // outbox replay. User can dig into the conflict modal if
          // they really need to recover.
          window.bwc && window.bwc.toast(T("app.js.toast.deleteQueuedOffline"), "success");
        } else {
          window.bwc && window.bwc.toast(T("app.js.toast.eventDeleted"), "success", {
            actionLabel: T("app.js.toast.undo"), onAction: undoDelete,
          });
        }
      } catch (err) {
        console.error("delete_event_store", err);
        window.bwc && window.bwc.toast(T("app.js.toast.deleteFailed"), "error");
      }
      return;
    }
    let resp;
    try {
      // DELETE has no body — sending Content-Type: application/json without a
      // body makes Fastify's JSON parser reject with 400. Send only the CSRF
      // header, no content-type.
      resp = await fetch(`/api/events/${id}`, {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "X-CSRF-Token": ctx.csrfToken },
      });
    } catch (err) {
      console.error("delete_event_network", err);
      window.bwc && window.bwc.toast(T("app.js.toast.deleteFailedNetwork"), "error");
      return;
    }
    // 204 / 200 → deleted; 404 → already gone (treat as success and just refresh)
    if (resp.ok || resp.status === 404) {
      closeModal("#modal-event");
      await loadEvents();
      if (resp.status === 404) {
        window.bwc && window.bwc.toast(T("app.js.toast.eventGone"), "success");
      } else {
        window.bwc && window.bwc.toast(T("app.js.toast.eventDeleted"), "success", {
          actionLabel: T("app.js.toast.undo"), onAction: undoDelete,
        });
      }
      return;
    }
    let errBody = "";
    try { errBody = (await resp.json()).error || ""; } catch (_e) { errBody = ""; }
    console.error("delete_event_failed", resp.status, errBody);
    window.bwc && window.bwc.toast(`${T("app.js.toast.deleteFailedHttp", { status: resp.status })}${errBody ? ": " + errBody : ""}`, "error");
  });

  // ---------- Calendar create / import (Synology-style add menu) ----------
  const COLOR_PALETTE = [
    "#ef4444", "#f97316", "#f59e0b", "#eab308", "#84cc16",
    "#22c55e", "#10b981", "#14b8a6", "#06b6d4", "#0ea5e9",
    "#3b82f6", "#6366f1", "#8b5cf6", "#a855f7", "#d946ef",
    "#ec4899", "#64748b",
  ];

  function buildColorPicker(container, hiddenInputName, initial) {
    container.innerHTML = "";
    COLOR_PALETTE.forEach((c) => {
      const sw = document.createElement("button");
      sw.type = "button";
      sw.dataset.color = c;
      sw.className = "color-swatch relative h-7 w-7 rounded-md border border-slate-200 hover:scale-110 transition-transform";
      const swatchBase = document.documentElement.getAttribute("data-mode") === "dark" ? "#1e293b" : "#f8fafc";
      sw.style.background = `linear-gradient(135deg, ${c} 50%, ${swatchBase} 50%)`;
      sw.setAttribute("aria-label", T("app.js.colorLabel", { c }));
      container.appendChild(sw);
    });
    const setSelected = (val) => {
      container.querySelectorAll(".color-swatch").forEach((s) => {
        s.classList.toggle("ring-2", s.dataset.color === val);
        s.classList.toggle("ring-offset-1", s.dataset.color === val);
        s.classList.toggle("ring-slate-700", s.dataset.color === val);
      });
      const form = container.closest("form");
      const input = form ? form.querySelector(`[name="${hiddenInputName}"]`) : null;
      if (input) input.value = val;
    };
    container.addEventListener("click", (e) => {
      const t = e.target.closest(".color-swatch");
      if (!t) return;
      setSelected(t.dataset.color);
    });
    setSelected(initial);
  }

  // Add-menu popover (创建 / 导入)
  const addTrigger = $("#btn-cal-menu-trigger");
  const addPopover = $("#cal-add-popover");
  if (addTrigger && addPopover) {
    addTrigger.addEventListener("click", (e) => {
      e.stopPropagation();
      addPopover.classList.toggle("hidden");
    });
    document.addEventListener("click", (e) => {
      if (!addPopover.contains(e.target) && e.target !== addTrigger) addPopover.classList.add("hidden");
    });
    addPopover.querySelectorAll("[data-action]").forEach((btn) => {
      btn.addEventListener("click", () => {
        addPopover.classList.add("hidden");
        if (btn.dataset.action === "create") openCreateCalendar();
        else openImportCalendar();
      });
    });
  }

  function openCreateCalendar() {
    const form = $("#form-calendar");
    form.reset();
    buildColorPicker(form.querySelector('[data-color-picker="form-calendar"]'), "color", "#6366f1");
    // form.reset() restores the hidden timezone input to its HTML default
    // (Asia/Shanghai). A NEW calendar should start from the browser-detected
    // zone — the same rule the event form and the import flow already use —
    // otherwise everyone outside China silently gets a Shanghai calendar
    // and every recurring event in it expands against the wrong wall clock.
    const calTzInput = form.querySelector('[name="timezone"]');
    if (calTzInput) {
      let detectedTz = "Asia/Shanghai";
      try { detectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone || detectedTz; } catch (_e) { /* keep fallback */ }
      calTzInput.value = detectedTz;
      const calTzPicker = calTzInput.closest("[data-tz-picker]");
      if (calTzPicker && typeof window.bwcSyncTzPicker === "function") {
        window.bwcSyncTzPicker(calTzPicker);
      }
    }
    // Reset to General tab
    form.querySelectorAll(".cal-tab").forEach((t) => {
      const active = t.dataset.calTab === "general";
      t.classList.toggle("border-brand-600", active);
      t.classList.toggle("text-brand-700", active);
      t.classList.toggle("border-transparent", !active);
      t.classList.toggle("text-slate-500", !active);
    });
    form.querySelectorAll("[data-cal-pane]").forEach((p) => p.classList.toggle("hidden", p.dataset.calPane !== "general"));
    openModal("#modal-calendar");
  }

  // Tab switch in create modal
  $("#modal-calendar").addEventListener("click", (e) => {
    const t = e.target.closest(".cal-tab");
    if (!t) return;
    const form = $("#form-calendar");
    form.querySelectorAll(".cal-tab").forEach((x) => {
      const active = x.dataset.calTab === t.dataset.calTab;
      x.classList.toggle("border-brand-600", active);
      x.classList.toggle("text-brand-700", active);
      x.classList.toggle("border-transparent", !active);
      x.classList.toggle("text-slate-500", !active);
    });
    form.querySelectorAll("[data-cal-pane]").forEach((p) => p.classList.toggle("hidden", p.dataset.calPane !== t.dataset.calTab));
  });

  $("#form-calendar").addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target).entries());
    try {
      const resp = await fetch("/api/calendars", fetchOpts({ method: "POST", body: JSON.stringify(data) }));
      if (!resp.ok) throw new Error(await resp.text());
      window.bwc && window.bwc.toast(T("app.js.toast.calendarCreated"), "success");
      setTimeout(() => window.location.reload(), 400);
    } catch (err) {
      console.error(err);
      window.bwc && window.bwc.toast(T("app.js.toast.createFailed"), "error");
    }
  });

  // ---------- Import calendar ----------
  // 「导入到新日历」时，这一次打开弹窗里已经建好的那个日历。
  // 导入失败时弹窗会留着让用户改了再点（以前失败也说「导入完成」并刷新，不存在「再点一次」）——
  // 再点不能再建一个新日历，不然每失败一次就多一个空日历。重新打开弹窗时清掉。
  let importCreatedCalendarId = null;

  // 两步导入（文件 / 粘贴）：第一次点「导入」先预览（只解析判定、不落库），
  // 用户看过数字点「确认导入」才真的写。状态记的是「预览看的内容 + 目标日历」
  // 的指纹 —— 内容或目标变了必须重新预览，不许拿旧数字去导另一份东西。
  let importPreviewState = null; // { key, calendarId }

  function resetImportPreview() {
    importPreviewState = null;
    const panel = $("#import-preview");
    if (panel) panel.classList.add("hidden");
    const form = $("#form-import");
    const btn = form && form.querySelector('button[type="submit"]');
    if (btn && !btn.disabled) btn.textContent = T("app.js.import.submit");
  }

  function showImportPreview(preview) {
    const panel = $("#import-preview");
    const summary = $("#import-preview-summary");
    const reasons = $("#import-preview-reasons");
    if (!panel || !summary || !reasons) return;
    summary.textContent = T("app.js.import.previewSummary", {
      total: preview.total, inserted: preview.inserted, updated: preview.updated,
      duplicates: preview.duplicates, invalid: preview.invalid,
    });
    reasons.innerHTML = "";
    (preview.invalidReasons || []).forEach((r) => {
      const li = document.createElement("li");
      li.textContent = r;
      reasons.appendChild(li);
    });
    reasons.classList.toggle("hidden", !(preview.invalidReasons || []).length);
    panel.classList.remove("hidden");
  }

  // 预览接口只回 JSON。判成功口径和导入一致（见 bwcImportResult 的注释）：
  // 只有服务端明说 ok: true 且带 preview 才算数，其余一律按失败处理。
  async function postImportPreview(url, body) {
    const resp = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      body,
    });
    let data = null;
    try { data = await resp.json(); } catch (_e) { data = null; }
    if (data && data.ok === true && data.preview) return data.preview;
    if (data && data.ok === false && typeof data.message === "string" && data.message) {
      const e = new Error(data.message);
      e.userFacing = true;
      throw e;
    }
    const e = new Error(T("app.js.import.reloadAndRetry"));
    e.userFacing = true;
    throw e;
  }

  function openImportCalendar() {
    const form = $("#form-import");
    importCreatedCalendarId = null;
    resetImportPreview();
    form.reset();
    buildColorPicker(form.querySelector('[data-color-picker="form-import"]'), "newColor", "#6366f1");
    // Reset source pane to file
    form.querySelectorAll("[data-source-pane]").forEach((p) => p.classList.toggle("hidden", p.dataset.sourcePane !== "file"));
    // Reset destination panes
    form.querySelector('[data-dest-pane="new"]').classList.remove("hidden");
    form.querySelector('[data-dest-pane="existing"]').classList.add("hidden");
    openModal("#modal-import");
  }

  const importForm = $("#form-import");
  if (importForm) {
    const sourceHint = $("#import-source-hint");
    const hints = {
      file: T("app.js.import.hintFile"),
      "url-once": T("app.js.import.hintUrlOnce"),
      sub: T("app.js.import.hintSub"),
      paste: T("app.js.import.hintPaste"),
    };
    importForm.querySelectorAll('input[name="source"]').forEach((r) => r.addEventListener("change", () => {
      const v = importForm.querySelector('input[name="source"]:checked').value;
      importForm.querySelectorAll("[data-source-pane]").forEach((p) => p.classList.toggle("hidden", p.dataset.sourcePane !== v));
      if (sourceHint) sourceHint.textContent = hints[v] || "";
      resetImportPreview();
    }));

    importForm.querySelectorAll('input[name="destination"]').forEach((r) => r.addEventListener("change", () => {
      const v = importForm.querySelector('input[name="destination"]:checked').value;
      importForm.querySelector('[data-dest-pane="new"]').classList.toggle("hidden", v !== "new");
      importForm.querySelector('[data-dest-pane="existing"]').classList.toggle("hidden", v !== "existing");
      resetImportPreview();
    }));

    // 预览看的内容或目标只要动了，预览就作废（指纹对不上了，见提交处理里的 Step 2.5）。
    importForm.querySelector('[data-source-pane="file"] input[type="file"]')?.addEventListener("change", resetImportPreview);
    importForm.querySelector('[data-source-pane="paste"] textarea[name="text"]')?.addEventListener("input", resetImportPreview);
    importForm.querySelector('[data-dest-pane="existing"]')?.addEventListener("change", resetImportPreview);

    importForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const source = importForm.querySelector('input[name="source"]:checked').value;
      const destination = importForm.querySelector('input[name="destination"]:checked').value;
      const submitBtn = importForm.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      submitBtn.textContent = T("app.js.import.importing");
      try {
        // Step 1: 先把要发的内容备好、在本地能查的先查掉 —— 文件没选、URL 没填就别先建一个新日历。
        // **_csrf 排在 file 前面**：服务端拿到文件那一刻只解析过它前面的字段（verifyMultipartCsrf）。
        // previewKey 是这份内容的指纹，Step 2.5 拿它判「预览看的是不是这一份」。
        let path;
        let body;
        let previewKey = null;
        if (source === "file") {
          const fileInput = importForm.querySelector('[data-source-pane="file"] input[type="file"]');
          if (!fileInput.files || !fileInput.files[0]) throw new Error(T("app.js.import.selectFile"));
          const f = fileInput.files[0];
          previewKey = `file:${f.name}:${f.size}:${f.lastModified}`;
          body = new FormData();
          body.append("_csrf", ctx.csrfToken);
          body.append("file", f);
          path = "import/file";
        } else if (source === "url-once") {
          const url = importForm.querySelector('[data-source-pane="url-once"] input[name="url"]').value.trim();
          if (!url) throw new Error(T("app.js.import.enterUrl"));
          body = formBody({ url });
          path = "import/url-once";
        } else if (source === "sub") {
          const url = importForm.querySelector('[data-source-pane="sub"] input[name="url"]').value.trim();
          const label = importForm.querySelector('[data-source-pane="sub"] input[name="label"]').value.trim();
          const refreshMinutes = importForm.querySelector('[data-source-pane="sub"] select[name="refreshMinutes"]').value;
          if (!url) throw new Error(T("app.js.import.enterUrl"));
          body = formBody({ url, label, refreshMinutes });
          path = "subscriptions";
        } else {
          const text = importForm.querySelector('[data-source-pane="paste"] textarea[name="text"]').value;
          if (!text || text.length < 20) throw new Error(T("app.js.import.pasteIcs"));
          let h = 0;
          for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
          previewKey = `paste:${text.length}:${h}`;
          body = formBody({ text });
          path = "import/text";
        }

        // Step 2: resolve target calendarId
        let calendarId;
        if (destination === "existing") {
          const sel = importForm.querySelector('[data-dest-pane="existing"]');
          calendarId = sel.value;
          if (!calendarId) throw new Error(T("app.js.import.selectExisting"));
        } else if (importCreatedCalendarId) {
          // 上一次失败时已经建好了，接着往它里面导。
          calendarId = importCreatedCalendarId;
        } else {
          const name = importForm.querySelector('input[name="newName"]').value.trim() || T("app.js.import.defaultName");
          const color = importForm.querySelector('input[name="newColor"]').value || "#6366f1";
          // New calendar inherits the user's browser-detected (OS/IANA) zone
          // rather than a hardcoded Asia/Shanghai.
          let newCalTz = "Asia/Shanghai";
          try { newCalTz = Intl.DateTimeFormat().resolvedOptions().timeZone || newCalTz; } catch (_e) { /* keep fallback */ }
          const created = await fetch("/api/calendars", fetchOpts({
            method: "POST",
            body: JSON.stringify({ name, color, timezone: newCalTz }),
          }));
          if (!created.ok) throw new Error(T("app.js.import.createFailed"));
          const calRow = await created.json();
          calendarId = calRow.id;
          importCreatedCalendarId = calendarId;
        }

        // Step 2.5: 文件 / 粘贴先预览 —— 同一份内容、同一个目标日历只预览一次；
        // 预览过且指纹没变，再点就是真的导入。URL / 订阅一步到位不在这一版
        // （预览它们要先抓远程 / 先建订阅，口径完全不同，见服务端路由侧注释）。
        if ((source === "file" || source === "paste") &&
            (!importPreviewState || importPreviewState.key !== previewKey || importPreviewState.calendarId !== calendarId)) {
          submitBtn.textContent = T("app.js.import.previewing");
          const previewPath = source === "file" ? "import/preview/file" : "import/preview/text";
          const preview = await postImportPreview(`/app/calendars/${calendarId}/${previewPath}`, body);
          importPreviewState = { key: previewKey, calendarId };
          showImportPreview(preview);
          submitBtn.disabled = false;
          submitBtn.textContent = T("app.js.import.confirmSubmit");
          return;
        }

        // Step 3: send the import to that calendar —— 只有服务端回 ok: true 才往下走。
        const result = await postImport(`/app/calendars/${calendarId}/${path}`, body);
        if (result.partial) {
          // 订阅存下了、第一次拉取失败：照实说，但也要刷新（不能留在弹窗里让人再建一条）。
          window.bwc && window.bwc.toast(result.message, "error", { durationMs: 6000 });
          setTimeout(() => window.location.reload(), 2500);
          return;
        }
        window.bwc && window.bwc.toast(result.message || T("app.js.import.done"), "success");
        setTimeout(() => window.location.reload(), 1200);
      } catch (err) {
        console.error(err);
        const msg = err && err.userFacing ? err.message : T("app.js.import.failed", { error: (err && err.message) || err });
        window.bwc && window.bwc.toast(msg, "error", { durationMs: 6000 });
        submitBtn.disabled = false;
        // 预览已经看过的话按钮回到「确认导入」，没看过回到「导入」。
        submitBtn.textContent = importPreviewState ? T("app.js.import.confirmSubmit") : T("app.js.import.submit");
      }
    });
  }

  function formBody(data) {
    const fd = new URLSearchParams();
    fd.set("_csrf", ctx.csrfToken);
    Object.entries(data).forEach(([k, v]) => fd.set(k, v));
    return fd;
  }

  // 导入弹窗的四种来源都走这里。Accept: application/json 让服务端回 { ok, message } 而不是 302
  // （src/web/index.ts 的 wantsJson）；结果交给 readImportResponse 判 —— 只有 ok: true 才算成功。
  async function postImport(url, body) {
    const resp = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      body,
    });
    return globalThis.bwcImportResult.readImportResponse(resp, T);
  }

  // ---------- Calendar context menu ----------
  let currentMenuCalId = null;
  // Snapshot of the calendar's original values for dirty-tracking. We
  // only enable the Save button when something actually changed so users
  // get clear feedback that "this form does something" without the noise
  // of saving the same data back.
  let editCalOriginal = null;
  $$("[data-cal-menu]").forEach((btn) => btn.addEventListener("click", async (e) => {
    e.preventDefault(); e.stopPropagation();
    const id = btn.dataset.calMenu;
    const c = ctx.calendars.find((x) => x.id === id);
    if (!c) return;
    currentMenuCalId = id;
    $("#cal-menu-color").style.background = c.color;
    $("#cal-menu-name").textContent = c.name;
    populateEditCalendarForm(c);
    await loadShareTokens(id);
    openModal("#modal-cal-menu");
  }));

  // Hydrate the edit form from a calendar's current values. Re-builds the
  // color picker with the calendar's color pre-selected, sets the tz
  // picker's hidden input + label, and resets dirty state.
  function populateEditCalendarForm(c) {
    const form = $("#form-edit-calendar");
    if (!form) return;
    form.elements.name.value = c.name || "";
    form.elements.description.value = c.description || "";
    form.elements.color.value = c.color || "#6366f1";
    form.elements.timezone.value = c.timezone || "";
    // Rebuild the color swatch row so the matching swatch is checked.
    buildColorPicker(
      form.querySelector('[data-color-picker="form-edit-calendar"]'),
      "color",
      c.color || "#6366f1",
    );
    // Sync timezone picker label — `bwcSyncTzPicker` is exposed by the
    // timezone-picker init code; it reads the hidden input and updates
    // the visible "上海（UTC+8）"-style label.
    const tzPicker = form.querySelector("[data-tz-picker]");
    if (tzPicker && typeof window.bwcSyncTzPicker === "function") {
      window.bwcSyncTzPicker(tzPicker);
    }
    editCalOriginal = {
      name: form.elements.name.value,
      description: form.elements.description.value,
      color: form.elements.color.value,
      timezone: form.elements.timezone.value,
    };
    updateEditCalDirty();
  }

  // Diff form values against the snapshot taken when the modal opened.
  // Toggles the Save button's `disabled` attribute — empty name also
  // counts as not-saveable since the server requires it (`min(1)`).
  function updateEditCalDirty() {
    const form = $("#form-edit-calendar");
    if (!form || !editCalOriginal) return;
    const cur = {
      name: form.elements.name.value.trim(),
      description: form.elements.description.value,
      color: form.elements.color.value,
      timezone: form.elements.timezone.value,
    };
    const changed =
      cur.name !== (editCalOriginal.name || "").trim() ||
      cur.description !== (editCalOriginal.description || "") ||
      cur.color !== editCalOriginal.color ||
      cur.timezone !== editCalOriginal.timezone;
    $("#btn-save-calendar").disabled = !cur.name || !changed;
  }

  // Wire dirty-checking on every input + color swatch click + tz pick.
  // The color picker rewrites the hidden input value via change-event
  // dispatch, the tz picker writes the hidden input + dispatches input
  // — both flow through here without needing per-control listeners.
  $("#form-edit-calendar")?.addEventListener("input", updateEditCalDirty);
  $("#form-edit-calendar")?.addEventListener("change", updateEditCalDirty);

  $("#form-edit-calendar")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!currentMenuCalId) return;
    const form = e.target;
    // 只发送真正改过的字段（与 Android 编辑日历、服务端 PATCH 的口径
    // 一致：缺席 = 不改）。关键在 description：以前这里把空描述直接
    // 删掉不发，于是「清空描述」永远存不进去——服务端对 PATCH 里
    // 出现的 "" 是照单全收存为空的，缺席才是不动。timezone 例外：
    // 它没有「清空」的概念，空值仍旧不发。
    const orig = editCalOriginal || {};
    const body = {};
    const name = form.elements.name.value.trim();
    if (name !== (orig.name || "")) body.name = name;
    const description = form.elements.description.value;
    if (description !== (orig.description || "")) body.description = description;
    const color = form.elements.color.value;
    if (color !== (orig.color || "")) body.color = color;
    const timezone = form.elements.timezone.value;
    if (timezone && timezone !== (orig.timezone || "")) body.timezone = timezone;
    try {
      const resp = await fetch(`/api/calendars/${currentMenuCalId}`,
        fetchOpts({ method: "PATCH", body: JSON.stringify(body) }));
      if (!resp.ok) throw new Error(await resp.text());
      window.bwc && window.bwc.toast(T("app.js.toast.saved"), "success");
      // Reload so the calendar name in the sidebar, event colors, and
      // calendar pickers everywhere pick up the new values. Could be
      // surgical with ctx.calendars updates but reload is bulletproof.
      setTimeout(() => window.location.reload(), 400);
    } catch (err) {
      console.error(err);
      window.bwc && window.bwc.toast(T("app.js.toast.saveFailed"), "error");
    }
  });

  async function loadShareTokens(calId) {
    const list = $("#share-tokens-list");
    list.innerHTML = `<li class="text-slate-400 text-center py-2">${T("app.js.share.loading")}</li>`;
    try {
      const resp = await fetch(`/api/calendars/${calId}/share-tokens`, fetchOpts());
      const tokens = await resp.json();
      if (!tokens.length) {
        list.innerHTML = `<li class="text-slate-400 text-center py-2">${T("app.js.share.empty")}</li>`;
        return;
      }
      list.innerHTML = tokens.map((t) => {
        const webcalUrl = t.url.replace(/^https?:/i, "webcal:");
        const gcalUrl = `https://calendar.google.com/calendar/u/0/r?cid=${encodeURIComponent(t.url)}`;
        return `
        <li class="py-3 border-b border-slate-100 last:border-0 space-y-2">
          <div class="flex items-start gap-2">
            <div class="flex-1 min-w-0">
              <div class="text-slate-700 text-sm">${escapeHtml(t.label || T("app.js.share.unnamed"))}</div>
              <code class="text-xs text-slate-400 truncate block mt-0.5">${escapeHtml(t.url)}</code>
            </div>
            <button type="button" class="rounded-lg border border-red-200 bg-white px-2.5 py-1 text-xs text-red-700 hover:bg-red-50 flex-shrink-0" data-revoke="${escapeHtml(t.token)}">${T("app.js.share.revoke")}</button>
          </div>
          <div class="flex flex-wrap gap-1.5">
            <button type="button" class="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50" data-copy="${escapeHtml(t.url)}">${T("app.js.share.copyUrl")}</button>
            <a href="${escapeHtml(webcalUrl)}" class="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50">${T("app.js.share.addToPhone")}</a>
            <a href="${escapeHtml(gcalUrl)}" target="_blank" rel="noopener" class="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50">${T("app.js.share.addToGoogle")}</a>
          </div>
        </li>
      `;}).join("");
      list.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", () => window.bwc.copy(b.dataset.copy, T("app.js.copy.subscription"))));
      list.querySelectorAll("[data-revoke]").forEach((b) => b.addEventListener("click", async () => {
        if (!(await window.bwc.confirm({ message: T("app.js.share.revokeConfirm"), danger: true, confirmLabel: T("app.js.share.revoke") }))) return;
        await fetch(`/api/calendars/${calId}/share-tokens/${b.dataset.revoke}`, fetchOpts({ method: "DELETE" }));
        await loadShareTokens(calId);
        window.bwc && window.bwc.toast(T("app.js.share.revoked"), "success");
      }));
    } catch (err) {
      list.innerHTML = `<li class="text-red-500 text-center py-2">${T("app.js.share.loadFailed")}</li>`;
    }
  }

  $("#form-new-share-token").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!currentMenuCalId) return;
    const fd = new FormData(e.target);
    const label = fd.get("label") || undefined;
    try {
      const resp = await fetch(`/api/calendars/${currentMenuCalId}/share-tokens`,
        fetchOpts({ method: "POST", body: JSON.stringify({ label }) }));
      if (!resp.ok) throw new Error();
      e.target.reset();
      await loadShareTokens(currentMenuCalId);
      window.bwc && window.bwc.toast(T("app.js.share.generated"), "success");
    } catch (err) {
      window.bwc && window.bwc.toast(T("app.js.share.generateFailed"), "error");
    }
  });

  $("#btn-delete-calendar").addEventListener("click", async () => {
    if (!currentMenuCalId) return;
    if (!(await window.bwc.confirm({
      title: T("app.js.deleteCalendar.title"),
      message: T("app.js.deleteCalendar.message"),
      danger: true,
      confirmLabel: T("app.js.deleteCalendar.ok"),
    }))) return;
    try {
      const resp = await fetch(`/api/calendars/${currentMenuCalId}`, fetchOpts({ method: "DELETE" }));
      if (!resp.ok) throw new Error();
      closeModal("#modal-cal-menu");
      setTimeout(() => window.location.reload(), 400);
    } catch (err) {
      window.bwc && window.bwc.toast(T("app.js.toast.deleteFailed"), "error");
    }
  });

  cal.on("beforeUpdateEvent", async ({ event, changes }) => {
    try {
      // Snap drag/resize to 5-minute boundaries. Toast UI Calendar's grid
      // snaps to its hour-cell subdivisions (30 min default); we want finer
      // control without making the grid itself visually busier.
      if (changes.start && !event.isAllday) changes.start = roundTo5Min(changes.start);
      if (changes.end && !event.isAllday) changes.end = roundTo5Min(changes.end);
      // 全天事件存的是 UTC 午夜（表单提交也是这么写的），Toast UI 给的是本地午夜：
      // 直接 toISOString 的话，东半球拖一下刷新后落到前一天。
      const startsAt = !changes.start ? undefined
        : event.isAllday ? toLocalDateValue(new Date(changes.start)) + "T00:00:00.000Z"
        : new Date(changes.start).toISOString();
      const endsAt = !changes.end ? undefined
        : event.isAllday ? toLocalDateValue(new Date(changes.end)) + "T23:59:59.999Z"
        : new Date(changes.end).toISOString();
      const body = {};
      if (startsAt) body.startsAt = startsAt;
      if (endsAt) body.endsAt = endsAt;

      // Recurring events: dragging a single occurrence on the grid is
      // ambiguous — does the user mean "move this one instance" or
      // "shift the whole series"? Toast UI hands us the *occurrence*
      // event, but its raw .rrule is the master's rule. Ask first.
      // event.raw.rrule is populated by loadEvents from the API
      // response — see the rrule mapping below in /api/events.
      const isRecurring = !!(event.raw && event.raw.rrule);
      let recurringScope = null;
      if (isRecurring) {
        recurringScope = await promptRecurringScope("edit");
        if (!recurringScope) return; // user cancelled the drag
      }

      if (recurringScope === "instance" || recurringScope === "future") {
        // `event.start` here is the PRE-drag occurrence start — Toast UI
        // passes the original event to beforeUpdateEvent and applies
        // `changes` only after we call updateEvent (which we don't, in
        // the scoped path — we reload instead). That makes it the
        // RECURRENCE-ID the server needs to identify which instance.
        const recurrenceId = occurrenceRefIso(event.start, !!event.isAllday);
        const resp = await fetch(`/api/events/${event.id}`, fetchOpts({
          method: "PATCH",
          body: JSON.stringify({ ...body, scope: recurringScope, recurrenceId }),
        }));
        if (!resp.ok) throw new Error();
        // Server side returns either a detached event or new master —
        // simplest is to reload the whole grid so we pick up exdates +
        // new rows in one shot.
        await loadEvents();
        window.bwc && window.bwc.toast(
          recurringScope === "instance" ? T("app.js.toast.movedInstance") : T("app.js.toast.movedFuture"),
          "success",
        );
        return;
      }

      if (isRecurring) {
        // 拖动「所有事件」：同样按差值平移，每一次都变了，重新拉一遍。
        const resp = await fetch(`/api/events/${event.id}`, fetchOpts({
          method: "PATCH",
          body: JSON.stringify({ ...body, scope: "series", recurrenceId: occurrenceRefIso(event.start, !!event.isAllday) }),
        }));
        if (!resp.ok) throw new Error();
        await loadEvents();
        return;
      }

      const resp = await fetch(`/api/events/${event.id}`, fetchOpts({ method: "PATCH", body: JSON.stringify(body) }));
      if (!resp.ok) throw new Error();
      cal.updateEvent(event.id, event.calendarId, changes);
    } catch (err) {
      console.error(err);
      window.bwc && window.bwc.toast(T("app.js.toast.moveFailed"), "error");
    }
  });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  refresh();

  // Force a render after layout settles so the time-grid measures itself correctly.
  setTimeout(() => { try { cal.render(); } catch (e) {} }, 100);
  window.addEventListener("resize", () => {
    clearTimeout(window.__bwcResize);
    window.__bwcResize = setTimeout(() => { try { cal.render(); } catch (e) {} }, 150);
  });

  // ---------- Timezone picker (custom searchable combobox) ----------
  // Replaces the old <input list=tz-options> which let users free-type
  // garbage like "上海" — that "looked right" but isn't a valid IANA id
  // so the event broke silently on display + email + CalDAV.
  //
  // Now: hidden field always holds a known IANA id; the trigger button
  // shows the friendly label; clicking opens a modal with a search box
  // that filters by Chinese label / IANA id / UTC offset. Always
  // commits a value from the curated+IANA list.
  (function wireTzPicker() {
    const modal = $("#modal-tz");
    const search = $("#tz-search");
    const list = $("#tz-list");
    if (!modal || !search || !list) return;
    const zones = Array.isArray(window.bwcTimezones) ? window.bwcTimezones : [];
    if (zones.length === 0) return;

    // Track the picker element that opened the modal, so we know where
    // to write the result back. Only one modal can be open at a time.
    let activePicker = null;

    function labelFor(zoneId) {
      // Find the first matching curated entry; fall back to the IANA id.
      const z = zones.find((t) => t.id === zoneId);
      if (!z) return zoneId || "Asia/Shanghai";
      // Per-locale bracket style: CJK locales use fullwidth parens.
      return T("app.js.tz.labelFormat", { label: z.label, offset: z.offset });
    }

    function syncPickerLabel(picker) {
      const hidden = picker.querySelector('input[name="timezone"]');
      const label = picker.querySelector("[data-tz-label]");
      if (!hidden || !label) return;
      label.textContent = labelFor(hidden.value);
    }

    function renderList(filter) {
      const q = filter.trim().toLowerCase();
      const matches = q
        ? zones.filter((z) => {
            const hay = `${z.label} ${z.id} ${z.offset}`.toLowerCase();
            return hay.includes(q);
          })
        : zones;
      // Cap at 200 results so a blank search doesn't dump 420 DOM nodes.
      const capped = matches.slice(0, 200);
      list.innerHTML = capped.length === 0
        ? `<li class="py-6 text-center text-sm text-slate-400">${T("app.js.tz.noMatch")}</li>`
        : capped.map((z) =>
            `<li><button type="button" data-tz-pick="${z.id}" class="w-full flex items-center justify-between rounded-md px-3 py-2 text-left text-sm hover:bg-slate-50 active:bg-slate-100">
              <span class="text-slate-900">${escapeHtml(z.label)}</span>
              <span class="ml-3 text-xs text-slate-500 font-mono">${escapeHtml(z.id)} · ${escapeHtml(z.offset)}</span>
            </button></li>`,
          ).join("");
    }

    function openTzModal(picker) {
      activePicker = picker;
      openModal(modal);
      search.value = "";
      renderList("");
      // Focus the search field on desktop; on mobile we don't auto-focus
      // because pulling up the keyboard right when the bottom-sheet
      // animates in feels janky. Tap-to-focus works fine.
      if (!window.matchMedia("(max-width: 640px)").matches) {
        setTimeout(() => search.focus(), 30);
      }
      // Scroll the currently-selected item into view if it's in the list.
      const hidden = picker.querySelector('input[name="timezone"]');
      if (hidden && hidden.value) {
        const found = list.querySelector(`[data-tz-pick="${CSS.escape(hidden.value)}"]`);
        if (found) found.scrollIntoView({ block: "center" });
      }
    }

    function closeTzModal() {
      closeModal(modal);
      activePicker = null;
    }

    function commitPick(zoneId) {
      if (!activePicker) return;
      const hidden = activePicker.querySelector('input[name="timezone"]');
      if (hidden) hidden.value = zoneId;
      syncPickerLabel(activePicker);
      // Notify listeners (e.g. tz-hint in event modal) by firing 'change'
      // on the hidden input.
      if (hidden) hidden.dispatchEvent(new Event("change", { bubbles: true }));
      closeTzModal();
    }

    // Delegate clicks on triggers — works for pickers in modals that
    // weren't in the DOM at startup (event modal opens lazily).
    document.body.addEventListener("click", (e) => {
      const trigger = e.target.closest("[data-tz-trigger]");
      if (trigger) {
        const picker = trigger.closest("[data-tz-picker]");
        if (picker) { e.preventDefault(); openTzModal(picker); return; }
      }
    });

    // List clicks → pick
    list.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-tz-pick]");
      if (btn) commitPick(btn.dataset.tzPick);
    });

    // Close handlers: X button, backdrop click, Escape key.
    modal.querySelector("[data-tz-close]")?.addEventListener("click", closeTzModal);
    modal.addEventListener("click", (e) => { if (e.target === modal) closeTzModal(); });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !modal.classList.contains("hidden")) closeTzModal();
    });

    // Live filter as the user types
    search.addEventListener("input", () => renderList(search.value));

    // Initial label sync for every picker present at page load.
    document.querySelectorAll("[data-tz-picker]").forEach(syncPickerLabel);

    // Re-sync whenever some other code (event modal opening with an
    // existing event's timezone) writes to the hidden input directly.
    // We can't observe value= changes natively, so expose a helper.
    window.bwcSyncTzPicker = (picker) => syncPickerLabel(picker);
  })();

  // ---------- Sync status chip ----------
  // Hidden by default. Three states:
  //   amber  — offline (with pending count if any)
  //   sky    — online but outbox has items being retried
  //   red    — conflicts: items gave up after 5 retries; user must act
  // Click opens the conflict modal when red.
  (function wireSyncChip() {
    const chip = $("#sync-chip");
    const dot = $("#sync-chip-dot");
    const text = $("#sync-chip-text");
    if (!chip || !dot || !text || !window.bwcStore) return;

    async function refresh() {
      const online = window.bwcStore.isOnline();
      const pending = await window.bwcStore.pendingCount();
      const conflicts = await window.bwcStore.listConflicts();
      const conflictCount = conflicts.length;
      if (online && pending === 0 && conflictCount === 0) {
        chip.classList.add("hidden");
        return;
      }
      chip.classList.remove("hidden");
      // Tailwind utility chunks instead of inline color so Purge picks them up.
      chip.className = chip.className.replace(/bg-(?:amber|sky|emerald|red)-\S+|text-(?:amber|sky|emerald|red)-\S+|hover:bg-\S+/g, "").trim();
      // Conflict state wins over offline/in-progress because it requires
      // user action and offline alone resolves itself when network returns.
      if (conflictCount > 0) {
        chip.classList.add("bg-red-50", "text-red-700", "hover:bg-red-100", "cursor-pointer");
        dot.className = "inline-block h-1.5 w-1.5 rounded-full bg-red-500";
        text.textContent = T("app.js.sync.conflicts", { n: conflictCount });
        chip.title = T("app.js.sync.conflictsTitle");
      } else if (!online) {
        chip.classList.add("bg-amber-50", "text-amber-700");
        dot.className = "inline-block h-1.5 w-1.5 rounded-full bg-amber-500";
        text.textContent = pending > 0 ? T("app.js.sync.offlinePending", { n: pending }) : T("app.js.sync.offline");
        chip.title = T("app.js.sync.offlineTitle");
      } else if (pending > 0) {
        chip.classList.add("bg-sky-50", "text-sky-700");
        dot.className = "inline-block h-1.5 w-1.5 rounded-full bg-sky-500 animate-pulse";
        text.textContent = T("app.js.sync.syncing", { n: pending });
        chip.title = T("app.js.sync.syncingTitle");
      }
    }

    chip.addEventListener("click", async () => {
      const conflicts = await window.bwcStore.listConflicts();
      if (conflicts.length > 0) await openConflictsModal();
    });

    window.bwcStore.onChange((ev) => {
      refresh();
      // sync-conflict events also pop the modal — first-time alert so
      // user notices their edit got stuck instead of waiting until they
      // happen to glance at the chip.
      if (ev.kind === "sync-conflict") {
        if (window.bwc) window.bwc.toast(T("app.js.sync.conflictToast"), "error");
      }
      // 服务端拒绝：那条改动已经出队、本地那份也回滚了。这里必须做两件事，
      // 少一件用户就会以为改动还在 ——
      //   1. 把服务端的原话弹出来（是哪个字段不对，用户照着能改）
      //   2. 立刻重画日历，让那条只存在于本地的「改好了」当场消失
      // 队列里排在它后面的编辑不受影响，会照常继续发。
      // 保存发出去的同时 loadEvents 已经在拉了，那次结果可能早于这次保存。服务端接受之后再拉一遍，
      // 不然重复事件别的那几次要等下一轮轮询（最多 30 秒）才对得上。
      if (ev.kind === "outbox-synced") loadEvents().catch(() => {});
      if (ev.kind === "sync-rejected") {
        const reason = (ev.payload && ev.payload.reason) || "";
        if (window.bwc) {
          window.bwc.toast(T("app.js.sync.rejected", { reason: reason }), "error", { durationMs: 6000 });
        }
        loadEvents().catch(() => {});
      }
    });
    window.addEventListener("online", refresh);
    window.addEventListener("offline", refresh);
    refresh();
  })();

  // ---------- Conflict modal renderer ----------
  async function openConflictsModal() {
    await renderConflicts();
    openModal("#modal-conflicts");
  }
  async function renderConflicts() {
    const list = $("#conflicts-list");
    const empty = $("#conflicts-empty");
    if (!list || !empty) return;
    const items = await window.bwcStore.listConflicts();
    if (items.length === 0) {
      list.innerHTML = "";
      empty.classList.remove("hidden");
      return;
    }
    empty.classList.add("hidden");
    const opLabel = {
      create: T("app.js.conflictList.opCreate"),
      update: T("app.js.conflictList.opUpdate"),
      delete: T("app.js.conflictList.opDelete"),
    };
    list.innerHTML = items.map((it) => {
      const title = (it.payload && it.payload.summary) || T("app.js.untitled");
      const when = new Date(it.createdAt).toLocaleString(LOCALE, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
      const err = it.lastError ? `<div class="mt-1 text-xs text-red-700 break-all">${T("app.js.conflictList.lastError", { error: escapeHtml(it.lastError) })}</div>` : "";
      return `
        <li class="rounded-lg border border-red-200 bg-red-50/40 p-3" data-outbox-id="${it.id}">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2 mb-0.5">
                <span class="inline-block rounded-full bg-red-100 text-red-700 text-xs px-2 py-0.5">${opLabel[it.op] || it.op}</span>
                <span class="text-xs text-slate-500">${when}</span>
                <span class="text-xs text-slate-400">· ${T("app.js.conflictList.attempts", { n: it.attempts })}</span>
              </div>
              <div class="text-sm font-medium text-slate-800 break-words">${escapeHtml(title)}</div>
              ${err}
            </div>
            <div class="flex gap-1.5 flex-shrink-0">
              <button type="button" class="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50" data-conflict-retry="${it.id}">${T("app.js.conflictList.retry")}</button>
              <button type="button" class="rounded-md border border-red-200 bg-white px-2.5 py-1 text-xs text-red-700 hover:bg-red-50" data-conflict-discard="${it.id}">${T("app.js.conflictList.discard")}</button>
            </div>
          </div>
        </li>`;
    }).join("");
  }
  // Delegated click handler for retry / discard buttons inside the modal.
  document.addEventListener("click", async (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    const retryId = t.getAttribute("data-conflict-retry");
    const discardId = t.getAttribute("data-conflict-discard");
    if (retryId) {
      await window.bwcStore.retryItem(parseInt(retryId, 10));
      await renderConflicts();
      // Force a reload so the optimistic state syncs with whatever the
      // server returned.
      setTimeout(() => loadEvents().catch(() => {}), 1500);
    } else if (discardId) {
      if (!(await window.bwc.confirm({
        message: T("app.js.conflictList.discardConfirm"),
        danger: true,
        confirmLabel: T("app.js.conflictList.discard"),
      }))) return;
      await window.bwcStore.discardItem(parseInt(discardId, 10));
      await renderConflicts();
      await loadEvents().catch(() => {});
    }
  });
  const retryAllBtn = $("#btn-conflicts-retry-all");
  if (retryAllBtn) {
    retryAllBtn.addEventListener("click", async () => {
      const items = await window.bwcStore.listConflicts();
      for (const it of items) await window.bwcStore.retryItem(it.id);
      await renderConflicts();
      setTimeout(() => loadEvents().catch(() => {}), 1500);
    });
  }
})();
