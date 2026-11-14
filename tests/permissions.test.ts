import { CAPABILITY_COPY, capabilitiesFor } from '../src/lib/permissions';
import type { BusinessRole } from '../src/types/database';

/**
 * The database is the only authority on permissions; this matrix exists so the
 * UI does not offer an action PostgreSQL will refuse. These expectations mirror
 * the role checks asserted against a real server in `npm run test:ledger`.
 */
describe('role capabilities', () => {
  const roles: BusinessRole[] = ['owner', 'co_owner', 'manager', 'accountant', 'staff'];

  it('gives owners and co-owners everything, including the audit trail', () => {
    for (const role of ['owner', 'co_owner'] as const) {
      const capabilities = capabilitiesFor(role);
      expect(Object.values(capabilities).every(Boolean)).toBe(true);
      expect(capabilities.canReadAuditLog).toBe(true);
    }
  });

  it('lets managers and accountants run the books but not read the audit trail', () => {
    for (const role of ['manager', 'accountant'] as const) {
      const capabilities = capabilitiesFor(role);
      expect(capabilities.canRecordSales).toBe(true);
      expect(capabilities.canRecordPayments).toBe(true);
      expect(capabilities.canVoidDocuments).toBe(true);
      expect(capabilities.canAdjustKhata).toBe(true);
      expect(capabilities.canManageCatalog).toBe(true);
      expect(capabilities.canRecordExpenses).toBe(true);
      expect(capabilities.canReadExpenses).toBe(true);
      expect(capabilities.canReadFinancialSummary).toBe(true);
      expect(capabilities.canArchiveCustomers).toBe(true);
      expect(capabilities.canReadAuditLog).toBe(false);
    }
  });

  it('keeps staff selling and collecting, out of expenses, voids and summaries', () => {
    const capabilities = capabilitiesFor('staff');
    expect(capabilities.canManageCustomers).toBe(true);
    expect(capabilities.canRecordSales).toBe(true);
    expect(capabilities.canRecordPayments).toBe(true);
    expect(capabilities.canArchiveCustomers).toBe(false);
    expect(capabilities.canVoidDocuments).toBe(false);
    expect(capabilities.canAdjustKhata).toBe(false);
    expect(capabilities.canManageCatalog).toBe(false);
    expect(capabilities.canRecordExpenses).toBe(false);
    expect(capabilities.canReadExpenses).toBe(false);
    expect(capabilities.canReadFinancialSummary).toBe(false);
    expect(capabilities.canReadAuditLog).toBe(false);
  });

  it('grants nothing to someone with no membership in this business', () => {
    for (const role of [null, undefined]) {
      const capabilities = capabilitiesFor(role);
      expect(Object.values(capabilities).some(Boolean)).toBe(false);
    }
  });

  it('covers every role with the same capability keys', () => {
    const ownerKeys = Object.keys(capabilitiesFor('owner')).sort();
    for (const role of roles) expect(Object.keys(capabilitiesFor(role)).sort()).toEqual(ownerKeys);
    expect(Object.keys(CAPABILITY_COPY).sort()).toEqual(ownerKeys);
  });

  it('explains every refusal in words a shopkeeper can act on', () => {
    for (const copy of Object.values(CAPABILITY_COPY)) {
      expect(copy.length).toBeGreaterThan(20);
      expect(copy).toMatch(/[a-z]/);
    }
  });
});
