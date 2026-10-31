import { Module } from '@nestjs/common';
import { UsersController } from './users.controller.js';
import { GeocodingService } from './geocoding.service.js';
import { UsersService } from './users.service.js';

@Module({
  controllers: [UsersController],
  providers: [UsersService, GeocodingService],
  exports: [UsersService],
})
export class UsersModule {}
