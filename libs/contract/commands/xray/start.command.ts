import { z } from 'zod';

import { NodeSystemSchema } from '../../models';
import { REST_API } from '../../api';

export namespace StartXrayCommand {
    export const url = REST_API.XRAY.START;
    export const CoreTypeSchema = z.enum(['XRAY', 'SING_BOX']);

    export const RequestSchema = z.object({
        coreType: CoreTypeSchema.default('XRAY'),
        internals: z.object({
            forceRestart: z.boolean().default(false),
            hashes: z.object({
                emptyConfig: z.string(),
                inbounds: z.array(
                    z.object({
                        usersCount: z.number(),
                        hash: z.string(),
                        tag: z.string(),
                    }),
                ),
            }),
        }),
        xrayConfig: z.record(z.unknown()).optional(),
        singBoxConfig: z.record(z.unknown()).optional(),
    });

    export type Request = z.infer<typeof RequestSchema>;

    export const ResponseSchema = z.object({
        response: z.object({
            isStarted: z.boolean(),
            version: z.string().nullable(),
            runningCore: CoreTypeSchema.optional(),
            coreVersions: z
                .object({
                    xray: z.string().nullable(),
                    singBox: z.string().nullable(),
                })
                .optional(),
            error: z.string().nullable(),
            nodeInformation: z.object({
                version: z.string().nullable(),
            }),
            system: NodeSystemSchema,
        }),
    });

    export type Response = z.infer<typeof ResponseSchema>;
}
