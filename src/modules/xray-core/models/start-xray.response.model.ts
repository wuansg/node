import { TNodeSystem } from '@libs/contracts/models';

interface INodeInformation {
    version: string | null;
}

type CoreType = 'SING_BOX' | 'XRAY';

export class StartXrayResponseModel {
    public isStarted: boolean;
    public version: null | string;
    public runningCore: CoreType;
    public coreVersions: {
        xray: null | string;
        singBox: null | string;
    };
    public error: null | string;
    public nodeInformation: INodeInformation;
    public system: TNodeSystem;

    constructor(
        isStarted: boolean,
        version: null | string,
        error: null | string,
        nodeInformation: INodeInformation,
        system: TNodeSystem,
        runningCore: CoreType = 'XRAY',
        coreVersions: { singBox: null | string; xray: null | string } = {
            xray: version,
            singBox: null,
        },
    ) {
        this.isStarted = isStarted;
        this.version = version;
        this.runningCore = runningCore;
        this.coreVersions = coreVersions;
        this.error = error;
        this.nodeInformation = nodeInformation;
        this.system = system;
    }
}
