import { CqrsModule } from '@nestjs/cqrs';
import { Module } from '@nestjs/common';

import { SingBoxStatsService } from './sing-box/sing-box-stats.service';
import { XrayModule } from '../xray-core/xray.module';
import { StatsController } from './stats.controller';
import { StatsService } from './stats.service';
@Module({
    imports: [CqrsModule, XrayModule],
    providers: [StatsService, SingBoxStatsService],
    controllers: [StatsController],
})
export class StatsModule {}
