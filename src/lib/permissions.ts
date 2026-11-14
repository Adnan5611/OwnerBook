import type { BusinessRole } from '../types/database';

/**
 * The permission matrix, in one place.
 *
 * This mirrors checks that the database already makes inside each RPC and policy.
 * It exists so the app can hide actions a role may never perform; it is never the
 * reason an action succeeds. Removing every line here would not let a staff member
 * record an expense, because `public.create_expense` refuses them.
 */
export type Capabilities = {
  canManageCustomers: boolean;
  canArchiveCustomers: boolean;
  canRecordSales: boolean;
  canRecordPayments: boolean;
  canVoidDocuments: boolean;
  canAdjustKhata: boolean;
  canManageCatalog: boolean;
  canRecordExpenses: boolean;
  canReadExpenses: boolean;
  canReadFinancialSummary: boolean;
  canReadAuditLog: boolean;
};
/** Owner, co-owner, manager and accountant are the financial roles. */
const FINANCIAL_ROLES: readonly BusinessRole[] = ['owner', 'co_owner', 'manager', 'accountant'];

export function capabilitiesFor(role: BusinessRole | null | undefined): Capabilities {
  const financial = role !== null && role !== undefined && FINANCIAL_ROLES.includes(role);
  const member = role !== null && role !== undefined;
  return {
    canManageCustomers: member,
    canArchiveCustomers: financial,
    canRecordSales: member,
    canRecordPayments: member,
    canVoidDocuments: financial,
    canAdjustKhata: financial,
    canManageCatalog: financial,
    canRecordExpenses: financial,
    canReadExpenses: financial,
    canReadFinancialSummary: financial,
    canReadAuditLog: role === 'owner' || role === 'co_owner',
  };
}

export const CAPABILITY_COPY: Record<keyof Capabilities, string> = {
  canManageCustomers: 'Every member can add and edit customers.',
  canArchiveCustomers: 'Only owners, managers and accountants can archive a customer.',
  canRecordSales: 'Every member can record a sale.',
  canRecordPayments: 'Every member can record a payment.',
  canVoidDocuments: 'Only owners, managers and accountants can void a recorded document.',
  canAdjustKhata: 'Only owners, managers and accountants can adjust a khata balance.',
  canManageCatalog: 'Only owners, managers and accountants can change the item catalog.',
  canRecordExpenses: 'Only owners, managers and accountants can record expenses.',
  canReadExpenses: 'Only owners, managers and accountants can view expenses.',
  canReadFinancialSummary: 'Only owners, managers and accountants can view profit and cash.',
  canReadAuditLog: 'Only owners and co-owners can view the audit trail.',
};
