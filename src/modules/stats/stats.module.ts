import { CqrsModule } from '@nestjs/cqrs';
import { Module } from '@nestjs/common';

import { StatsController } from './stats.controller';
import { SingBoxStatsService } from './sing-box/sing-box-stats.service';
import { StatsService } from './stats.service';
import { XrayModule } from '../xray-core/xray.module';
@Module({
    imports: [CqrsModule, XrayModule],
    providers: [StatsService, SingBoxStatsService],
    controllers: [StatsController],
})
export class StatsModule {}
