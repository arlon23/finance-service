import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });

  it('propagates a supplied correlation id in the response header', async () => {
    await request(app.getHttpServer())
      .get('/')
      .set('X-Correlation-ID', 'e2e-request-correlation')
      .expect(200)
      .expect('X-Correlation-ID', 'e2e-request-correlation');
  });

  it('generates a UUID v4 correlation id when the header is missing', async () => {
    const response = await request(app.getHttpServer()).get('/').expect(200);
    expect(response.headers['x-correlation-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('protects the legacy provider transaction route with API-key authentication', async () => {
    await request(app.getHttpServer())
      .post('/transactions')
      .send({})
      .expect(401);
  });

  afterEach(async () => {
    await app.close();
  });
});
