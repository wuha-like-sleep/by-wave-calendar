// 结构门禁:**全 src/ 目录里,只有建号收口模块可以往 users 表插行。**
//
// 为什么要在源码层面禁:这次要修的洞本来的样子就是「五个入口各自 insert 一行,
// 其中只有一个看注册策略」。那四个口子不是一次开出来的,是一个一个长出来的,
// 每一次都编译通过、部署成功、线上静默失效 —— 外部 IdP 那条路在 45 天里开了
// 30 个号,而站点管理员并不认识这些人。人眼 review 拦不住这种事:新入口看起来
// 都很合理,只是它没过那道门。
//
// test/signup_gate_callsites.test.ts 已经盯着**当时那五个文件**。这一档盯的是
// 另一件事:**将来新加的第六个文件**。那才是复发的形状 —— 名单里没有它,名单
// 那档就永远是绿的。第六个入口也**天生没有 HTTP 集成覆盖**(集成断言是按当时
// 那五个入口一条条枚举写的),所以这道扫描门禁是它唯一的防线。
//
// ===================== 这道门自己坏过两次,都是静默绿 =====================
//
// 【一】剥行注释按「本行第一个 // 之后全扔」做,于是**字符串里的网址**会把这
//      一行的真代码一起吃掉:
//
//        const DOCS = "https://example.com/docs"; await db.insert(schema.users)…
//
//      剥完只剩 `const DOCS = "https:`,insert 那半行凭空消失。把网址换成
//      "docs" 立刻就红了 —— 也就是说,加不加一个网址决定这道门看不看得见你。
//      这不是假想:src/web/index.ts 里就有好几行 "https://…" 常量,以及
//      `raw.startsWith("//")`,它们今天正在被上一版的剥注释逻辑截断。
//
// 【二】表名一存进变量就扫不到:
//
//        const t = schema.users;
//        await db.insert(t).values(v);
//
//      drizzle 里这是很自然的写法(src/lib/backup.ts 就是这么遍历表的),而
//      按行匹配 `\.insert\(\s*(?:\w+\.)?users` 的正则对它一无所知。
//
// 两条的根子是同一个:**拿行正则当解析器**。所以这一版换成了一个小词法扫描器
// (仓库里的 typescript 7 只导出 version,没有 createSourceFile 这类 API 可用,
// 依赖又不许动,所以这份扫描器是自带的)。它按字符走一遍源码,认得注释、单双
// 引号字符串、模板字符串(含 ${} 回到代码态)、正则字面量,于是:
//   - 注释里写什么都不算(不需要「剥注释」这一步了,注释根本不会进代码流);
//   - 字符串里的 // 不再是注释的开头;
//   - 正则里的 /\/\/.*$/ 不再被当成注释的开头。
//
// 然后在「干净的代码」上做一件行正则做不到的事:**把 insert 的第一个实参解析到
// 一个表名**,顺着同文件里的 import 绑定和 const 初始化器走。解析不出来的一律
// 按「可疑」记账(fail-closed),不是按「安全」放过 —— 这是这道门和上一版最重要
// 的区别:上一版的默认答案是绿,这一版的默认答案是红。
//
// ===================== 这道门自己的活体检验 =====================
// 「自己判空就永远绿」是本仓库 check-*.ts 踩过七次的坑:重构一来,扫描器一个
// 都匹配不到,「别处没有 insert」这句话依然成立(空集合等于空集合),门全绿而
// 洞开着。所以下面成对地写:
//   1. absence:收口模块和白名单以外,一处都不许有。
//   2. presence:收口模块里**必须**有,而且恰好一处。扫描器死了,这条先红。
//   3. FIXTURES:扫描器的每一条分支各喂一个样本,正反都钉住 —— 真实代码里今天
//      没有裸表名、没有裸 SQL 的样本,不单独喂的话它们写错了也没人知道。
//   4. 词法器自检:注释/字符串/模板/正则各一条,并且钉住「输出与原文等长」。

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

// 收口模块。**全仓库唯一允许「明写 users」的 src 文件。**
const PROVISIONING_MODULE = "src/lib/account_provisioning.ts";

const SRC_ROOT = "src";

// ---------------------------------------------------------------------------
// 词法扫描器
// ---------------------------------------------------------------------------

type Lexed = {
  /** 与原文**等长**的代码流:注释和字符串**内容**换成空格,分隔符保留。
   *  等长是刻意的 —— 匹配到的下标要能直接换算成原文行号,红的时候得报行号。 */
  code: string;
  /** 所有字符串 / 模板字面量的内容片段(模板被 ${} 切成多段)。裸 SQL 走这里。 */
  literals: { start: number; text: string }[];
};

/** 这些关键字后面的 `/` 是正则的开头,不是除号。少了这张表,
 *  `return /a\/b/.test(s)` 会被当成除法,后面那个 `\/` 又被当成注释。 */
const REGEX_OK_AFTER_WORD = new Set([
  "return", "typeof", "instanceof", "in", "of", "case", "new", "delete",
  "void", "do", "else", "yield", "await", "throw",
]);

function lexSource(src: string): Lexed {
  const n = src.length;
  const out = src.split("");
  const literals: { start: number; text: string }[] = [];
  // 换成空格而不是删掉:保持长度和行数,行号才算得准。换行本身要留着。
  const blank = (a: number, b: number): void => {
    for (let i = Math.max(0, a); i < Math.min(b, n); i++) if (out[i] !== "\n") out[i] = " ";
  };
  const keep = (a: number, b: number): void => {
    if (b > a) literals.push({ start: a, text: src.slice(a, b) });
    blank(a, b);
  };

  let i = 0;
  let mode: "code" | "template" = "code";
  let chunkStart = 0;
  // 模板字符串的 ${} 会回到代码态。栈里记「回到模板态时的花括号深度」,
  // 这样 `${ {a:1} }` 里那个 } 不会被误判成模板恢复点。
  const tmplStack: number[] = [];
  let depth = 0;
  let prevSig = "";   // 上一个非空白代码字符
  let prevWord = "";  // 上一个标识符(为了上面那张关键字表)

  const regexAllowed = (): boolean => {
    if (prevWord) return REGEX_OK_AFTER_WORD.has(prevWord);
    if (!prevSig) return true;
    // 值的后面只能是除号;运算符、逗号、左括号后面才可能是正则。
    return !/[A-Za-z0-9_$)\]}"'`]/.test(prevSig);
  };

  while (i < n) {
    if (mode === "template") {
      const ch = src[i]!;
      if (ch === "\\") { i += 2; continue; }
      if (ch === "`") { keep(chunkStart, i); mode = "code"; prevSig = "`"; prevWord = ""; i++; continue; }
      if (ch === "$" && src[i + 1] === "{") {
        keep(chunkStart, i);
        tmplStack.push(depth);
        mode = "code"; prevSig = ""; prevWord = "";
        i += 2; continue;
      }
      i++; continue;
    }

    const c = src[i]!;

    if (c === "/" && src[i + 1] === "/") {
      let j = i; while (j < n && src[j] !== "\n") j++;
      blank(i, j); i = j; prevWord = ""; continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2);
      const j = e < 0 ? n : e + 2;
      blank(i, j); i = j; prevWord = ""; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      for (; j < n; j++) {
        const ch = src[j]!;
        if (ch === "\\") { j++; continue; }
        if (ch === c || ch === "\n") break;
      }
      keep(i + 1, j);
      i = src[j] === c ? j + 1 : j;
      prevSig = c; prevWord = ""; continue;
    }
    if (c === "`") { chunkStart = i + 1; mode = "template"; i++; continue; }
    if (c === "/" && regexAllowed()) {
      let j = i + 1; let inClass = false; let closed = false;
      for (; j < n; j++) {
        const ch = src[j]!;
        if (ch === "\\") { j++; continue; }
        if (ch === "\n") break;
        if (inClass) { if (ch === "]") inClass = false; continue; }
        if (ch === "[") { inClass = true; continue; }
        if (ch === "/") { closed = true; break; }
      }
      if (closed) {
        blank(i + 1, j);
        j++;
        while (j < n && /[a-z]/.test(src[j]!)) j++; // 标志位 gimsuy
        i = j; prevSig = ")"; prevWord = ""; continue;
      }
      // 本行没闭合 → 它是除号,退回去按普通字符走
      prevSig = "/"; prevWord = ""; i++; continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i; while (j < n && /[\w$]/.test(src[j]!)) j++;
      prevWord = src.slice(i, j); prevSig = src[j - 1]!;
      i = j; continue;
    }
    if (c === "{") { depth++; }
    else if (c === "}") {
      if (tmplStack.length > 0 && tmplStack[tmplStack.length - 1] === depth) {
        tmplStack.pop();
        chunkStart = i + 1; mode = "template"; i++; continue;
      }
      depth--;
    }
    if (!/\s/.test(c)) { prevSig = c; prevWord = ""; }
    i++;
  }
  if (mode === "template") keep(chunkStart, n); // 未闭合的模板,别把后面当代码
  return { code: out.join(""), literals };
}

// ---------------------------------------------------------------------------
// 把 insert 的实参解析成表名
// ---------------------------------------------------------------------------

export type InsertFinding = {
  line: number;
  /** drizzle=明写 users;drizzle-unresolved=表名算不出来;raw-sql*=裸 SQL */
  kind: "drizzle" | "drizzle-unresolved" | "raw-sql" | "raw-sql-unresolved";
  /** 解析出来的表名,或解析不出时的原始表达式 */
  target: string;
};

/** 同文件里所有 import 进来的绑定名。`schema.users` 之所以算「解析得出」,
 *  就是因为 schema 是个 import 绑定 —— 而 backup.ts 里的 `t.table`,t 是
 *  循环变量,不在这张表里,于是算不出来。 */
function importBindings(code: string): Set<string> {
  const names = new Set<string>();
  const re = /\bimport\s+(?:type\s+)?([\s\S]*?)\s+from\s*["'`]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const clause = m[1]!;
    const ns = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause);
    if (ns) names.add(ns[1]!);
    const braced = /\{([\s\S]*?)\}/.exec(clause);
    if (braced) {
      for (const part of braced[1]!.split(",")) {
        const p = part.trim().replace(/^type\s+/, "");
        if (!p) continue;
        const as = /\s+as\s+([A-Za-z_$][\w$]*)$/.exec(p);
        names.add(as ? as[1]! : (/^[A-Za-z_$][\w$]*/.exec(p)?.[0] ?? ""));
      }
    }
    const dflt = /^\s*([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause.replace(/\{[\s\S]*?\}/g, ""));
    if (dflt) names.add(dflt[1]!);
  }
  names.delete("");
  return names;
}

/** `const x = <这里>` 的初始化器文本。取到顶层的 ; 或 , 为止。 */
function constInit(code: string, name: string): string | null {
  const m = new RegExp(`\\b(?:const|let|var)\\s+${name}\\b\\s*(?::[^=;]*)?=`).exec(code);
  if (!m) return null;
  let i = m.index + m[0].length;
  const start = i;
  let d = 0;
  for (; i < code.length; i++) {
    const c = code[i]!;
    if (c === "(" || c === "[" || c === "{") d++;
    else if (c === ")" || c === "]" || c === "}") { if (d === 0) break; d--; }
    else if ((c === ";" || c === ",") && d === 0) break;
  }
  return code.slice(start, i).trim();
}

/** 剥掉不改变「指向哪张表」的外壳:整体括号、`as any` / `as unknown` 之类、尾部 !。
 *  backup.ts 那处写的就是 `t.table as any`,不剥的话连「是个属性访问」都看不出来。 */
function normalize(expr: string): string {
  let e = expr.trim();
  for (;;) {
    const before = e;
    e = e.replace(/\s+/g, " ").trim();
    if (/^\(.*\)$/.test(e)) {
      let d = 0; let whole = true;
      for (let i = 0; i < e.length; i++) {
        if (e[i] === "(") d++;
        else if (e[i] === ")") { d--; if (d === 0 && i < e.length - 1) { whole = false; break; } }
      }
      if (whole) e = e.slice(1, -1).trim();
    }
    e = e.replace(/\s+as\s+(?:unknown|any|const|[A-Za-z_$][\w$.]*(?:<[^<>]*>)?(?:\[\])?)$/, "").trim();
    e = e.replace(/!+$/, "").trim();
    if (e === before) break;
  }
  return e;
}

/**
 * 表达式 → 表名。**算不出来就算不出来,不编一个答案。**
 *
 * 这里是整道门的立场所在:上一版的默认答案是「不是 users,放过」,所以
 * `db.insert(t)` 静默变绿;这一版的默认答案是「不知道,记一笔」,由调用方
 * 当成可疑处理。新写法只会让门更红,不会让门更绿。
 */
function resolveTarget(
  expr: string, code: string, imports: Set<string>, seen = new Set<string>(),
): { name: string | null; resolved: boolean } {
  const e = normalize(expr);
  if (!e) return { name: null, resolved: false };

  const bare = /^([A-Za-z_$][\w$]*)$/.exec(e);
  if (bare) {
    const id = bare[1]!;
    // import { users } from "../db/schema.js" → db.insert(users)
    if (imports.has(id)) return { name: id, resolved: true };
    if (seen.has(id)) return { name: null, resolved: false };
    seen.add(id);
    // const t = schema.users → db.insert(t)
    const init = constInit(code, id);
    if (init) return resolveTarget(init, code, imports, seen);
    // 形参、循环变量、解构出来的东西 → 算不出来
    return { name: null, resolved: false };
  }

  const dotted = /^([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)$/.exec(e);
  if (dotted) {
    const obj = dotted[1]!; const prop = dotted[2]!;
    if (imports.has(obj)) return { name: prop, resolved: true }; // schema.users
    if (!seen.has(obj)) {
      seen.add(obj);
      const init = constInit(code, obj);
      if (init) {
        const r = resolveTarget(init, code, imports, seen);
        if (r.resolved) return { name: prop, resolved: true };
      }
    }
    return { name: null, resolved: false }; // backup.ts 的 t.table 落在这儿
  }

  return { name: null, resolved: false };
}

const SQL_USERS = /\binsert\s+into\s+(?:"?public"?\s*\.\s*)?"?users"?\b/i;
/** `sql\`insert into ${tbl} …\`` —— 表名被插值切走了,同样算「算不出来」。 */
const SQL_DANGLING = /\binsert\s+into\s*$/i;

function lineOf(src: string, idx: number): number {
  let l = 1;
  for (let i = 0; i < idx && i < src.length; i++) if (src[i] === "\n") l++;
  return l;
}

/** 一个文件里所有「可能往 users 插行」的地方。空数组 = 干净。 */
export function scanUserInserts(src: string): InsertFinding[] {
  const { code, literals } = lexSource(src);
  const imports = importBindings(code);
  const findings: InsertFinding[] = [];

  const re = /\.\s*insert\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const open = m.index + m[0].length - 1;
    let d = 0; let end = code.length;
    for (let i = open; i < code.length; i++) {
      const c = code[i]!;
      if (c === "(") d++;
      else if (c === ")") { d--; if (d === 0) { end = i; break; } }
    }
    const inner = code.slice(open + 1, end);
    // 只要第一个实参(drizzle 的 insert 只收一个,多写的先截掉再判)
    let ad = 0; let cut = inner.length;
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i]!;
      if (c === "(" || c === "[" || c === "{") ad++;
      else if (c === ")" || c === "]" || c === "}") ad--;
      else if (c === "," && ad === 0) { cut = i; break; }
    }
    const arg = inner.slice(0, cut);
    const r = resolveTarget(arg, code, imports);
    const line = lineOf(src, m.index);
    if (!r.resolved) findings.push({ line, kind: "drizzle-unresolved", target: normalize(arg) || "<空>" });
    else if (r.name === "users") findings.push({ line, kind: "drizzle", target: "users" });
  }

  for (const lit of literals) {
    if (SQL_USERS.test(lit.text)) {
      findings.push({ line: lineOf(src, lit.start), kind: "raw-sql", target: "users" });
    } else if (SQL_DANGLING.test(lit.text)) {
      findings.push({ line: lineOf(src, lit.start), kind: "raw-sql-unresolved", target: "<插值表名>" });
    }
  }
  return findings.sort((a, b) => a.line - b.line);
}

// ---------------------------------------------------------------------------
// 白名单:src/lib/backup.ts
// ---------------------------------------------------------------------------
//
// 上一版的产出把这处记成「盲区,但正当」。重新判一次:它**不是**正当地通过了
// 门禁,而是**根本没被看见** —— 上一版的正则要求 insert( 后面紧跟 users 这个
// 词,而这里写的是 `tx.insert(t.table as any)`,t 是 EXPORT_TABLES 的循环变量。
// 也就是说,当时「它是正当的」这个判断是事后追认,不是门禁做出的判断。
//
// 现在换成 fail-closed 之后它会被看见。判定结果:**放行,但钉死形状**。
//   - 它做的事是「整库还原」:先 TRUNCATE 全部表,再把备份包里的行灌回去。
//     还原的是**本来就存在过的账号**,不是新开号,注册策略(关站 / 邀请制 /
//     域名白名单 / 每日配额)对它没有意义 —— 这些闸门管的是「谁能新开一个号」。
//   - 触发它需要管理员身份并上传一个自己导出的备份包;能做这件事的人本来就能
//     在后台直接建号。
// 所以放行。但下面的断言把它钉在**恰好一处、且形状不变**上:backup.ts 里再多
// 一处 insert、或者有人在里面明写 schema.users,都会红。白名单不等于免检。
const ALLOWLIST: { file: string; kind: InsertFinding["kind"]; target: string; why: string }[] = [
  {
    file: "src/lib/backup.ts",
    kind: "drizzle-unresolved",
    target: "t.table",
    why: "整库还原按 EXPORT_TABLES 逐表灌回,还原的是已存在过的账号,不是新开号",
  },
];

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** src/ 下所有 .ts 文件的仓库相对路径(POSIX 分隔符,和上面的常量对得上)。 */
function allSrcTsFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      // 只看 .ts。
      //
      // 刻意**不**排除 iCloud 弄出来的「* 2.ts」重名残留(工作区里现在就有
      // src/lib/ical 2.ts 这种)。它们确实在 tsconfig 的 include 里、确实会被
      // tsc 编译、确实可以被 import —— 哪天 iCloud 给收口模块也复制一份出来,
      // 那就是实打实的第二个能建号的文件,应该在这里红,不该被过滤掉。
      if (name.endsWith(".ts")) out.push(full.split(path.sep).join("/"));
    }
  };
  walk(SRC_ROOT);
  return out;
}

function read(rel: string): string {
  return readFileSync(path.resolve(rel), "utf8");
}

function describeFindings(file: string, fs: InsertFinding[]): string {
  return fs.map((f) => `${file}:${f.line} [${f.kind}] ${f.target}`).join("\n");
}

/**
 * 某一行落在哪个方法 / 函数体里。
 *
 * 收口模块里「有几处 insert」这个数字是会变的(比如给每日配额加一条带行锁的
 * 事务路径,就会多出一处),但**它们分别长在哪个方法里**不该悄悄变。所以下面
 * 的断言盯的是方法名的集合,不是个数 —— 个数写死会在别人正当地加一条 store
 * 方法时红掉,方法名写死则是「多出一个没人认识的建号入口」才红。
 */
function enclosingMethodAt(src: string, line: number): string {
  const lines = src.split("\n");
  const re = /^[ \t]*(?:export\s+)?(?:public\s+|private\s+|protected\s+)?(?:static\s+)?(?:async\s+)?(?:function\s+)?([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*(?::[^{;=]*)?\{\s*$/;
  for (let i = Math.min(line, lines.length) - 1; i >= 0; i--) {
    const m = re.exec(lines[i]!);
    if (m) return m[1]!;
  }
  return "<顶层>";
}

// ---------------------------------------------------------------------------
// 0. 词法器自检
// ---------------------------------------------------------------------------

describe("词法扫描器", () => {
  it("输出与原文等长（行号才算得准）", () => {
    const src = `const a = "x"; // c\n/* b */ const q = \`t${"${a}"}\`;\nconst r = /a\\/b/;`;
    expect(lexSource(src).code.length).toBe(src.length);
  });

  it("行注释整段消失", () => {
    expect(lexSource(`// db.insert(schema.users)\nconst a = 1;`).code).not.toContain("insert");
  });

  it("块注释整段消失", () => {
    expect(lexSource(`/* db.insert(schema.users) */\nconst a = 1;`).code).not.toContain("insert");
  });

  it("字符串里的 // 不是注释的开头 —— 同一行后面的代码必须留下", () => {
    // 这一条就是【一】那个洞的最小复现。上一版在这里会把 insert 整段吃掉。
    const src = `const DOCS = "https://example.com/docs"; await db.insert(schema.users).values(v);`;
    expect(lexSource(src).code).toContain("insert");
    expect(lexSource(src).code).toContain("schema.users");
  });

  it("正则里的 // 不是注释的开头", () => {
    const src = `const s = x.replace(/\\/\\/.*$/, ""); await db.insert(schema.users).values(v);`;
    expect(lexSource(src).code).toContain("schema.users");
  });

  it("除号不会被当成正则的开头", () => {
    const src = `const r = a / b; const z = c / d; await db.insert(schema.users).values(v);`;
    expect(lexSource(src).code).toContain("schema.users");
  });

  it("模板字符串的 ${} 回到代码态（嵌套也要认）", () => {
    const src = "const q = `a${`b${c}d`}e`; await db.insert(schema.users).values(v);";
    expect(lexSource(src).code).toContain("schema.users");
    expect(lexSource(src).literals.map((l) => l.text).sort()).toEqual(["a", "b", "d", "e"]);
  });

  it("字符串内容进 literals（裸 SQL 靠它)", () => {
    const lits = lexSource("await db.execute(sql`insert into users (email) values (1)`);").literals;
    expect(lits.some((l) => /insert into users/i.test(l.text))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 1. 扫描器本身:每个分支各自钉住
// ---------------------------------------------------------------------------

describe("建号门禁的扫描器", () => {
  // 每个样本都自带 import,因为「schema 是不是 import 绑定」正是解析的依据。
  const IMP = `import { db, schema } from "../db/client.js";\n`;
  const IMP_BARE = `import { db } from "../db/client.js";\nimport { users, calendars } from "../db/schema.js";\n`;

  const POSITIVE: [string, string][] = [
    ["带命名空间", `${IMP}const [u] = await db.insert(schema.users).values(v).returning();`],
    ["裸表名", `${IMP_BARE}await db.insert(users).values(v);`],
    ["换行写法", `${IMP}await db\n  .insert(schema.users)\n  .values(v);`],
    ["空格写法", `${IMP}await db . insert ( schema . users ).values(v);`],
    ["事务里", `${IMP}await tx.insert(schema.users).values(v);`],
    ["裸 SQL 小写", `${IMP}await db.execute(sql\`insert into users (email) values ('x')\`);`],
    ["裸 SQL 大写带引号", `${IMP}await db.execute(sql\`INSERT INTO "users" (email) VALUES ('x')\`);`],
    ["裸 SQL 带 schema 前缀", `${IMP}await db.execute(sql\`INSERT INTO public.users (email) VALUES ('x')\`);`],
    // ↓ 复核挖出来的两个洞,各自钉一条
    ["同一行里有网址（洞【一】）", `${IMP}const DOCS = "https://example.com/docs"; await db.insert(schema.users).values(v);`],
    ["表名存进 const（洞【二】）", `${IMP}const t = schema.users;\nawait db.insert(t).values(v);`],
    ["表名存进 const 再转一手", `${IMP}const t = schema.users;\nconst t2 = t;\nawait db.insert(t2).values(v);`],
    ["表名是循环变量（算不出来 → 记账）", `${IMP}for (const t of TABLES) await db.insert(t.table as any).values(rows);`],
    ["表名是形参（算不出来 → 记账）", `${IMP}function f(tbl: any) { return db.insert(tbl).values(v); }`],
    ["表名靠插值拼（算不出来 → 记账）", `${IMP}await db.execute(sql\`insert into \${tbl} (email) values ('x')\`);`],
  ];

  const NEGATIVE: [string, string][] = [
    ["别的表", `${IMP}await db.insert(schema.userIdentities).values(v);`],
    ["名字以 user 开头的表", `${IMP}await db.insert(schema.userSettings).values(v);`],
    ["裸的别的表名", `${IMP_BARE}await db.insert(calendars).values(v);`],
    ["只是查询", `${IMP}await db.select().from(schema.users).where(eq(schema.users.id, id));`],
    ["只是更新", `${IMP}await db.update(schema.users).set({ emailVerified: true });`],
    ["行注释里提到", `${IMP}// 以前这里是 db.insert(schema.users).values(...)`],
    ["块注释里提到", `${IMP}/* 历史写法:db.insert(schema.users) */`],
    ["字符串里提到（是文案不是代码）", `${IMP}const hint = "别再 db.insert(schema.users) 了";`],
    ["注释里有网址也不该被当成代码", `${IMP}// 文档 https://example.com/docs db.insert(schema.users)`],
  ];

  for (const [label, sample] of POSITIVE) {
    it(`认得出：${label}`, () => {
      expect(scanUserInserts(sample).length, sample).toBeGreaterThan(0);
    });
  }
  for (const [label, sample] of NEGATIVE) {
    it(`不误报：${label}`, () => {
      expect(scanUserInserts(sample), sample).toEqual([]);
    });
  }

  it("网址和非网址两种写法**结果一样**（洞【一】的判据）", () => {
    // 上一版这两个的结果是 0 和 1。它们必须相等,否则「加个网址就隐身」又回来了。
    const withUrl = `${IMP}const DOCS = "https://example.com/docs"; await db.insert(schema.users).values(v);`;
    const without = `${IMP}const DOCS = "docs"; await db.insert(schema.users).values(v);`;
    expect(scanUserInserts(withUrl).length).toBe(scanUserInserts(without).length);
    expect(scanUserInserts(withUrl).length).toBe(1);
  });

  it("表名直写和存变量两种写法**结果一样**（洞【二】的判据）", () => {
    const direct = `${IMP}await db.insert(schema.users).values(v);`;
    const viaVar = `${IMP}const t = schema.users;\nawait db.insert(t).values(v);`;
    expect(scanUserInserts(viaVar).length).toBe(scanUserInserts(direct).length);
  });

  it("算不出表名时按「可疑」记账，不是按「安全」放过", () => {
    const fs = scanUserInserts(`import { db } from "../db/client.js";\nawait db.insert(whoKnows).values(v);`);
    expect(fs.length).toBe(1);
    expect(fs[0]!.kind).toBe("drizzle-unresolved");
  });
});

// ---------------------------------------------------------------------------
// 2. 自检:扫描范围真的不是空的
// ---------------------------------------------------------------------------

describe("建号门禁的扫描范围", () => {
  const files = allSrcTsFiles();

  it("src/ 下确实扫到了一大票 .ts 文件", () => {
    // 具体数字会随开发变,只钉一个下限:目录名写错、walk 写坏、后缀过滤写反,
    // 都会让这个数塌到个位数。
    expect(files.length).toBeGreaterThan(80);
  });

  it("收口模块在扫描范围里", () => {
    // 没有这条,常量名写错一个字母 → 收口模块被当成「别处」→ absence 那条红,
    // 人会以为是代码坏了;更糟的是路径一改,presence 那条读不到文件直接抛。
    expect(files).toContain(PROVISIONING_MODULE);
  });

  it("白名单里的文件都还在（路径写错就等于白名单静默扩大）", () => {
    for (const a of ALLOWLIST) expect(files, a.file).toContain(a.file);
  });
});

// ---------------------------------------------------------------------------
// 3. presence:收口模块里必须有,而且恰好一处
// ---------------------------------------------------------------------------

describe("建号门禁：收口模块", () => {
  it("收口模块里确实有 users 插入（扫描器没死）", () => {
    // 这条是 absence 那组的活体检验。重构把写法换成扫描器认不出来的形状时,
    // absence 会因为「什么都没匹配到」而保持绿色 —— 只有这一条会红。
    const fs = scanUserInserts(read(PROVISIONING_MODULE));
    expect(fs.length, describeFindings(PROVISIONING_MODULE, fs)).toBeGreaterThan(0);
  });

  it("每一处都是明写的 schema.users，没有算不出表名的形状", () => {
    // 收口模块里也不许出现「表名存进变量」那种形状:那会让这道门在自己家门口
    // 先瞎一次,而这里恰恰是唯一允许插 users 的地方,写法必须是最直白的。
    const fs = scanUserInserts(read(PROVISIONING_MODULE));
    for (const f of fs) {
      expect(f.kind, describeFindings(PROVISIONING_MODULE, fs)).toBe("drizzle");
      expect(f.target, describeFindings(PROVISIONING_MODULE, fs)).toBe("users");
    }
  });

  it("每一处都长在认识的 store 方法里 —— 建号不许有第二条路径", () => {
    // 盯方法名而不是个数,原因见 enclosingMethodAt 的说明。
    //
    //   insertUser            —— 普通建号
    //   insertUserWithinQuota —— 每日配额打开时那条带行锁的事务路径
    //
    // 两条都是 ProvisioningStore 的实现,都只能由 provisionAccount() 调到,
    // 闸门在它们上游统一判。**多出第三个名字**才是要红的那件事:那说明有人
    // 在收口函数旁边又开了一条捷径(比如「管理员建号走这条,不过闸门」)。
    const KNOWN_PATHS = ["insertUser", "insertUserWithinQuota"];
    const src = read(PROVISIONING_MODULE);
    const fs = scanUserInserts(src);
    const where = fs.map((f) => enclosingMethodAt(src, f.line));
    // 先钉住「确实认出了方法名」:enclosingMethodAt 写坏成永远返回 <顶层> 时,
    // 下面那条 subset 断言会一起坏掉,所以这条要在前面。
    expect(where, describeFindings(PROVISIONING_MODULE, fs)).not.toContain("<顶层>");
    for (const name of where) {
      expect(KNOWN_PATHS, `${name} 不是已知的建号路径`).toContain(name);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. 白名单:形状必须一模一样
// ---------------------------------------------------------------------------

describe("建号门禁：白名单", () => {
  it("白名单只有备份还原这一处", () => {
    // 白名单长出第二条就要有人重新想一遍。别让它悄悄变长。
    expect(ALLOWLIST.map((a) => a.file)).toEqual(["src/lib/backup.ts"]);
  });

  for (const a of ALLOWLIST) {
    it(`${a.file}：扫描器仍然看得见它，且恰好一处（${a.why}）`, () => {
      // 这条是白名单自己的活体检验:哪天扫描器又看不见它了,这里先红,
      // 而不是让「白名单」变成「反正也扫不到」。
      const fs = scanUserInserts(read(a.file));
      expect(fs.length, describeFindings(a.file, fs)).toBe(1);
      expect(fs[0]!.kind).toBe(a.kind);
      expect(fs[0]!.target).toBe(a.target);
    });
  }
});

// ---------------------------------------------------------------------------
// 5. absence:别处一个都不许有
// ---------------------------------------------------------------------------

describe("建号门禁：src/ 其余文件", () => {
  it("收口模块和白名单以外，没有任何文件往 users 表插行（算不出表名的也算）", () => {
    const allow = new Set([PROVISIONING_MODULE, ...ALLOWLIST.map((a) => a.file)]);
    const offenders: string[] = [];
    for (const f of allSrcTsFiles()) {
      if (allow.has(f)) continue;
      const fs = scanUserInserts(read(f));
      if (fs.length > 0) offenders.push(describeFindings(f, fs));
    }
    // 报路径和行号而不是 toBe(0):红的时候要一眼看见是谁,不然得自己 grep 一遍。
    expect(offenders).toEqual([]);
  });
});
