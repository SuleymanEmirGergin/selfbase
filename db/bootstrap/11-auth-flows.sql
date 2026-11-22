-- Task 3: auth mail flows

-- Outgoing auth mails when SMTP_HOST is empty (tests and local development read them here)
create table selfbase.mail_log (
  id bigserial primary key,
  to_email text not null,
  subject text not null,
  html text not null,
  created_at timestamptz not null default now()
);
create index mail_log_to_email_idx on selfbase.mail_log (to_email);

-- One live token per user and type (same index GoTrue has): a new link replaces the previous one
create unique index one_time_tokens_user_id_token_type_key on auth.one_time_tokens (user_id, token_type);

-- Guesses against a short (6-digit SMS) code; the code dies after 5. selfbase-only column: dumps with GoTrue's columns still load
alter table auth.one_time_tokens add column attempts int not null default 0;
