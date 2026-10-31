import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { toPublicUser, UsersService } from '../users/users.service.js';
import { AuthService } from './auth.service.js';
import { CurrentUser } from './current-user.decorator.js';
import { ForgotPasswordDto } from './dto/forgot-password.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { RegisterDto } from './dto/register.dto.js';
import { ResetPasswordDto } from './dto/reset-password.dto.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import type { JwtPayload } from './jwt-payload.js';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly usersService: UsersService,
  ) {}

  @Post('register')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  register(
    @Body() dto: RegisterDto,
    @Headers('x-device-name') deviceName?: string,
    @Headers('x-platform') platform?: string,
  ) {
    return this.authService.register(dto, { name: deviceName, platform });
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  login(
    @Body() dto: LoginDto,
    @Headers('x-device-name') deviceName?: string,
    @Headers('x-platform') platform?: string,
  ) {
    return this.authService.login(dto, { name: deviceName, platform });
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  refresh(@Body() body: { refreshToken?: string }) {
    return this.authService.refresh(body?.refreshToken ?? '');
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  async logout(@Body() body: { refreshToken?: string }) {
    await this.authService.logout(body?.refreshToken);
  }

  /**
   * Ces deux routes sont celles qu'on bombarde : l'une pour semer le code,
   * l'autre pour le deviner. Elles restent sous la main du serveur même si le
   * code est long à vérifier.
   */
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  /** Appareils connectés (sessions de rafraîchissement encore valides). */
  @Get('sessions')
  @UseGuards(JwtAuthGuard)
  sessions(@CurrentUser() current: JwtPayload) {
    return this.authService.listSessions(current.sub);
  }

  /** Déconnexion à distance d'un appareil précis. */
  @Delete('sessions/:id')
  @UseGuards(JwtAuthGuard)
  revokeSession(@CurrentUser() current: JwtPayload, @Param('id') id: string) {
    return this.authService.revokeSession(current.sub, id);
  }

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  changePassword(
    @CurrentUser() current: JwtPayload,
    @Body() body: { currentPassword?: string; newPassword?: string },
  ) {
    return this.authService.changePassword(
      current.sub,
      body?.currentPassword ?? '',
      body?.newPassword ?? '',
    );
  }

  /** Suppression différée : 30 jours pour revenir, puis anonymisation. */
  @Delete('account')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  deleteAccount(@CurrentUser() current: JwtPayload, @Body() body: { password?: string }) {
    return this.authService.requestAccountDeletion(current.sub, body?.password ?? '');
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@CurrentUser() current: JwtPayload) {
    const user = await this.usersService.getByIdOrThrow(current.sub);
    return toPublicUser(user);
  }
}
