import { z } from 'zod';

import { REST_API } from '../../api';

export namespace GetNodeHealthCheckCommand {
    export const url = REST_API.XRAY.NODE_HEALTH_CHECK;
    export const CoreTypeSchema = z.enum(['XRAY', 'SING_BOX']);

    export const ResponseSchema = z.object({
        response: z.object({
            isAlive: z.boolean(),
            xrayInternalStatusCached: z.boolean(),
            xrayVersion: z.string().nullable(),
            runningCore: CoreTypeSchema.nullable().optional(),
            supportedCores: z.array(CoreTypeSchema).optional(),
            coreVersions: z
                .object({
                    xray: z.string().nullable(),
                    singBox: z.string().nullable(),
                })
                .optional(),
            nodeVersion: z.string(),
        }),
    });

    export type Response = z.infer<typeof ResponseSchema>;
}
