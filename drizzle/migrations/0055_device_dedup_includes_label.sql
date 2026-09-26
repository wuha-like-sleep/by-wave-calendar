-- 「是不是同一台设备」的唯一约束，和服务端的判断口径对齐：设备编号 + 设备名。
--
-- 原来的约束是 (user_id, client_device_id)。iOS 把设备编号存在会走 iCloud 同步的
-- 钥匙串里，于是同一个 Apple ID 下的 iPhone 和 iPad 拿到同一个编号：服务端把
-- iPad 上的登录当成「iPhone 重新登录」，原地换掉 iPhone 的刷新令牌，两台来回把
-- 对方挤下线。
--
-- 服务端现在要求设备名也一致才算同一台（iPhone 上报「iPhone (iPhone)」，iPad 上报
-- 「iPad (iPad)」）。可旧约束还在的话，iPad 那一行根本插不进去 —— iPad 登录直接
-- 报错，比互相挤下线更糟。所以约束必须和判断一起换。
--
-- 仍然只约束「还在用的」设备（revoked_at IS NULL），被吊销过的旧行不挡新登录。
DROP INDEX IF EXISTS devices_user_client_idx;
CREATE UNIQUE INDEX IF NOT EXISTS devices_user_client_label_idx
  ON devices (user_id, client_device_id, label)
  WHERE client_device_id IS NOT NULL AND revoked_at IS NULL;
