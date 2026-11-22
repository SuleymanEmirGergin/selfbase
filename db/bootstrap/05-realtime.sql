-- Change notifications for core's realtime hub. The payload carries only the row id;
-- the hub re-reads the row as each subscriber so RLS decides who sees it.

create function selfbase.notify_change() returns trigger language plpgsql as $$
begin
  perform pg_notify('selfbase_changes', json_build_object(
    'schema', tg_table_schema,
    'table', tg_table_name,
    'type', tg_op,
    'id', case when tg_op = 'DELETE' then to_jsonb(old) -> 'id' else to_jsonb(new) -> 'id' end
  )::text);
  return null;
end
$$;

create function selfbase.enable_realtime(tbl regclass) returns void language plpgsql as $$
begin
  if not exists (select 1 from pg_attribute where attrelid = tbl and attname = 'id' and not attisdropped) then
    raise exception 'selfbase.enable_realtime: % has no id column', tbl;
  end if;
  execute format('drop trigger if exists selfbase_realtime on %s', tbl);
  execute format('create trigger selfbase_realtime after insert or update or delete on %s '
                 'for each row execute function selfbase.notify_change()', tbl);
end
$$;

-- Empty on purpose: migrations may run ALTER PUBLICATION supabase_realtime ADD TABLE ...
create publication supabase_realtime;
