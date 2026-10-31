import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { JwtPayload } from '../auth/jwt-payload.js';
import { E2eeService, type PublicPrekey, type RegisterDeviceBody } from './e2ee.service.js';

@Controller('e2ee')
@UseGuards(JwtAuthGuard)
export class E2eeController {
  constructor(private readonly e2eeService: E2eeService) {}

  @Get('status')
  status(@CurrentUser() current: JwtPayload) {
    return this.e2eeService.status(current);
  }

  @Post('devices')
  register(@CurrentUser() current: JwtPayload, @Body() body: RegisterDeviceBody) {
    return this.e2eeService.registerDevice(current, body);
  }

  @Post('devices/prekeys')
  addPrekeys(
    @CurrentUser() current: JwtPayload,
    @Body() body: { oneTimeKeys?: PublicPrekey[] },
  ) {
    return this.e2eeService.addPrekeys(current, body?.oneTimeKeys ?? []);
  }

  @Delete('devices')
  revoke(@CurrentUser() current: JwtPayload) {
    return this.e2eeService.revokeCurrentDevice(current);
  }

  @Get('users/:id/keys')
  keys(@CurrentUser() current: JwtPayload, @Param('id') userId: string) {
    return this.e2eeService.getKeyBundle(current, userId);
  }
}
