do $$
begin
  begin
    execute 'alter table queue_entries drop constraint if exists queue_entries_payment_method_check';
  exception when undefined_object then null;
  end;

  alter table queue_entries
    add constraint queue_entries_payment_method_check
    check (payment_method is null or payment_method in ('cash', 'card', 'certificate', 'mixed'));
end $$;
