import { loadSync } from '@grpc/proto-loader';
import * as grpc from '@grpc/grpc-js';
import { join } from 'node:path';

import { ConfigService } from '@nestjs/config';
import { Injectable } from '@nestjs/common';

import { IInboundStat, IOutboundStat, IUserStat } from '../models/interfaces';

interface RawStat {
    name: string;
    value: number | string | { toNumber?: () => number };
}

interface RawQueryStatsResponse {
    stat?: RawStat[];
}

interface RawGetStatsResponse {
    stat?: RawStat;
}

interface RawSysStatsResponse {
    numGoroutine?: number;
    num_goroutine?: number;
    numGc?: number;
    num_gc?: number;
    numGC?: number;
    alloc?: number;
    totalAlloc?: number;
    total_alloc?: number;
    sys?: number;
    mallocs?: number;
    frees?: number;
    liveObjects?: number;
    live_objects?: number;
    pauseTotalNs?: number;
    pause_total_ns?: number;
    uptime?: number;
}

type GrpcCallback<T> = (error: grpc.ServiceError | null, response: T) => void;

interface StatsClient {
    getStats(
        request: { name: string; reset: boolean },
        callback: GrpcCallback<RawGetStatsResponse>,
    ): void;
    queryStats(
        request: { pattern: string; reset: boolean },
        callback: GrpcCallback<RawQueryStatsResponse>,
    ): void;
    getSysStats(request: Record<string, never>, callback: GrpcCallback<RawSysStatsResponse>): void;
    close(): void;
}

@Injectable()
export class SingBoxStatsService {
    private readonly client: StatsClient;

    constructor(private readonly configService: ConfigService) {
        const protoPath = join(__dirname, 'v2ray-stats.proto');
        const packageDefinition = loadSync(protoPath, {
            defaults: true,
            enums: String,
            keepCase: false,
            longs: Number,
            oneofs: true,
        });
        const descriptor = grpc.loadPackageDefinition(packageDefinition) as unknown as {
            v2ray: {
                core: {
                    app: {
                        stats: {
                            command: {
                                StatsService: new (
                                    target: string,
                                    credentials: grpc.ChannelCredentials,
                                ) => StatsClient;
                            };
                        };
                    };
                };
            };
        };

        const port = this.configService.get<number>('SING_BOX_API_PORT') ?? 61001;
        this.client = new descriptor.v2ray.core.app.stats.command.StatsService(
            `127.0.0.1:${port}`,
            grpc.credentials.createInsecure(),
        );
    }

    public async getSysStats(): Promise<RawSysStatsResponse> {
        return this.call((callback) => this.client.getSysStats({}, callback));
    }

    public async getUserOnlineStatus(username: string): Promise<boolean> {
        const stat = await this.getStat(`user>>>${username}>>>traffic>>>uplink`, false);
        return !!stat;
    }

    public async getAllUsersStats(reset: boolean): Promise<IUserStat[]> {
        const stats = await this.queryStats('user>>>', reset);
        const grouped = new Map<string, IUserStat>();

        for (const stat of stats) {
            const parsed = this.parseNamedStat(stat.name);
            if (!parsed || parsed.kind !== 'user') continue;

            const current = grouped.get(parsed.tag) ?? {
                username: parsed.tag,
                uplink: 0,
                downlink: 0,
            };
            current[parsed.direction] += this.toNumber(stat.value);
            grouped.set(parsed.tag, current);
        }

        return Array.from(grouped.values()).filter(
            (user) => user.uplink !== 0 || user.downlink !== 0,
        );
    }

    public async getInboundStats(tag: string, reset: boolean): Promise<IInboundStat> {
        return {
            inbound: tag,
            uplink: await this.getStat(`inbound>>>${tag}>>>traffic>>>uplink`, reset),
            downlink: await this.getStat(`inbound>>>${tag}>>>traffic>>>downlink`, reset),
        };
    }

    public async getOutboundStats(tag: string, reset: boolean): Promise<IOutboundStat> {
        return {
            outbound: tag,
            uplink: await this.getStat(`outbound>>>${tag}>>>traffic>>>uplink`, reset),
            downlink: await this.getStat(`outbound>>>${tag}>>>traffic>>>downlink`, reset),
        };
    }

    public async getAllInboundStats(reset: boolean): Promise<IInboundStat[]> {
        const stats = await this.queryStats('inbound>>>', reset);
        const grouped = new Map<string, IInboundStat>();

        for (const stat of stats) {
            const parsed = this.parseNamedStat(stat.name);
            if (!parsed || parsed.kind !== 'inbound') continue;

            const current = grouped.get(parsed.tag) ?? {
                inbound: parsed.tag,
                uplink: 0,
                downlink: 0,
            };
            current[parsed.direction] += this.toNumber(stat.value);
            grouped.set(parsed.tag, current);
        }

        return Array.from(grouped.values());
    }

    public async getAllOutboundStats(reset: boolean): Promise<IOutboundStat[]> {
        const stats = await this.queryStats('outbound>>>', reset);
        const grouped = new Map<string, IOutboundStat>();

        for (const stat of stats) {
            const parsed = this.parseNamedStat(stat.name);
            if (!parsed || parsed.kind !== 'outbound') continue;

            const current = grouped.get(parsed.tag) ?? {
                outbound: parsed.tag,
                uplink: 0,
                downlink: 0,
            };
            current[parsed.direction] += this.toNumber(stat.value);
            grouped.set(parsed.tag, current);
        }

        return Array.from(grouped.values());
    }

    private async getStat(name: string, reset: boolean): Promise<number> {
        const response = await this.call<RawGetStatsResponse>((callback) =>
            this.client.getStats({ name, reset }, callback),
        );
        return this.toNumber(response.stat?.value ?? 0);
    }

    private async queryStats(pattern: string, reset: boolean): Promise<RawStat[]> {
        const response = await this.call<RawQueryStatsResponse>((callback) =>
            this.client.queryStats({ pattern, reset }, callback),
        );
        return response.stat ?? [];
    }

    private call<T>(handler: (callback: GrpcCallback<T>) => void): Promise<T> {
        return new Promise((resolve, reject) => {
            handler((error, response) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve(response);
            });
        });
    }

    private parseNamedStat(name: string): {
        kind: 'inbound' | 'outbound' | 'user';
        tag: string;
        direction: 'downlink' | 'uplink';
    } | null {
        const match = /^(inbound|outbound|user)>>>(.+?)>>>traffic>>>(uplink|downlink)$/.exec(name);
        if (!match) return null;

        return {
            kind: match[1] as 'inbound' | 'outbound' | 'user',
            tag: match[2],
            direction: match[3] as 'downlink' | 'uplink',
        };
    }

    private toNumber(value: RawStat['value']): number {
        if (typeof value === 'number') return value;
        if (typeof value === 'string') return Number(value);
        if (value && typeof value.toNumber === 'function') return value.toNumber();
        return 0;
    }
}
