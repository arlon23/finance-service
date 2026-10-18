import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  WALLET_LEDGER_REPOSITORY,
  WALLET_REPOSITORY,
} from '../../application/tokens.js';
import type {
  WalletLedgerRepositoryPort,
  WalletRepositoryPort,
} from '../../application/ports/financial-persistence.js';
import { CreateWalletUseCase } from '../../application/use-cases/create-wallet.use-case.js';
import { CreateWalletDto } from '../dtos/create-wallet.dto.js';
import { LedgerQueryDto } from '../dtos/ledger-query.dto.js';
import { StrictDtoPipe } from '../dtos/strict-dto.pipe.js';
import { ApiKeyGuard } from '../guards/api-key.guard.js';
import { RateLimit } from '../throttler/rate-limit.decorator.js';

@Controller('wallets')
@UseGuards(ApiKeyGuard)
export class WalletController {
  constructor(
    private readonly createWallet: CreateWalletUseCase,
    @Inject(WALLET_REPOSITORY)
    private readonly wallets: WalletRepositoryPort,
    @Inject(WALLET_LEDGER_REPOSITORY)
    private readonly ledger: WalletLedgerRepositoryPort,
  ) {}

  @Post()
  @RateLimit({ limit: 120, windowMs: 60_000, identity: 'wallet' })
  async create(
    @Body(new StrictDtoPipe((value) => CreateWalletDto.parse(value)))
    body: CreateWalletDto,
  ) {
    const result = await this.createWallet.execute({
      playerId: body.playerId,
      currency: body.currency,
      initialBalance: body.initialBalance,
    });
    return {
      id: result.wallet.id,
      playerId: result.wallet.playerId,
      currency: result.wallet.currency,
      balance: result.wallet.balance.toJSON(),
      version: result.wallet.version,
      createdAt: result.wallet.createdAt.toISOString(),
      updatedAt: result.wallet.updatedAt.toISOString(),
      ...(result.openingTransaction
        ? { openingTransactionId: result.openingTransaction.id }
        : {}),
    };
  }

  @Get(':id')
  @RateLimit({ limit: 120, windowMs: 60_000, identity: 'wallet' })
  async findById(@Param('id') id: string) {
    const wallet = await this.wallets.findById(id);
    if (!wallet) {
      throw new NotFoundException('Wallet not found');
    }
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
      createdAt: wallet.createdAt.toISOString(),
      updatedAt: wallet.updatedAt.toISOString(),
    };
  }

  @Get(':id/ledger')
  @RateLimit({ limit: 120, windowMs: 60_000, identity: 'wallet' })
  async findLedger(
    @Param('id') id: string,
    @Query(new StrictDtoPipe((value) => LedgerQueryDto.parse(value)))
    query: LedgerQueryDto,
  ) {
    const wallet = await this.wallets.findById(id);
    if (!wallet) {
      throw new NotFoundException('Wallet not found');
    }

    const entries = await this.ledger.findByWalletId(id, {
      limit: query.limit + 1,
      ...(query.cursor ? { cursor: query.cursor } : {}),
    });
    const hasNextPage = entries.length > query.limit;
    const page = hasNextPage ? entries.slice(0, query.limit) : entries;
    return {
      walletId: id,
      entries: page.map((entry) => ({
        id: entry.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        createdAt: entry.createdAt.toISOString(),
      })),
      nextCursor: hasNextPage ? page.at(-1)?.id : null,
    };
  }
}
