-- A project delete keeps the REMOVED row, so nothing cascades: deletes that ran before the delete job cleaned up left
-- their project-scoped memberships and invitations behind. Remove those; a re-run finds nothing left to delete.
delete from control.memberships where project_id in (select id from control.projects where status = 'REMOVED');
delete from control.invitations where project_id in (select id from control.projects where status = 'REMOVED');
