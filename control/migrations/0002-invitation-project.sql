-- An invitation can be for one project of the organization (the membership it creates gets that project_id).
alter table control.invitations
  add column if not exists project_id uuid references control.projects (id) on delete cascade;
