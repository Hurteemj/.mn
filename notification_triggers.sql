-- =====================================================================
-- Notification triggers -- creates notifications WITH a working link
-- to the relevant event, for the three cases your UI already has
-- icons for: new applicant, application confirmed/cancelled, and
-- certificate issued.
-- If you already have similar triggers, check for naming conflicts
-- before running this (it will replace any function with these names).
-- =====================================================================

-- 1) Org gets notified when someone applies to their opportunity
create or replace function public.notify_new_applicant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_title text;
begin
  select org_id, title into v_org_id, v_title
  from public.opportunities where id = new.opportunity_id;

  insert into public.notifications (user_id, type, title, body, link)
  values (
    v_org_id,
    'new_applicant',
    'Шинэ бүртгэл',
    '"' || coalesce(v_title, 'Ажил') || '" ажилд шинэ хүн бүртгүүлэв.',
    'manai_gishuud.html?opp=' || new.opportunity_id
  );
  return new;
end;
$$;

drop trigger if exists on_application_created on public.applications;
create trigger on_application_created
  after insert on public.applications
  for each row execute function public.notify_new_applicant();

-- 2) Volunteer gets notified when their application is confirmed or
-- cancelled BY THE ORG (skips notifying them about their own cancel)
create or replace function public.notify_application_status_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_title text;
begin
  if new.status = old.status then
    return new;
  end if;

  select title into v_title from public.opportunities where id = new.opportunity_id;

  if new.status = 'confirmed' then
    insert into public.notifications (user_id, type, title, body, link)
    values (
      new.volunteer_id,
      'application_confirmed',
      'Бүртгэл баталгаажлаа',
      '"' || coalesce(v_title, 'Ажил') || '" ажилд таны бүртгэл баталгаажлаа.',
      'ajil_delgerengui.html?id=' || new.opportunity_id
    );
  elsif new.status = 'cancelled' and auth.uid() is distinct from new.volunteer_id then
    insert into public.notifications (user_id, type, title, body, link)
    values (
      new.volunteer_id,
      'application_cancelled',
      'Бүртгэл цуцлагдлаа',
      '"' || coalesce(v_title, 'Ажил') || '" ажилд таны бүртгэлийг байгууллага цуцлав.',
      'ajil_delgerengui.html?id=' || new.opportunity_id
    );
  end if;
  return new;
end;
$$;

drop trigger if exists on_application_status_change on public.applications;
create trigger on_application_status_change
  after update of status on public.applications
  for each row execute function public.notify_application_status_change();

-- 3) Volunteer gets notified when a certificate is issued
create or replace function public.notify_certificate_issued()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.notifications (user_id, type, title, body, link)
  values (
    new.volunteer_id,
    'certificate_issued',
    'Гэрчилгээ бэлэн боллоо',
    coalesce(new.opportunity_title, 'Таны') || ' ажлын гэрчилгээ бэлэн боллоо.',
    'minii_idevh.html'
  );
  return new;
end;
$$;

drop trigger if exists on_certificate_issued on public.certificates;
create trigger on_certificate_issued
  after insert on public.certificates
  for each row execute function public.notify_certificate_issued();
