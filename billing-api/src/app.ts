import { INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { TypeOrmModule } from '@nestjs/typeorm';
import express from 'express';

import { CONTROLLERS } from './api/controllers';
import { BEARER_SCHEME } from './auth/guards';
import { BillingService } from './billing/billing.service';
import { AllExceptionsFilter, bodyParserErrorHandler } from './common/all-exceptions.filter';
import { createValidationPipe } from './common/fields';
import { dataSourceOptions } from './database/data-source';

export const API_PREFIX = 'api/v1';

@Module({
  imports: [TypeOrmModule.forRootAsync({ useFactory: dataSourceOptions })],
  controllers: CONTROLLERS,
  providers: [BillingService],
})
export class AppModule {}

/**
 * Everything main.ts, the tests and the OpenAPI export share. The app must be
 * created with `bodyParser: false`; the JSON parser is added here so its errors
 * get the shared error body.
 */
export function configureApp(app: INestApplication): INestApplication {
  app.use(express.json());
  app.use(bodyParserErrorHandler);
  app.setGlobalPrefix(API_PREFIX);
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(new AllExceptionsFilter());
  return app;
}

export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Mobile Provider Billing API')
    .setVersion('1.0.0')
    .setDescription(
      'SE4458 midterm billing service. All routes are versioned under `/api/v1`.\n\n' +
        'Protected routes need `Authorization: Bearer <JWT>` from `POST /api/v1/auth/login`. ' +
        'Subscribers can only act on the subscriber number in their own token.',
    )
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'JWT from POST /api/v1/auth/login' },
      BEARER_SCHEME,
    )
    .build();
  return SwaggerModule.createDocument(app, config, {
    operationIdFactory: (_controllerKey, methodKey) => methodKey,
  });
}

/** Swagger UI at /docs, the spec at /openapi.json and /openapi.yaml. */
export function mountSwagger(app: INestApplication): void {
  SwaggerModule.setup('docs', app, () => buildOpenApiDocument(app), {
    jsonDocumentUrl: 'openapi.json',
    yamlDocumentUrl: 'openapi.yaml',
  });
}

export async function createApp(options: { preview?: boolean } = {}): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
    preview: options.preview,
    logger: options.preview ? false : undefined,
  });
  return configureApp(app);
}
