-- A new password ends the user's personal access tokens, in the transaction that writes it. A stolen Studio cookie
-- can mint a token; the reset that ends the stolen session must end that token too. A trigger, because core writes
-- the password (PUT /user, an admin update) inside its own transaction, next to the session revoke.
create or replace function control.end_tokens_on_new_password() returns trigger language plpgsql as $$
begin
  delete from control.access_tokens where user_id = new.id;
  return new;
end $$;

drop trigger if exists end_tokens_on_new_password on auth.users;
create trigger end_tokens_on_new_password after update of encrypted_password on auth.users
  for each row when (old.encrypted_password is distinct from new.encrypted_password)
  execute function control.end_tokens_on_new_password();
