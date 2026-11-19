// 通知页的时间分组：按浏览器本地日界给列表插「今天 / 昨天 / 更早」小标题。
//
// 为什么不在服务端分组：服务端不知道观看者的时区（全站的时间显示都是
// 服务端给 ISO、浏览器用 local-time.js 按本地时区重渲染）。分组若在服务端
// 按某个固定时区切，半夜前后的消息就会被分错组。这里只做插标题这一件
// 小事：列表本身服务端已渲染好，脚本缺席/失败时列表照常可读。
(function () {
  "use strict";

  var list = document.getElementById("notif-list");
  if (!list) return;

  var labels = { today: "Today", yesterday: "Yesterday", earlier: "Earlier" };
  try {
    var blob = document.getElementById("bwc-notif-i18n");
    if (blob) {
      var parsed = JSON.parse(blob.textContent || "{}");
      if (parsed && typeof parsed === "object") labels = Object.assign(labels, parsed);
    }
  } catch (_e) { /* 标签拿不到就用英文兜底，分组照常 */ }

  function startOfDay(d) {
    var x = new Date(d.getTime());
    x.setHours(0, 0, 0, 0);
    return x.getTime();
  }

  var now = new Date();
  var todayStart = startOfDay(now);
  var yesterdayStart = todayStart - 24 * 60 * 60 * 1000;

  function bucket(ts) {
    if (ts >= todayStart) return "today";
    if (ts >= yesterdayStart) return "yesterday";
    return "earlier";
  }

  var current = null;
  var items = list.querySelectorAll("li[data-ts]");
  items.forEach(function (li) {
    var ts = Number(li.getAttribute("data-ts"));
    if (!isFinite(ts)) return;
    var b = bucket(ts);
    if (b === current) return;
    current = b;
    var heading = document.createElement("li");
    heading.className = "px-2 pb-1 pt-4 text-xs font-semibold uppercase tracking-wide text-slate-400";
    heading.textContent = labels[b] || b;
    list.insertBefore(heading, li);
  });
  // 第一组标题贴着卡片顶部，不需要那段上间距。
  var first = list.querySelector("li:not([data-ts])");
  if (first) first.classList.replace("pt-4", "pt-0");
})();
