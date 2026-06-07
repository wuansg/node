import { ProcessInfo } from '@kastov/node-supervisord/dist/interfaces';
import { SupervisordClient } from '@kastov/node-supervisord';
import { readPackageJSON } from 'pkg-types';
import { table } from 'table';
import ems from 'enhanced-ms';
import pRetry from 'p-retry';
import semver from 'semver';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';

import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { ConfigService } from '@nestjs/config';

import { InjectSupervisord } from '@remnawave/supervisord-nestjs';
import { InjectXtls } from '@remnawave/xtls-sdk-nestjs';
import { XtlsApi } from '@remnawave/xtls-sdk';

import { getSystemInfo, getSystemStats } from '@common/utils/get-system-stats';
import { ICommandResponse } from '@common/types/command-response.type';
import { generateApiConfig } from '@common/utils/generate-api-config';
import { KNOWN_ERRORS, REMNAWAVE_NODE_KNOWN_ERROR } from '@libs/contracts/constants';
import { StartXrayCommand } from '@libs/contracts/commands';

import {
    GetNodeHealthCheckResponseModel,
    StartXrayResponseModel,
    StopXrayResponseModel,
} from './models';
import { GetInterfaceStatsQuery } from '../network-stats/queries/get-interface-stats/get-interface-stats.query';
import { ResetPluginsCommand } from '../_plugin/commands/reset-plugins/reset-plugins.command';
import { GetTorrentBlockerStateQuery } from '../_plugin/queries/get-torrent-blocker-state';
import { InternalService } from '../internal/internal.service';

const XRAY_PROCESS_NAME = 'xray' as const;
const SING_BOX_PROCESS_NAME = 'sing-box' as const;
const SING_BOX_CONFIG_PATH = '/run/remnawave/sing-box.json' as const;
const execFileAsync = promisify(execFile);

@Injectable()
export class XrayService implements OnApplicationBootstrap {
    private readonly logger = new Logger(XrayService.name);
    private readonly disableHashedSetCheck: boolean;
    private readonly internal: {
        socketPath: string;
        token: string;
    };

    private readonly xrayPath: string;
    private readonly singBoxPath: string;

    private xrayVersion: null | string = null;
    private singBoxVersion: null | string = null;
    private runningCore: 'SING_BOX' | 'XRAY' | null = null;
    private isXrayOnline: boolean = false;
    private isSingBoxOnline: boolean = false;
    private isXrayStartedProccesing: boolean = false;
    private nodeVersion: string = '0.0.0';
    constructor(
        @InjectXtls() private readonly xtlsSdk: XtlsApi,
        @InjectSupervisord() private readonly supervisordApi: SupervisordClient,
        private readonly internalService: InternalService,
        private readonly configService: ConfigService,
        private readonly queryBus: QueryBus,
        private readonly commandBus: CommandBus,
    ) {
        this.internal = {
            socketPath: this.configService.getOrThrow<string>('INTERNAL_SOCKET_PATH'),
            token: this.configService.getOrThrow<string>('INTERNAL_REST_TOKEN'),
        };

        this.xrayPath = '/usr/local/bin/xray';
        this.singBoxPath = '/usr/local/bin/sing-box';
        this.xrayVersion = null;
        this.singBoxVersion = null;

        this.isXrayStartedProccesing = false;
        this.disableHashedSetCheck = this.configService.getOrThrow<boolean>(
            'DISABLE_HASHED_SET_CHECK',
        );
    }

    async onApplicationBootstrap() {
        try {
            const pkg = await readPackageJSON();

            this.xrayVersion = this.getXrayVersionFromEnv();
            this.singBoxVersion = await this.getSingBoxVersion();
            this.nodeVersion = pkg.version ?? '0.0.0';

            await this.supervisordApi.getState();
        } catch (error: unknown) {
            if (
                error !== null &&
                typeof error === 'object' &&
                'code' in error &&
                error.code === 'ENOENT'
            ) {
                this.logger.error('Supervisord socket file not found, exiting...');
                process.exit(1);
            }

            this.logger.error(`Error in Application Bootstrap: ${error}`);
        }

        this.isXrayOnline = false;
    }

    public async startXray(
        body: StartXrayCommand.Request,
        ip: string,
    ): Promise<ICommandResponse<StartXrayResponseModel>> {
        const interfaceStats = await this.queryBus.execute(new GetInterfaceStatsQuery());
        const tm = performance.now();
        const system = {
            info: getSystemInfo(),
            stats: getSystemStats(),
            interface: interfaceStats,
        };

        if (body.coreType === 'SING_BOX') {
            return this.startSingBox(body, ip, system, tm);
        }

        try {
            if (!body.xrayConfig) {
                throw new Error('xrayConfig is required for XRAY core');
            }

            if (this.isXrayStartedProccesing) {
                this.logger.warn('Request already in progress');
                return {
                    isOk: true,
                    response: new StartXrayResponseModel(
                        false,
                        this.xrayVersion,
                        'Request already in progress',
                        {
                            version: this.nodeVersion,
                        },
                        system,
                    ),
                };
            }

            this.isXrayStartedProccesing = true;

            if (this.isXrayOnline && !this.disableHashedSetCheck && !body.internals.forceRestart) {
                const { isOk } = await this.xtlsSdk.stats.getSysStats();

                let shouldRestart = false;

                if (isOk) {
                    shouldRestart = this.internalService.isNeedRestartCore(body.internals.hashes);
                } else {
                    this.isXrayOnline = false;
                    shouldRestart = true;

                    this.logger.warn(`Xray Core health check failed, restarting...`);
                }

                if (!shouldRestart) {
                    return {
                        isOk: true,
                        response: new StartXrayResponseModel(
                            true,
                            this.xrayVersion,
                            null,
                            {
                                version: this.nodeVersion,
                            },
                            system,
                        ),
                    };
                }
            }

            await this.stopSingBoxProcess();

            if (body.internals.forceRestart) {
                this.logger.warn('Force restart requested');
            }

            const isTorrentBlockerEnabled = await this.queryBus.execute(
                new GetTorrentBlockerStateQuery(),
            );

            const fullConfig = generateApiConfig({
                config: body.xrayConfig,
                torrentBlockerState: isTorrentBlockerEnabled,
                internal: this.internal,
            });

            await this.internalService.extractUsersFromConfig(body.internals.hashes, fullConfig);

            const xrayProcess = await this.restartXrayProcess();

            if (xrayProcess.error) {
                if (xrayProcess.error.includes('XML-RPC fault: SPAWN_ERROR: xray')) {
                    this.logger.error(REMNAWAVE_NODE_KNOWN_ERROR, {
                        timestamp: new Date().toISOString(),
                        rawError: xrayProcess.error,
                        ...KNOWN_ERRORS.XRAY_FAILED_TO_START,
                    });
                } else {
                    this.logger.error(xrayProcess.error);
                }

                return {
                    isOk: true,
                    response: new StartXrayResponseModel(
                        false,
                        null,
                        xrayProcess.error,
                        {
                            version: this.nodeVersion,
                        },
                        system,
                    ),
                };
            }

            let isStarted = await this.getXrayInternalStatus();

            if (!isStarted && xrayProcess.processInfo!.state === 20) {
                isStarted = await this.getXrayInternalStatus();
            }

            if (!isStarted) {
                this.isXrayOnline = false;

                this.logger.error(
                    '\n' +
                        table(
                            [
                                ['Version', this.xrayVersion],
                                ['Master IP', ip],
                                ['Internal Status', isStarted],
                                ['Error', xrayProcess.error],
                            ],
                            {
                                header: {
                                    content: 'Xray failed to start',
                                    alignment: 'center',
                                },
                            },
                        ),
                );

                return {
                    isOk: true,
                    response: new StartXrayResponseModel(
                        isStarted,
                        this.xrayVersion,
                        xrayProcess.error,
                        {
                            version: this.nodeVersion,
                        },
                        system,
                    ),
                };
            }

            this.isXrayOnline = true;
            this.isSingBoxOnline = false;
            this.runningCore = 'XRAY';

            this.logger.log(
                '\n' +
                    table(
                        [
                            ['Version', this.xrayVersion],
                            ['Master IP', ip],
                        ],
                        {
                            header: {
                                content: 'Xray started',
                                alignment: 'center',
                            },
                        },
                    ),
            );

            return {
                isOk: true,
                response: new StartXrayResponseModel(
                    isStarted,
                    this.xrayVersion,
                    null,
                    {
                        version: this.nodeVersion,
                    },
                    system,
                    'XRAY',
                    {
                        xray: this.xrayVersion,
                        singBox: this.singBoxVersion,
                    },
                ),
            };
        } catch (error) {
            let errorMessage = null;
            if (error instanceof Error) {
                errorMessage = error.message;
            }

            this.logger.error(`Failed to start Xray: ${errorMessage}`);

            return {
                isOk: true,
                response: new StartXrayResponseModel(
                    false,
                    null,
                    errorMessage,
                    {
                        version: this.nodeVersion,
                    },
                    system,
                    'XRAY',
                    {
                        xray: null,
                        singBox: this.singBoxVersion,
                    },
                ),
            };
        } finally {
            this.logger.log(
                'Attempt to start XTLS took: ' +
                    ems(performance.now() - tm, {
                        extends: 'short',
                        includeMs: true,
                    }),
            );

            this.isXrayStartedProccesing = false;
        }
    }

    public async stopXray(args: {
        withPluginCleanup?: boolean;
        withOnlineCheck?: boolean;
    }): Promise<ICommandResponse<StopXrayResponseModel>> {
        const { withPluginCleanup = false, withOnlineCheck = false } = args;
        try {
            if (withPluginCleanup) {
                await this.commandBus.execute(new ResetPluginsCommand());
            }

            if (withOnlineCheck && !this.isXrayOnline) {
                return {
                    isOk: true,
                    response: new StopXrayResponseModel(true),
                };
            }

            await this.killAllXrayProcesses();
            await this.stopSingBoxProcess();

            this.isXrayOnline = false;
            this.isSingBoxOnline = false;
            this.runningCore = null;
            this.internalService.cleanup();

            return {
                isOk: true,
                response: new StopXrayResponseModel(true),
            };
        } catch (error) {
            this.logger.error(`Failed to stop Xray Process: ${error}`);
            return {
                isOk: true,
                response: new StopXrayResponseModel(false),
            };
        }
    }

    public async getNodeHealthCheck(): Promise<ICommandResponse<GetNodeHealthCheckResponseModel>> {
        try {
            return {
                isOk: true,
                response: new GetNodeHealthCheckResponseModel(
                    true,
                    this.runningCore === 'XRAY' ? this.isXrayOnline : this.isSingBoxOnline,
                    this.xrayVersion,
                    this.nodeVersion,
                    this.runningCore,
                    {
                        xray: this.xrayVersion,
                        singBox: this.singBoxVersion,
                    },
                ),
            };
        } catch (error) {
            this.logger.error(`Failed to get node health check: ${error}`);

            return {
                isOk: true,
                response: new GetNodeHealthCheckResponseModel(
                    false,
                    false,
                    null,
                    this.nodeVersion,
                    this.runningCore,
                    {
                        xray: this.xrayVersion,
                        singBox: this.singBoxVersion,
                    },
                ),
            };
        }
    }

    public async killAllXrayProcesses(): Promise<void> {
        try {
            await this.supervisordApi.stopProcess(XRAY_PROCESS_NAME, true);

            this.logger.log('Supervisord: Xray processes killed.');
        } catch (error) {
            this.logger.log(`Supervisord: No existing Xray processes found. Error: ${error}`);
        }
    }

    public getRunningCore(): 'SING_BOX' | 'XRAY' | null {
        return this.runningCore;
    }

    private async startSingBox(
        body: StartXrayCommand.Request,
        ip: string,
        system: StartXrayResponseModel['system'],
        tm: number,
    ): Promise<ICommandResponse<StartXrayResponseModel>> {
        try {
            if (!body.singBoxConfig) {
                throw new Error('singBoxConfig is required for SING_BOX core');
            }

            if (this.isXrayStartedProccesing) {
                return {
                    isOk: true,
                    response: new StartXrayResponseModel(
                        false,
                        this.singBoxVersion,
                        'Request already in progress',
                        { version: this.nodeVersion },
                        system,
                        'SING_BOX',
                        {
                            xray: this.xrayVersion,
                            singBox: this.singBoxVersion,
                        },
                    ),
                };
            }

            this.isXrayStartedProccesing = true;

            await this.killAllXrayProcesses();
            const singBoxConfig = this.generateSingBoxApiConfig(body.singBoxConfig);

            await mkdir('/run/remnawave', { recursive: true });
            await writeFile(SING_BOX_CONFIG_PATH, JSON.stringify(singBoxConfig), 'utf-8');

            await this.internalService.extractUsersFromSingBoxConfig(
                body.internals.hashes,
                singBoxConfig,
            );

            const process = await this.restartSingBoxProcess();

            if (process.error) {
                return {
                    isOk: true,
                    response: new StartXrayResponseModel(
                        false,
                        this.singBoxVersion,
                        process.error,
                        { version: this.nodeVersion },
                        system,
                        'SING_BOX',
                        {
                            xray: this.xrayVersion,
                            singBox: this.singBoxVersion,
                        },
                    ),
                };
            }

            this.isXrayOnline = false;
            this.isSingBoxOnline = true;
            this.runningCore = 'SING_BOX';

            this.logger.log(
                '\n' +
                    table(
                        [
                            ['Version', this.singBoxVersion],
                            ['Master IP', ip],
                        ],
                        {
                            header: {
                                content: 'sing-box started',
                                alignment: 'center',
                            },
                        },
                    ),
            );

            return {
                isOk: true,
                response: new StartXrayResponseModel(
                    true,
                    this.singBoxVersion,
                    null,
                    { version: this.nodeVersion },
                    system,
                    'SING_BOX',
                    {
                        xray: this.xrayVersion,
                        singBox: this.singBoxVersion,
                    },
                ),
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.logger.error(`Failed to start sing-box: ${errorMessage}`);

            return {
                isOk: true,
                response: new StartXrayResponseModel(
                    false,
                    this.singBoxVersion,
                    errorMessage,
                    { version: this.nodeVersion },
                    system,
                    'SING_BOX',
                    {
                        xray: this.xrayVersion,
                        singBox: this.singBoxVersion,
                    },
                ),
            };
        } finally {
            this.logger.log(
                'Attempt to start sing-box took: ' +
                    ems(performance.now() - tm, {
                        extends: 'short',
                        includeMs: true,
                    }),
            );
            this.isXrayStartedProccesing = false;
        }
    }

    private async stopSingBoxProcess(): Promise<void> {
        try {
            await this.supervisordApi.stopProcess(SING_BOX_PROCESS_NAME, true);
            this.logger.log('Supervisord: sing-box process stopped.');
        } catch (error) {
            this.logger.log(`Supervisord: No existing sing-box process found. Error: ${error}`);
        }
    }

    private async restartSingBoxProcess(): Promise<{
        processInfo: ProcessInfo | null;
        error: string | null;
    }> {
        try {
            const processState = await this.supervisordApi.getProcessInfo(SING_BOX_PROCESS_NAME);

            if (processState.state === 20) {
                await this.supervisordApi.stopProcess(SING_BOX_PROCESS_NAME, true);
            }

            await this.supervisordApi.startProcess(SING_BOX_PROCESS_NAME, true);

            return {
                processInfo: await this.supervisordApi.getProcessInfo(SING_BOX_PROCESS_NAME),
                error: null,
            };
        } catch (error) {
            return {
                processInfo: null,
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    }

    private generateSingBoxApiConfig(config: Record<string, unknown>): Record<string, unknown> {
        const inbounds = Array.isArray(config.inbounds) ? config.inbounds : [];
        const outbounds = Array.isArray(config.outbounds) ? config.outbounds : [];
        const statsInbounds: string[] = [];
        const statsOutbounds: string[] = [];
        const statsUsers: string[] = [];

        for (const inbound of inbounds) {
            if (!inbound || typeof inbound !== 'object') continue;

            const item = inbound as {
                tag?: string;
                users?: Array<{ name?: string }>;
            };

            if (item.tag) {
                statsInbounds.push(item.tag);
            }

            if (Array.isArray(item.users)) {
                for (const user of item.users) {
                    if (user.name) {
                        statsUsers.push(user.name);
                    }
                }
            }
        }

        for (const outbound of outbounds) {
            if (!outbound || typeof outbound !== 'object') continue;

            const item = outbound as { tag?: string };
            if (item.tag) {
                statsOutbounds.push(item.tag);
            }
        }

        return {
            ...config,
            experimental: {
                ...((config.experimental as Record<string, unknown> | undefined) ?? {}),
                v2ray_api: {
                    listen: `127.0.0.1:${this.configService.get<number>('SING_BOX_API_PORT') ?? 61001}`,
                    stats: {
                        enabled: true,
                        inbounds: statsInbounds,
                        outbounds: statsOutbounds,
                        users: statsUsers,
                    },
                },
            },
        };
    }

    private async getSingBoxVersion(): Promise<null | string> {
        try {
            const { stdout } = await execFileAsync(this.singBoxPath, ['version']);
            const version = semver.valid(semver.coerce(stdout));
            return version ?? stdout.split('\n')[0]?.trim() ?? null;
        } catch {
            return null;
        }
    }

    private getXrayVersionFromEnv(): null | string {
        const version = semver.valid(semver.coerce(process.env.XRAY_CORE_VERSION));

        if (version) {
            this.xrayVersion = version;
        }

        return version;
    }

    public getXrayInfo(): {
        version: string | null;
        path: string;
    } {
        const version = this.getXrayVersionFromEnv();

        if (version) {
            this.xrayVersion = version;
        }

        return {
            version: version,
            path: this.xrayPath,
        };
    }

    private async getXrayInternalStatus(): Promise<boolean> {
        try {
            return await pRetry(
                async () => {
                    const { isOk, message } = await this.xtlsSdk.stats.getSysStats();

                    if (!isOk) {
                        throw new Error(message);
                    }

                    return true;
                },
                {
                    retries: 10,
                    minTimeout: 2000,
                    maxTimeout: 2000,
                    onFailedAttempt: (error) => {
                        this.logger.debug(
                            `Get Xray internal status attempt ${error.attemptNumber} failed. ${error.retriesLeft} retries left.`,
                        );
                    },
                },
            );
        } catch (error) {
            this.logger.error(`Failed to get Xray internal status: ${error}`);
            return false;
        }
    }

    private async restartXrayProcess(): Promise<{
        processInfo: ProcessInfo | null;
        error: string | null;
    }> {
        try {
            const processState = await this.supervisordApi.getProcessInfo(XRAY_PROCESS_NAME);

            // Reference: https://supervisord.org/subprocess.html#process-states
            if (processState.state === 20) {
                await this.supervisordApi.stopProcess(XRAY_PROCESS_NAME, true);
            }

            await this.supervisordApi.startProcess(XRAY_PROCESS_NAME, true);

            return {
                processInfo: await this.supervisordApi.getProcessInfo(XRAY_PROCESS_NAME),
                error: null,
            };
        } catch (error) {
            return {
                processInfo: null,
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    }
}
