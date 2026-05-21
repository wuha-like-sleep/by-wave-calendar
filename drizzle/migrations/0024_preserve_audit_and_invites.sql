-- Change cascade behavior so deleting a user doesn't wipe history they
-- created:
--
-- 1. admin_audit_log.actor_user_id was ON DELETE CASCADE — a self-deleting
--    admin wiped their own audit trail. Now SET NULL: row stays, actor
--    column becomes null. Combined with the admin/audit query switching
--    from INNER JOIN to LEFT JOIN, the row stays visible as "[已删除用户]".
--
-- 2. calendar_invitations.invited_by was ON DELETE CASCADE — deleting a
--    user yanked every pending invitation they sent. Now SET NULL: the
--    invitation stays valid, invitee can still accept, "inviter" field
--    just shows as anonymous.

ALTER TABLE admin_audit_log
  ALTER COLUMN actor_user_id DROP NOT NULL;
ALTER TABLE admin_audit_log
  DROP CONSTRAINT IF EXISTS admin_audit_log_actor_user_id_users_id_fk;
ALTER TABLE admin_audit_log
  ADD CONSTRAINT admin_audit_log_actor_user_id_users_id_fk
    FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE calendar_invitations
  ALTER COLUMN invited_by DROP NOT NULL;
ALTER TABLE calendar_invitations
  DROP CONSTRAINT IF EXISTS calendar_invitations_invited_by_users_id_fk;
ALTER TABLE calendar_invitations
  ADD CONSTRAINT calendar_invitations_invited_by_users_id_fk
    FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE SET NULL;
