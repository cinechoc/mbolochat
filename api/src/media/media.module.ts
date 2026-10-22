import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MediaController } from './media.controller.js';
import { MediaService } from './media.service.js';
import { MediaUrlInterceptor } from './media-url.interceptor.js';

/**
 * Lecture des médias importés par les utilisateurs. Fournit aussi le service de
 * signature aux modules qui renvoient des chemins d'images, et l'intercepteur
 * qui signe tout ce qui sort de l'API.
 */
@Module({
  controllers: [MediaController],
  providers: [
    MediaService,
    { provide: APP_INTERCEPTOR, useClass: MediaUrlInterceptor },
  ],
  exports: [MediaService],
})
export class MediaModule {}
