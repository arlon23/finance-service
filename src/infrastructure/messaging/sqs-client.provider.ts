import { SQSClient, type SQSClientConfig } from '@aws-sdk/client-sqs';

export interface SqsClientEnvironment {
  AWS_REGION?: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_ENDPOINT_URL?: string;
  NODE_ENV?: string;
  SQS_ENDPOINT?: string;
}

export interface SqsClientOptions {
  endpoint?: string;
  region?: string;
}

export function resolveSqsClientConfig(
  options: SqsClientOptions = {},
  environment: SqsClientEnvironment = process.env,
): SQSClientConfig {
  const endpoint =
    options.endpoint ??
    environment.SQS_ENDPOINT ??
    environment.AWS_ENDPOINT_URL ??
    (environment.NODE_ENV === 'production'
      ? undefined
      : 'http://localhost:4566');
  const region = options.region ?? environment.AWS_REGION ?? 'us-east-1';

  return {
    region,
    ...(endpoint ? { endpoint } : {}),
    ...(endpoint
      ? {
          credentials: {
            accessKeyId: environment.AWS_ACCESS_KEY_ID ?? 'test',
            secretAccessKey: environment.AWS_SECRET_ACCESS_KEY ?? 'test',
          },
        }
      : {}),
  };
}

export function createSqsClient(
  options: SqsClientOptions = {},
  environment: SqsClientEnvironment = process.env,
): SQSClient {
  return new SQSClient(resolveSqsClientConfig(options, environment));
}
