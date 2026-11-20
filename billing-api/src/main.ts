import 'reflect-metadata';

import { Logger } from '@nestjs/common';

import { createApp, mountSwagger } from './app';
import { getSettings } from './config';

async function main(): Promise<void> {
  const app = await createApp();
  mountSwagger(app);
  app.enableShutdownHooks();
  const { port } = getSettings();
  await app.listen(port, '0.0.0.0');
  Logger.log(`Billing API on http://localhost:${port}/api/v1 (Swagger UI at /docs)`, 'Bootstrap');
}

void main();
