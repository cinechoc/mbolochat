import { Module } from '@nestjs/common';
import { UploadsController } from './uploads.controller.js';
import { UploadRetentionService } from './uploads-retention.service.js';
import { UploadsService } from './uploads.service.js';

@Module({
  controllers: [UploadsController],
  providers: [UploadsService, UploadRetentionService],
  exports: [UploadsService],
})
export class UploadsModule {}
