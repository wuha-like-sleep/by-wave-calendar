// .ics 导入的大小上限。web/index.ts 的两条导入路由、八门语言的文案、
// test/ics_import_limit_copy.test.ts 都以这里为准。

/** 上传 .ics 文件的上限。以前这里写 5MB，而实际生效的是全局那 2MB。
 *
 *  **页面和报错里写的数字都从这里来**：报错文案用 {mb} 占位、由路由填进去；
 *  导入弹窗那句提示（app.js.import.hintFile）是前端直接显示的，八门语言里
 *  写的是字面量，test/ics_import_limit_copy.test.ts 盯着它和这个常量一致。 */
export const MAX_ICS_IMPORT_BYTES = 8 * 1024 * 1024;
export const MAX_ICS_IMPORT_MB = MAX_ICS_IMPORT_BYTES / (1024 * 1024);

/** 粘贴 .ics 文本的上限（字符数）。 */
export const MAX_ICS_PASTE_CHARS = 1_000_000;

/** 粘贴那条路自己的请求体上限。
 *
 *  以前它吃的是全局的 2MB bodyLimit，注释说「1,000,000 字符明显小于 2MB」——
 *  只对纯 ASCII 成立。表单是 urlencoded 提交的，一个汉字转义成 %E4%B8%AD
 *  是 9 个字节：一份标题和备注是中文的日历，五六十万字符就撞上 2MB，用户
 *  收到的是 Fastify 的英文 413，而不是「内容太长」。也就是说对中文用户，
 *  真正生效的上限是另一个、而且随内容变的数字。
 *
 *  这里按最坏情况放宽：每个 UTF-16 码元转义后最多 9 字节（BMP 字符 3 字节
 *  UTF-8 × 3；代理对是 4 字节 UTF-8 占两个码元，折合 6），再留 64KB 给
 *  _csrf 和字段名。这样 MAX_ICS_PASTE_CHARS 才是真正生效的那一个数。 */
export const MAX_ICS_PASTE_BODY_BYTES = MAX_ICS_PASTE_CHARS * 9 + 64 * 1024;

/** API 导入那条路（JSON { text }）自己的请求体上限。
 *
 *  和粘贴那条同一个道理：bodyLimit 只是传输层的护栏，真正生效的上限是
 *  路由里对解码后文本量的字节检查（MAX_ICS_IMPORT_BYTES，和网页文件
 *  上传同一个数）。JSON 里一个 BMP 字符最坏被转义成 \uXXXX 共 6 字节，
 *  而它在 UTF-8 里最多 3 字节，所以按字节上限的 2 倍放宽再留 64KB 给
 *  字段名和引号，处在上限边缘的合法文件不会先撞传输层。 */
export const MAX_ICS_IMPORT_JSON_BODY_BYTES = MAX_ICS_IMPORT_BYTES * 2 + 64 * 1024;
