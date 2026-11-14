import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { withPostgres } from './lib/pg-harness';

/**
 * Phase 1/2 suite: tenancy, identity, invitations and database-enforced roles.
 * Phase 3 financial behaviour lives in scripts/test-ledger.ts and shares this
 * harness. Both run against a real PostgreSQL 17 server with the real migrations,
 * never against fixtures or a live Supabase project.
 */
async function main() {
  await withPostgres(
    async (h) => {
      const { ok, denied, noRows, admin, actor } = h;
      const ids: Record<string, string> = {};
      for (const name of [
        'owner',
        'coowner',
        'manager',
        'accountant',
        'staff',
        'outsider',
        'otherOwner',
      ]) {
        ids[name] = await h.createUser(name);
      }
      const clients: Record<string, Client> = {};
      for (const [name, id] of Object.entries(ids)) clients[name] = await actor(id);
      const anon = await actor();

      const call = (name: string, fn: string, args: unknown[]) =>
        clients[name]!.query(`select * from ${fn}`, args);
      const businessA = (
        await clients.owner!.query('select public.create_business($1,$2,$3) as id', [
          'Alpha Traders',
          'PKR',
          'Asia/Karachi',
        ])
      ).rows[0].id as string;
      const businessB = (
        await clients.otherOwner!.query('select public.create_business($1,$2,$3) as id', [
          'Beta Books',
          'USD',
          'UTC',
        ])
      ).rows[0].id as string;
      ok(
        (await clients.owner!.query('select * from public.businesses')).rows.length === 1,
        'Owner sees only their business',
      );
      ok(
        (await clients.outsider!.query('select * from public.businesses')).rows.length === 0,
        'Unrelated authenticated user sees no businesses',
      );
      ok(
        (await anon.query('select * from public.businesses')).rows.length === 0,
        'Anonymous user sees no businesses',
      );
      ok(
        (await clients.owner!.query('select * from public.profiles')).rows[0].display_name ===
          'owner',
        'Auth insert trigger creates persistent profile',
      );
      ok(
        (
          await clients.outsider!.query('select public.create_business($1,$2,$3)', [
            'Own new business',
            'PKR',
            'UTC',
          ])
        ).rowCount === 1,
        'Any authenticated user may create their own business',
      );
      await denied(
        clients.owner!,
        'select public.update_business_settings($1,$2,$3,$4,$5)',
        [businessB, 'Stolen', 'PKR', 'UTC', false],
        'Cross-business settings update denied',
      );
      await denied(
        clients.owner!,
        'update public.businesses set name=$1 where id=$2',
        ['Direct overwrite', businessA],
        'Direct business writes denied',
      );
      await denied(
        clients.owner!,
        'insert into public.business_members(business_id,user_id,role) values ($1,$2,$3)',
        [businessA, ids.outsider, 'owner'],
        'Direct membership/role insertion denied',
      );
      await denied(
        clients.owner!,
        'update public.business_members set role=$1 where business_id=$2 and user_id=$3',
        ['owner', businessA, ids.owner],
        'Direct role update denied',
      );
      await denied(
        clients.owner!,
        'delete from public.business_members where business_id=$1',
        [businessA],
        'Direct membership deletion denied',
      );
      await denied(
        anon,
        'select public.create_business($1,$2,$3)',
        ['No auth', 'PKR', 'UTC'],
        'Anonymous business creation denied',
      );
      await denied(
        clients.owner!,
        'select public.create_business($1,$2,$3)',
        ['Bad zone', 'PKR', 'Fake/Zone'],
        'Invalid timezone rejected',
      );
      await denied(
        clients.owner!,
        'select public.create_business($1,$2,$3)',
        ['Bad currency', 'XXX', 'UTC'],
        'Unsupported currency rejected',
      );

      const invite = (
        await call('owner', 'public.create_invitation($1,$2,$3,$4)', [
          businessA,
          'manager',
          'manager@example.test',
          24,
        ])
      ).rows[0];
      ok(
        /^[a-f0-9]{64}$/.test(invite.create_invitation.token),
        'Invitation returns a 256-bit random token once',
      );
      const token = invite.create_invitation.token as string;
      const stored = (
        await admin.query(
          'select token_hash, details::text as details from public.invitations join public.audit_logs on entity_id=invitations.id where invitations.id=$1',
          [invite.create_invitation.invitation_id],
        )
      ).rows[0];
      ok(
        !stored.token_hash.includes(token) && !stored.details.includes(token),
        'Raw invitation token is not stored in invitation row or audit',
      );
      await denied(
        clients.outsider!,
        'select * from public.preview_invitation($1)',
        [token],
        'Email-bound invitation cannot be previewed by another account',
      );
      await denied(
        clients.outsider!,
        'select public.accept_invitation($1)',
        [token],
        'Email-bound invitation cannot be stolen by another account',
      );
      await denied(
        clients.owner!,
        'select public.accept_invitation($1)',
        [token],
        'Wrong email cannot accept invitation',
      );
      ok(
        (await call('manager', 'public.preview_invitation($1)', [token])).rows[0].preview_invitation
          .business_id === businessA,
        'Correct confirmed account can preview invitation',
      );
      await denied(
        clients.owner!,
        'select * from public.invitations',
        [],
        'Invitation table cannot be read directly',
      );
      await denied(
        clients.manager!,
        'select * from public.list_invitations($1)',
        [businessA],
        'Staff/manager cannot list invitation emails',
      );
      ok(
        (await call('manager', 'public.accept_invitation($1)', [token])).rows[0]
          .accept_invitation === businessA,
        'Authorized invitee joins persistent business',
      );
      await denied(
        clients.manager!,
        'select public.accept_invitation($1)',
        [token],
        'Invitation cannot be reused',
      );
      ok(
        (await clients.manager!.query('select id from public.businesses')).rows.length === 1,
        'Joined member sees exactly the invited business',
      );
      ok(
        (await clients.manager!.query('select * from public.businesses where id=$1', [businessB]))
          .rows.length === 0,
        'Joined member cannot read another tenant',
      );
      ok(
        (await clients.owner!.query('select * from public.profiles where id=$1', [ids.otherOwner]))
          .rows.length === 0,
        'Profile directory does not leak across businesses',
      );
      for (const role of ['coowner', 'manager', 'accountant', 'staff']) {
        await denied(
          clients[role]!,
          'select public.archive_business($1,$2)',
          [businessA, true],
          `${role} cannot archive the business`,
        );
        await denied(
          clients[role]!,
          'select public.remove_member($1,$2)',
          [businessA, ids.owner],
          `${role} cannot remove the owner`,
        );
        await denied(
          clients[role]!,
          'select public.set_member_role($1,$2,$3)',
          [businessA, ids[role as keyof typeof ids], 'owner'],
          `${role} cannot grant themselves ownership`,
        );
      }
      await denied(
        clients.manager!,
        'select public.create_invitation($1,$2,$3,$4)',
        [businessA, 'staff', null, 24],
        'Manager cannot invite',
      );
      await denied(
        clients.manager!,
        'select public.set_member_role($1,$2,$3)',
        [businessA, ids.manager, 'owner'],
        'Manager cannot self-promote',
      );
      await denied(
        clients.manager!,
        'select public.update_business_settings($1,$2,$3,$4,$5)',
        [businessA, 'Hack', 'USD', 'UTC', true],
        'Manager cannot change settings',
      );
      ok(
        (await clients.manager!.query('select * from public.audit_logs')).rows.length === 0,
        'Manager cannot read audit history',
      );

      for (const [role, clientName] of [
        ['co_owner', 'coowner'],
        ['accountant', 'accountant'],
        ['staff', 'staff'],
      ] as const) {
        const result = (
          await call('owner', 'public.create_invitation($1,$2,$3,$4)', [
            businessA,
            role,
            `${clientName}@example.test`,
            24,
          ])
        ).rows[0].create_invitation;
        await call(clientName, 'public.accept_invitation($1)', [result.token]);
      }
      ok(
        (
          await clients.owner!.query(
            'select count(*)::int as n from public.business_members where business_id=$1 and removed_at is null',
            [businessA],
          )
        ).rows[0].n === 5,
        'All five roles are represented by actual membership rows',
      );
      await denied(
        clients.coowner!,
        'select public.create_invitation($1,$2,$3,$4)',
        [businessA, 'staff', null, 24],
        'Co-owner invite permission defaults off',
      );
      await call('owner', 'public.update_business_settings($1,$2,$3,$4,$5)', [
        businessA,
        'Alpha Traders',
        'PKR',
        'Asia/Karachi',
        true,
      ]);
      const coInvite = (
        await call('coowner', 'public.create_invitation($1,$2,$3,$4)', [
          businessA,
          'staff',
          null,
          1,
        ])
      ).rows[0].create_invitation;
      ok(!!coInvite.token, 'Owner can delegate invitation creation to co-owner');
      await denied(
        clients.coowner!,
        'select public.set_member_role($1,$2,$3)',
        [businessA, ids.coowner, 'owner'],
        'Delegated co-owner still cannot change roles',
      );
      const ownerOnlyInvite = (
        await call('owner', 'public.create_invitation($1,$2,$3,$4)', [businessA, 'staff', null, 24])
      ).rows[0].create_invitation;
      await denied(
        clients.coowner!,
        'select public.revoke_invitation($1)',
        [ownerOnlyInvite.invitation_id],
        'Delegated co-owner cannot revoke an owner-issued invitation',
      );
      await call('owner', 'public.revoke_invitation($1)', [ownerOnlyInvite.invitation_id]);
      await call('owner', 'public.update_business_settings($1,$2,$3,$4,$5)', [
        businessA,
        'Alpha Traders',
        'PKR',
        'Asia/Karachi',
        false,
      ]);
      await denied(
        clients.coowner!,
        'select public.create_invitation($1,$2,$3,$4)',
        [businessA, 'staff', null, 24],
        'Revoking delegation immediately removes co-owner invitation permission',
      );
      await denied(
        clients.coowner!,
        'select * from public.list_invitations($1)',
        [businessA],
        'Revoking delegation also removes invitation-email listing permission',
      );
      await call('owner', 'public.update_business_settings($1,$2,$3,$4,$5)', [
        businessA,
        'Alpha Traders',
        'PKR',
        'Asia/Karachi',
        true,
      ]);
      await call('owner', 'public.revoke_invitation($1)', [coInvite.invitation_id]);
      await denied(
        clients.outsider!,
        'select public.accept_invitation($1)',
        [coInvite.token],
        'Revoked invitation cannot be accepted',
      );
      const expired = (
        await call('owner', 'public.create_invitation($1,$2,$3,$4)', [businessA, 'staff', null, 1])
      ).rows[0].create_invitation;
      await admin.query(
        "update public.invitations set created_at=now()-interval '2 hours', expires_at=now()-interval '1 second' where id=$1",
        [expired.invitation_id],
      );
      await denied(
        clients.outsider!,
        'select public.accept_invitation($1)',
        [expired.token],
        'Expired invitation cannot be accepted',
      );
      await denied(
        clients.owner!,
        'select public.create_invitation($1,$2,$3,$4)',
        [businessA, 'owner', null, 24],
        'Invitation cannot grant owner role',
      );

      // Acceptance and revocation contend on the same business/invitation locks.
      const raceInvite = (
        await call('owner', 'public.create_invitation($1,$2,$3,$4)', [businessA, 'staff', null, 24])
      ).rows[0].create_invitation;
      const racer = await actor(ids.outsider);
      const outcomes = await Promise.allSettled([
        clients.outsider!.query('select public.accept_invitation($1)', [raceInvite.token]),
        racer.query('select public.revoke_invitation($1)', [raceInvite.invitation_id]),
      ]);
      ok(
        outcomes.filter((result) => result.status === 'fulfilled').length === 1,
        'Concurrent accept/revoke permits exactly one outcome',
      );
      const accepted = (
        await admin.query('select accepted_at, revoked_at from public.invitations where id=$1', [
          raceInvite.invitation_id,
        ])
      ).rows[0];
      ok(
        !!accepted.accepted_at !== !!accepted.revoked_at,
        'Invitation cannot be both accepted and revoked',
      );

      const simultaneousInvite = (
        await call('owner', 'public.create_invitation($1,$2,$3,$4)', [businessA, 'staff', null, 24])
      ).rows[0].create_invitation;
      const joinIds = [randomUUID(), randomUUID()];
      const joinClients: Client[] = [];
      for (const [index, id] of joinIds.entries()) {
        await admin.query(
          'insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values ($1,$2,now(),$3)',
          [id, `race-${index}@example.test`, JSON.stringify({ display_name: `Race ${index}` })],
        );
        joinClients.push(await actor(id));
      }
      const joins = await Promise.allSettled(
        joinClients.map((connection) =>
          connection.query('select public.accept_invitation($1)', [simultaneousInvite.token]),
        ),
      );
      ok(
        joins.filter((result) => result.status === 'fulfilled').length === 1,
        'Two simultaneous accounts cannot consume the same invitation',
      );
      ok(
        (
          await admin.query(
            'select count(*)::int as n from public.business_members where business_id=$1 and user_id=any($2::uuid[]) and removed_at is null',
            [businessA, joinIds],
          )
        ).rows[0].n === 1,
        'Concurrent invitation acceptance creates exactly one membership',
      );

      await denied(
        clients.owner!,
        'select public.set_member_role($1,$2,$3)',
        [businessA, ids.owner, 'staff'],
        'Last active owner cannot be demoted',
      );
      await denied(
        clients.owner!,
        'select public.leave_business($1)',
        [businessA],
        'Last active owner cannot leave',
      );
      await clients.owner!.query('begin');
      await clients.owner!.query('select public.set_member_role($1,$2,$3)', [
        businessA,
        ids.coowner,
        'owner',
      ]);
      await clients.owner!.query('select public.set_member_role($1,$2,$3)', [
        businessA,
        ids.owner,
        'co_owner',
      ]);
      await clients.owner!.query('commit');
      ok(true, 'Atomic ownership transfer succeeds with deferred owner invariant');
      // The outsider is a member only if it won the accept/revoke race.
      const removedId = outcomes[0].status === 'fulfilled' ? ids.outsider : ids.staff;
      const retainedId = outcomes[0].status === 'fulfilled' ? ids.staff : ids.outsider;
      await call('coowner', 'public.remove_member($1,$2)', [businessA, removedId]);
      const removedClient = clients[removedId === ids.outsider ? 'outsider' : 'staff']!;
      const retainedClient = clients[retainedId === ids.outsider ? 'outsider' : 'staff']!;
      ok(
        (await removedClient.query('select id from public.businesses where id=$1', [businessA]))
          .rows.length === 0,
        'Removed member immediately loses this business while retaining unrelated businesses',
      );
      ok(
        (
          await removedClient.query('select * from public.business_members where business_id=$1', [
            businessA,
          ])
        ).rows.length === 1,
        'Removed member retains only their own history row',
      );
      ok(
        (await removedClient.query('select * from public.profiles where id=$1', [ids.owner])).rows
          .length === 0,
        'Removed member loses profile-directory access',
      );
      const reinvite = (
        await call('coowner', 'public.create_invitation($1,$2,$3,$4)', [
          businessA,
          'accountant',
          null,
          24,
        ])
      ).rows[0].create_invitation;
      await removedClient.query('select public.accept_invitation($1)', [reinvite.token]);
      ok(
        (await retainedClient.query('select 1')).rowCount === 1,
        'Independent member connection remains usable',
      );
      ok(
        (
          await removedClient.query(
            'select role from public.business_members where business_id=$1 and user_id=$2',
            [businessA, removedId],
          )
        ).rows[0].role === 'accountant',
        'Rejoining uses a new invitation role without duplicate membership',
      );

      await call('owner', 'public.set_member_display_name($1,$2)', [
        businessA,
        'Custom bookkeeper',
      ]);
      ok(
        (
          await clients.owner!.query(
            'select display_name from public.business_members where business_id=$1 and user_id=$2',
            [businessA, ids.owner],
          )
        ).rows[0].display_name === 'Custom bookkeeper',
        'Business-specific member display name persists',
      );
      await clients.owner!.query('update public.profiles set display_name=$1 where id=$2', [
        'New profile name',
        ids.owner,
      ]);
      ok(
        (
          await clients.owner!.query('select display_name from public.profiles where id=$1', [
            ids.owner,
          ])
        ).rows[0].display_name === 'New profile name',
        'Profile display name update persists',
      );
      await noRows(
        clients.owner!,
        'update public.profiles set display_name=$1 where id=$2',
        ['Hacked', ids.coowner],
        'Cannot edit another user profile (RLS filters row)',
      );
      const audits = (
        await clients.coowner!.query('select action from public.audit_logs where business_id=$1', [
          businessA,
        ])
      ).rows.map((row) => row.action);
      for (const action of [
        'business.created',
        'business.settings_changed',
        'invitation.created',
        'invitation.accepted',
        'invitation.revoked',
        'member.role_changed',
        'member.removed',
        'member.name_changed',
      ]) {
        ok(audits.includes(action), `Atomic audit exists: ${action}`);
      }
      await denied(
        clients.coowner!,
        'update public.audit_logs set action=$1 where business_id=$2',
        ['forged', businessA],
        'Audit update privilege is denied',
      );
      await denied(
        clients.coowner!,
        'delete from public.audit_logs where business_id=$1',
        [businessA],
        'Audit delete privilege is denied',
      );
      ok(
        (
          await clients.otherOwner!.query('select * from public.audit_logs where business_id=$1', [
            businessA,
          ])
        ).rows.length === 0,
        'Audit reads are tenant-isolated',
      );
      const health = (await anon.query('select public.ownerbook_health() as value')).rows[0].value;
      ok(health.schema_version === 3, 'Health endpoint reports schema version 3');
      const privateExec = (
        await admin.query("select has_schema_privilege('anon','private','usage') as allowed")
      ).rows[0].allowed;
      ok(!privateExec, 'Anon has no private-schema access');

      // Check the trigger itself, not merely the absence of a client UPDATE grant.
      await assert.rejects(
        admin.query('update public.audit_logs set action=$1 where business_id=$2', [
          'forged',
          businessA,
        ]),
        /immutable/,
      );
      ok(true, 'Audit immutability trigger rejects even privileged SQL updates');
      await admin.query('begin');
      await admin.query('delete from public.business_members where business_id=$1 and role=$2', [
        businessB,
        'owner',
      ]);
      await assert.rejects(admin.query('commit'), /active owner/);
      ok(true, 'Owner invariant also protects privileged membership deletion at commit');
      await call('otherOwner', 'public.archive_business($1,$2)', [businessB, true]);
      await admin.query('update public.businesses set archived_at=now() where id=$1', [businessA]);
      await denied(
        clients.accountant!,
        'select public.create_invitation($1,$2,$3,$4)',
        [businessA, 'staff', null, 24],
        'Accountant cannot invite',
      );
      await denied(
        clients.coowner!,
        'select public.create_invitation($1,$2,$3,$4)',
        [businessA, 'staff', null, 24],
        'Archived business cannot issue invitations',
      );
      await call('otherOwner', 'public.archive_business($1,$2)', [businessB, false]);
      const archivedAccept = (
        await call('otherOwner', 'public.create_invitation($1,$2,$3,$4)', [
          businessB,
          'staff',
          null,
          24,
        ])
      ).rows[0].create_invitation;
      await call('otherOwner', 'public.archive_business($1,$2)', [businessB, true]);
      await denied(
        joinClients[0]!,
        'select public.accept_invitation($1)',
        [archivedAccept.token],
        'An invitation issued before archiving cannot join an archived business',
      );
      await denied(
        clients.owner!,
        'select public.remove_member($1,$2)',
        [businessB, ids.otherOwner],
        'An owner cannot remove a member of another business',
      );
      await denied(
        clients.owner!,
        'select public.archive_business($1,$2)',
        [businessB, true],
        'An owner cannot archive another business',
      );
      await denied(
        clients.coowner!,
        "insert into public.audit_logs(business_id,actor_id,action,entity_type,entity_id) values ($1,$2,'forged','business',$1)",
        [businessA, ids.coowner],
        'Clients cannot forge audit records',
      );
      await denied(
        clients.owner!,
        'update public.profiles set id=$1 where id=$2',
        [ids.outsider, ids.owner],
        'Profile ownership cannot be changed through the column grant',
      );
      const rpcGrants =
        await admin.query(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname <> 'ownerbook_health' and has_function_privilege('anon',p.oid,'execute')`);
      ok(rpcGrants.rowCount === 0, 'Anonymous callers cannot execute any identity/business RPC');
      const fixedPaths =
        await admin.query(`select count(*)::int as n from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname in ('public','private') and p.prosecdef and not (p.proconfig @> array['search_path=""'])`);
      ok(fixedPaths.rows[0].n === 0, 'Every security-definer function pins an empty search path');
      await admin.query('update auth.users set email_confirmed_at=null where id=$1', [
        ids.accountant,
      ]);
      // Restore an active tenant and issue through its actual owner.
      await call('otherOwner', 'public.archive_business($1,$2)', [businessB, false]);
      const emailInvite = (
        await call('otherOwner', 'public.create_invitation($1,$2,$3,$4)', [
          businessB,
          'staff',
          'accountant@example.test',
          24,
        ])
      ).rows[0].create_invitation;
      await denied(
        clients.accountant!,
        'select public.accept_invitation($1)',
        [emailInvite.token],
        'Unconfirmed email cannot consume an email-bound invitation',
      );
      const foreignInvite = (
        await call('otherOwner', 'public.create_invitation($1,$2,$3,$4)', [
          businessB,
          'staff',
          null,
          24,
        ])
      ).rows[0].create_invitation;
      await denied(
        clients.owner!,
        'select public.revoke_invitation($1)',
        [foreignInvite.invitation_id],
        'An owner cannot revoke an invitation belonging to another business',
      );
      await denied(
        clients.owner!,
        'select * from public.list_invitations($1)',
        [businessB],
        'An owner cannot list invitation emails from another business',
      );
      ok(
        (
          await clients.owner!.query('select * from public.business_members where business_id=$1', [
            businessB,
          ])
        ).rows.length === 0,
        'Member directory is isolated even when a foreign business ID is supplied',
      );
    },
    {
      summary:
        'native PostgreSQL security checks passed. Hosted Supabase Auth/API still requires live testing.',
    },
  );
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
