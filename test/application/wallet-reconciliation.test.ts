import { describe, expect, it } from 'bun:test';
import { WalletReconciliationService } from '../../src/application/services/wallet-reconciliation.service.js';

function createService(
  pages: Array<
    Array<{
      wallet_id: string;
      wallet_balance: string;
      ledger_balance: string;
      is_consistent: boolean;
    }>
  >,
) {
  const calls: unknown[][] = [];
  const metrics = { recordReconciliationDiscrepancy: () => {} };
  const em = {
    schema: 'financial_test',
    config: { get: () => 'financial_test' },
    getConnection: () => ({
      execute: async (_sql: string, params: unknown[]) => {
        calls.push(params);
        return pages.shift() ?? [];
      },
    }),
  };
  return {
    service: new WalletReconciliationService(em as never, metrics as never),
    calls,
  };
}

describe('WalletReconciliationService', () => {
  it('audits wallets in keyset-paginated batches and reports exact mismatches', async () => {
    const { service, calls } = createService([
      [
        {
          wallet_id: 'wallet-1',
          wallet_balance: '10.00',
          ledger_balance: '10.00',
          is_consistent: true,
        },
        {
          wallet_id: 'wallet-2',
          wallet_balance: '5.00',
          ledger_balance: '4.50',
          is_consistent: false,
        },
      ],
      [],
    ]);

    const result = await service.reconcile(2);

    expect(result.auditedWallets).toBe(2);
    expect(result.discrepancies).toEqual([
      {
        walletId: 'wallet-2',
        walletBalance: '5.00',
        ledgerBalance: '4.50',
      },
    ]);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(calls).toEqual([
      [null, null, 2],
      ['wallet-2', 'wallet-2', 2],
    ]);
  });

  it('rejects invalid batch sizes without querying PostgreSQL', async () => {
    const { service, calls } = createService([]);

    await expect(service.reconcile(0)).rejects.toThrow(
      'Wallet reconciliation batch size must be a positive integer',
    );
    expect(calls).toHaveLength(0);
  });
});
