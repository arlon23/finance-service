import type { Logger } from '@nestjs/common';

export async function waitForGracefulDrain(
  operations: readonly Promise<unknown>[],
  timeoutMs: number,
  logger: Logger,
  workerName: string,
): Promise<void> {
  if (operations.length === 0) {
    return;
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const drained = Promise.allSettled(operations).then(() => true);
  const timedOut = await Promise.race([
    drained,
    new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  if (timeout) {
    clearTimeout(timeout);
  }

  if (!timedOut) {
    logger.error(
      `${workerName} drain exceeded ${timeoutMs}ms; continuing to wait so active database work is not interrupted`,
    );
    await drained;
  }
}
