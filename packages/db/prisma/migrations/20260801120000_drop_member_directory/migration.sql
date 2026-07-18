-- G3 (RBAC-GROUPS.md §5): retire the legacy advisory "Member" directory.
-- It was the pre-U1 Team screen's table — read/written by NOTHING since U1 made the
-- Team screen Membership+Invitation-backed (Membership is the authz authority; U1's
-- 20260730130000_invitations migration already seeded pending Invitations from these
-- rows). Dropping is safe: no FK points at it and no code path references the model.
DROP TABLE "Member";
