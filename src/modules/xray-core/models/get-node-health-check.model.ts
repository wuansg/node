export class GetNodeHealthCheckResponseModel {
    public isAlive: boolean;
    public xrayInternalStatusCached: boolean;
    public xrayVersion: null | string;
    public runningCore: 'SING_BOX' | 'XRAY' | null;
    public supportedCores: ('SING_BOX' | 'XRAY')[];
    public coreVersions: {
        xray: null | string;
        singBox: null | string;
    };
    public nodeVersion: string;
    constructor(
        isAlive: boolean,
        xrayInternalStatusCached: boolean,
        xrayVersion: null | string,
        nodeVersion: string,
        runningCore: 'SING_BOX' | 'XRAY' | null = null,
        coreVersions: { singBox: null | string; xray: null | string } = {
            xray: xrayVersion,
            singBox: null,
        },
    ) {
        this.isAlive = isAlive;
        this.xrayInternalStatusCached = xrayInternalStatusCached;
        this.xrayVersion = xrayVersion;
        this.runningCore = runningCore;
        this.supportedCores = ['XRAY', 'SING_BOX'];
        this.coreVersions = coreVersions;
        this.nodeVersion = nodeVersion;
    }
}
