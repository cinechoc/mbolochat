import { Module } from '@nestjs/common';
import { E2eeController } from './e2ee.controller.js';
import { E2eeService } from './e2ee.service.js';

@Module({
  controllers: [E2eeController],
  providers: [E2eeService],
  exports: [E2eeService],
})
export class E2eeModule {}
