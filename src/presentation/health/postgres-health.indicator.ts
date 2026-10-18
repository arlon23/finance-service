import { InjectEntityManager } from '@mikro-orm/nestjs';
import type { EntityManager } from '@mikro-orm/core';
import { Injectable } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';

@Injectable()
export class PostgresHealthIndicator {
  constructor(
    @InjectEntityManager('default') private readonly em: EntityManager,
    private readonly healthIndicator: HealthIndicatorService,
  ) {}

  check() {
    return this.healthIndicator
      .check('database')
      .attempt(async () => {
        await this.em.getConnection().execute('select 1');
      })
      .withTimeout(1_000);
  }
}
