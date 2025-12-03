import {MESSAGE_PREFIXES} from './constants.js';

/**
 * Parsed message types
 */
export type ParsedMessage =
    | {type: 'ready'}
    | {type: 'version'; status: number; name: string; keyBitmask: string; version: string}
    | {type: 'address'; status: number; ieee: string; networkAddress: number}
    | {type: 'deviceAnnounce'; networkAddress: number; ieee: string; capability: number}
    | {type: 'nodeDescRsp'; seq: number; networkAddress: number; status: number; data: NodeDescriptor}
    | {type: 'activeEpRsp'; seq: number; networkAddress: number; status: number; endpoints: number[]}
    | {type: 'activeEpReq'; seq: number; endpoint: number}
    | {type: 'simpleDescRsp'; seq: number; networkAddress: number; status: number; data: SimpleDescriptor}
    | {type: 'zclInd'; source: {address: number; endpoint: number}; dest: {address: number; endpoint: number}; clusterId: number; payload: string}
    | {type: 'zclConf'; endpoint: number; sequence: number; status: number}
    | {type: 'zclReq'; status: number; sequence: number}
    | {type: 'joinPermitted'; permitted: boolean}
    | {type: 'networkSettings'; factoryNew: boolean; panId: number; extendedPanId: string; channel: number; nwkUpdateId: number; networkAddress: number}
    | {type: 'mgmtLqiRsp'; seq: number; srcAddr: number; status: number; startIndex: number; neighborTableEntries: number; neighborTableList: NeighborTableEntry[]}
    | {type: 'linkTouchlink'; shortAddress: number; endpoint: number}
    | {type: 'zdpIeeeAddrRsp'; seq: number; srcAddr: number; status: number; ieeeAddr: string; networkAddress: number}
    | {type: 'unknown'; raw: string};

export interface NeighborTableEntry {
    extendedPanId: string;
    ieeeAddr: string;
    networkAddress: number;
    linkQuality: number;
    depth: number;
    permitJoin: number;
    relationship: number;
    rxOnWhenIdle: number;
    deviceType: number;
}

export interface NodeDescriptor {
    logicalType: number;
    capability: number;
    manufacturerCode: number;
    maxBufferSize: number;
    maxTransferSize: number;
}

export interface SimpleDescriptor {
    endpoint: number;
    profileId: number;
    deviceId: number;
    inputClusters: number[];
    outputClusters: number[];
    length: number;
    deviceVersion: number;
}

/**
 * Parse incoming messages from the bridge
 */
export class MessageParser {
    /**
     * Parse a message line
     */
    static parse(message: string): ParsedMessage {
        // [TH,Ready,0]
        if (message.startsWith(MESSAGE_PREFIXES.TH_READY)) {
            return {type: 'ready'};
        }

        // [TH,GetSwVersion,0,ZigBeeBridgeHue-SAMR21-HueBridgeV2_1,0x0012,6.94.0.37486]
        if (message.startsWith(MESSAGE_PREFIXES.TH_GET_SW_VERSION)) {
            const parts = message.slice(1, -1).split(',');
            return {
                type: 'version',
                status: parseInt(parts[2]),
                name: parts[3],
                keyBitmask: parts[4],
                version: parts[5],
            };
        }

        // [Connection,GetAddress,0,L=00:17:88:01:05:2D:0A:B1,S=0x0000.0]
        if (message.startsWith(MESSAGE_PREFIXES.CONNECTION_GET_ADDRESS)) {
            const ieeeMatch = message.match(/L=([0-9A-F:]+)/i);
            const addrMatch = message.match(/S=0x([0-9A-F]+)/i);
            const parts = message.slice(1, -1).split(',');

            return {
                type: 'address',
                status: parseInt(parts[2]),
                ieee: ieeeMatch ? '0x' + ieeeMatch[1].replace(/:/g, '').toLowerCase() : '',
                networkAddress: addrMatch ? parseInt(addrMatch[1], 16) : 0,
            };
        }

        // [Zdp,ReceivedDeviceAnnounce,S=0x0003.0,L=A4:C1:38:E3:B9:14:32:8B,128]
        if (message.startsWith(MESSAGE_PREFIXES.ZDP_DEVICE_ANNOUNCE)) {
            const match = message.match(/S=0x([0-9A-F]+)\.0,L=([0-9A-F:]+),(\d+)/i);
            if (match) {
                return {
                    type: 'deviceAnnounce',
                    networkAddress: parseInt(match[1], 16),
                    ieee: '0x' + match[2].replace(/:/g, '').toLowerCase(),
                    capability: parseInt(match[3]),
                };
            }
        }

        // [Zdp,ReceivedNodeDescRsp,4,S=0x0002.0,128,3,7,True,True,4,0,22,1,38912,71,8192,1,0,2]
        if (message.startsWith(MESSAGE_PREFIXES.ZDP_NODE_DESC_RSP)) {
            const parts = message.slice(1, -1).split(',');
            const addrMatch = parts[3].match(/S=0x([0-9A-F]+)/i);

            return {
                type: 'nodeDescRsp',
                seq: parseInt(parts[2]),
                networkAddress: addrMatch ? parseInt(addrMatch[1], 16) : 0,
                status: parseInt(parts[4]),
                data: {
                    logicalType: parseInt(parts[6]),
                    capability: parseInt(parts[12]),
                    manufacturerCode: parseInt(parts[13]),
                    maxBufferSize: parseInt(parts[14]),
                    maxTransferSize: parseInt(parts[15]),
                },
            };
        }

        // [Zdp,ReceivedActiveEndPointRsp,97,S=0x0003.0,0,3,1,1]
        if (message.startsWith(MESSAGE_PREFIXES.ZDP_ACTIVE_EP_RSP)) {
            const parts = message.slice(1, -1).split(',');
            const addrMatch = parts[3].match(/S=0x([0-9A-F]+)/i);
            const count = parseInt(parts[6]);
            const endpoints = parts.slice(7, 7 + count).map((ep) => parseInt(ep));

            return {
                type: 'activeEpRsp',
                seq: parseInt(parts[2]),
                networkAddress: addrMatch ? parseInt(addrMatch[1], 16) : 0,
                status: parseInt(parts[4]),
                endpoints,
            };
        }

        // [Zdp,SendActiveEndPointReq,0,1]
        if (message.startsWith('[Zdp,SendActiveEndPointReq,')) {
            const parts = message.slice(1, -1).split(',');
            const endpoint = parseInt(parts[2]);
            const seq = parseInt(parts[3]);

            return {
                type: 'activeEpReq',
                seq,
                endpoint,
            };
        }

        // [Zdp,ReceivedSimpleDescRsp,1,S=0x0001.0,0,1,12,242,41440,97,0,0,1,33,1,33]
        if (message.startsWith(MESSAGE_PREFIXES.ZDP_SIMPLE_DESC_RSP)) {
            const parts = message.slice(1, -1).split(',');
            const addrMatch = parts[3].match(/S=0x([0-9A-F]+)/i);
            const length = parseInt(parts[6]);
            const endpoint = parseInt(parts[7]);
            const profileId = parseInt(parts[8]);
            const deviceId = parseInt(parts[9]);
            const deviceVersion = parseInt(parts[10]);
            const inClusterCount = parseInt(parts[12]);
            const inputClusters = parts.slice(13, 13 + inClusterCount).map((c) => parseInt(c));
            const outClusterCount = parseInt(parts[13 + inClusterCount]);
            const outputClusters = parts.slice(14 + inClusterCount, 14 + inClusterCount + outClusterCount).map((c) => parseInt(c));

            return {
                type: 'simpleDescRsp',
                seq: parseInt(parts[2]),
                networkAddress: addrMatch ? parseInt(addrMatch[1], 16) : 0,
                status: parseInt(parts[4]),
                data: {
                    endpoint,
                    profileId,
                    deviceId,
                    inputClusters,
                    outputClusters,
                    length,
                    deviceVersion,
                },
            };
        }

        // [Zcl,Ind,S=0x0003.1,S=0x0001.64,25,0139010015DB030201300011]
        if (message.startsWith(MESSAGE_PREFIXES.ZCL_IND)) {
            const match = message.match(/S=0x([0-9A-F]+)\.(\d+),S=0x([0-9A-F]+)\.(\d+),(\d+),([0-9A-F]+)/i);
            if (match) {
                return {
                    type: 'zclInd',
                    source: {
                        address: parseInt(match[1], 16),
                        endpoint: parseInt(match[2]),
                    },
                    dest: {
                        address: parseInt(match[3], 16),
                        endpoint: parseInt(match[4]),
                    },
                    clusterId: parseInt(match[5]),
                    payload: match[6],
                };
            }
        }

        // [Zcl,Conf,64,21,0]
        if (message.startsWith(MESSAGE_PREFIXES.ZCL_CONF)) {
            const parts = message.slice(1, -1).split(',');
            return {
                type: 'zclConf',
                endpoint: parseInt(parts[2]),
                sequence: parseInt(parts[3]),
                status: parseInt(parts[4]),
            };
        }

        // [Zcl,Req,0,21]
        if (message.startsWith(MESSAGE_PREFIXES.ZCL_REQ)) {
            const parts = message.slice(1, -1).split(',');
            return {
                type: 'zclReq',
                status: parseInt(parts[2]),
                sequence: parseInt(parts[3]),
            };
        }

        // [Zdp,JoinPermitted,True]
        if (message.startsWith(MESSAGE_PREFIXES.ZDP_JOIN_PERMITTED)) {
            const permitted = message.includes('True');
            return {type: 'joinPermitted', permitted};
        }

        // [Bridge,NetworkSettings,False,0xE783,7A:B3:74:CC:B3:23:0A:2A,15,0,S=0x0001]
        if (message.startsWith(MESSAGE_PREFIXES.BRIDGE_NETWORK_SETTINGS)) {
            const parts = message.slice(1, -1).split(',');
            const addrMatch = parts[7]?.match(/S=0x([0-9A-F]+)/i);

            return {
                type: 'networkSettings',
                factoryNew: parts[2] === 'True',
                panId: parseInt(parts[3], 16),
                extendedPanId: parts[4],
                channel: parseInt(parts[5]),
                nwkUpdateId: parseInt(parts[6]),
                networkAddress: addrMatch ? parseInt(addrMatch[1], 16) : 0,
            };
        }

        // [Zdp,ReceivedMgmtLqiRsp,100,S=0x0003.0,0,0,5,0,0,L=00:17:88:01:02:03:04:05,0x1234,1,2,255,1,0,1,...]
        if (message.startsWith(MESSAGE_PREFIXES.ZDP_MGMT_LQI_RSP)) {
            const parts = message.slice(1, -1).split(',');
            const addrMatch = parts[3].match(/S=0x([0-9A-F]+)/i);
            const neighborTableEntries = parseInt(parts[5]);
            const startIndex = parseInt(parts[6]);
            const count = parseInt(parts[7]);
            
            const neighborTableList: NeighborTableEntry[] = [];
            let offset = 8;
            
            for (let i = 0; i < count; i++) {                
                if (offset + 8 <= parts.length) {
                    neighborTableList.push({
                        extendedPanId: parts[offset],
                        ieeeAddr: parts[offset + 1].replace('L=', '').replace(/:/g, '').toLowerCase(),
                        networkAddress: parseInt(parts[offset + 2]),
                        linkQuality: parseInt(parts[offset + 7]),
                        depth: parseInt(parts[offset + 6]),
                        permitJoin: parseInt(parts[offset + 5]),
                        relationship: parseInt(parts[offset + 4]),
                        rxOnWhenIdle: parseInt(parts[offset + 3]),
                        deviceType: parseInt(parts[offset + 3]) & 0x03,
                    });
                    offset += 8;
                }
            }

            return {
                type: 'mgmtLqiRsp',
                seq: parseInt(parts[2]),
                srcAddr: addrMatch ? parseInt(addrMatch[1], 16) : 0,
                status: parseInt(parts[4]),
                startIndex,
                neighborTableEntries,
                neighborTableList,
            };
        }

        // [Link,Touchlink,success,S=0x0004,0x1201]
        if (message.startsWith(MESSAGE_PREFIXES.TOUCHLINK)) {
            const parts = message.slice(1, -1).split(',');
            return {
                type: 'linkTouchlink',
                shortAddress: parseInt(parts[3], 16),
                endpoint: parseInt(parts[4]),
            };
        }

        // [Zdp,ReceivedIeeeAddrRsp,2,S=0xDC81.0,0,L=00:15:8D:00:00:73:2D:27,S=0xDC81.0]
        if (message.startsWith(MESSAGE_PREFIXES.ZDP_IEEE_ADDR_RSP)) {
            const parts = message.slice(1, -1).split(',');
            return {
                type: 'zdpIeeeAddrRsp',
                seq: parseInt(parts[2]),
                srcAddr: parseInt(parts[3].match(/S=0x([0-9A-F]+)/i)![1], 16),
                status: parseInt(parts[4]),
                ieeeAddr: parts[5].replace('L=', '').replace(/:/g, '').toLowerCase(),
                networkAddress: parseInt(parts[6].match(/S=0x([0-9A-F]+)/i)![1], 16),
            };
        }
        
        // Unknown message type
        return {type: 'unknown', raw: message};
    }
}
