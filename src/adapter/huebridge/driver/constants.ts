/**
 * Constants for HueBridge protocol
 */

export const BAUD_RATE = 115200;
export const MESSAGE_TERMINATOR = '\r';
export const DEFAULT_TIMEOUT = 5000;
export const READY_MESSAGE = '[TH,Ready,0]';

/**
 * Serial port defaults
 */
export const SERIAL_PORT_OPTIONS = {
    baudRate: BAUD_RATE,
    dataBits: 8 as const,
    stopBits: 1 as const,
    parity: 'none' as const,
    rtscts: false,
    xon: false,
    xoff: false,
};

/**
 * Zigbee broadcast addresses
 */
export const BROADCAST_ADDRESSES = {
    ALL_ROUTERS_AND_COORDINATOR: 0xfffc,
    ALL_DEVICES: 0xfffd,
    RESERVED: 0xffff,
} as const;

/**
 * Default Zigbee values
 */
export const DEFAULTS = {
    PERMIT_JOIN_TIMEOUT: 60,
    LINK_QUALITY: 255, // huebridge doesn't provide LQI, use max
    SOURCE_ENDPOINT: 1,
    GREEN_POWER_ENDPOINT: 242,
    TOUCHLINK_ENDPOINT: 0x40,
} as const;

/**
 * Message prefixes for parsing
 */
export const MESSAGE_PREFIXES = {
    TH_READY: '[TH,Ready',
    TH_GET_SW_VERSION: '[TH,GetSwVersion',
    CONNECTION_GET_ADDRESS: '[Connection,GetAddress',
    BRIDGE_NETWORK_SETTINGS: '[Bridge,NetworkSettings',
    ZDP_JOIN_PERMITTED: '[Zdp,JoinPermitted',
    ZDP_DEVICE_ANNOUNCE: '[Zdp,ReceivedDeviceAnnounce',
    ZDP_NODE_DESC_RSP: '[Zdp,ReceivedNodeDescRsp',
    ZDP_ACTIVE_EP_RSP: '[Zdp,ReceivedActiveEndPointRsp',
    ZDP_SIMPLE_DESC_RSP: '[Zdp,ReceivedSimpleDescRsp',
    ZDP_MGMT_LQI_RSP: '[Zdp,ReceivedMgmtLqiRsp',
    ZDP_IEEE_ADDR_RSP: '[Zdp,ReceivedIeeeAddrRsp',
    ZCL_IND: '[Zcl,Ind',
    ZCL_CONF: '[Zcl,Conf',
    ZCL_REQ: '[Zcl,Req',
    LOG: '[LOG',
    TOUCHLINK: '[Link,Touchlink',
} as const;

/**
 * Command templates
 */
export const COMMANDS = {
    // TH Commands
    TH_RESET: '[TH,Reset]',
    TH_GET_SW_VERSION: '[TH,GetSwVersion]',
    
    // Connection Commands  
    CONNECTION_GET_ADDRESS: '[Connection,GetAddress]',
    CONNECTION_CHANNEL_CHANGE: (channel: number) => `[Connection,ChannelChange,${channel}]`,
    
    // Permit Joining
    ZGP_COMMISSIONING_ENTER: (seconds: number) => `[Zgp,CommissioningEnter,False,${seconds}]`,
    ZDP_PERMIT_JOINING: (seconds: number, nwkAddr?: number) => `[Zdp,SendMgmtPermitJoiningReq,${nwkAddr ? `S=0x${nwkAddr.toString(16).padStart(4, '0')}.0` : 'B=0xFFFC.0'},${seconds},0]`,
    
    // ZDO Commands
    ZDP_NODE_DESC_REQ: (addr: number, seq: number) => 
        `[Zdp,SendNodeDescReq,S=0x${addr.toString(16).padStart(4, '0')}.0,${addr}]`,
    ZDP_ACTIVE_EP_REQ: (addr: number, seq: number) =>
        `[Zdp,SendActiveEndPointReq,S=0x${addr.toString(16).padStart(4, '0')}.0,${addr}]`,
    ZDP_SIMPLE_DESC_REQ: (addr: number, seq: number, endpoint: number) =>
        `[Zdp,SendSimpleDescReq,S=0x${addr.toString(16).padStart(4, '0')}.0,${addr},${endpoint}]`,
    ZDP_IEEE_ADDR_REQ: (addr: number, seq: number) =>
        `[Zdp,IeeeAddrReq,S=0x${addr.toString(16).padStart(4, '0')}.0,${seq}]`,
    ZDP_MGMT_LQI_REQ: (addr: number, startIndex: number) =>
        `[Zdp,SendMgmtLqiReq,S=0x${addr.toString(16).padStart(4, '0')}.0,${startIndex}]`,
    ZDP_BIND_REQ: (addr: number, srcIeee: string, srcEndpoint: number, clusterId: number, destAddrMode: number, destAddr: string, destEndpoint: number) => {
        // Format IEEE address as colon-separated hex bytes (without 0x prefix)
        const formatIeee = (ieee: string) => {
            const clean = ieee.replace(/^0x/, '').replace(/:/g, '');
            const bytes = clean.match(/.{1,2}/g) || [];
            return bytes.join(':').toUpperCase();
        };
        // Format: [Zdp,SendBindReq,S=0x<addr>.0,L=<srcIEEE>.<srcEp>,<clusterId>,L=<dstIEEE>.<dstEp>]
        return `[Zdp,SendBindReq,S=0x${addr.toString(16).padStart(4, '0')}.0,L=${formatIeee(srcIeee)}.${srcEndpoint},${clusterId},L=${formatIeee(destAddr)}.${destEndpoint}]`;
    },
    ZDP_UNBIND_REQ: (addr: number, srcIeee: string, srcEndpoint: number, clusterId: number, destAddrMode: number, destAddr: string, destEndpoint: number) => {
        const formatIeee = (ieee: string) => {
            const clean = ieee.replace(/^0x/, '').replace(/:/g, '');
            const bytes = clean.match(/.{1,2}/g) || [];
            return bytes.join(':').toUpperCase();
        };
        return `[Zdp,SendUnbindReq,S=0x${addr.toString(16).padStart(4, '0')}.0,L=${formatIeee(srcIeee)}.${srcEndpoint},${clusterId},L=${formatIeee(destAddr)}.${destEndpoint}]`;
    },
    ZDP_MGMT_LEAVE_REQ: (addr: number, deviceIeee: string, rejoin: boolean, removeChildren: boolean) => {
        const formatIeee = (ieee: string) => {
            const clean = ieee.replace(/^0x/, '').replace(/:/g, '');
            const bytes = clean.match(/.{1,2}/g) || [];
            return bytes.join(':').toUpperCase();
        };
        // Format: [Zdp,SendMgmtLeaveReq,S=0x<addr>.0,L=<IEEE>,<rejoin_flag>,<remove_children_flag>]
        return `[Zdp,SendMgmtLeaveReq,S=0x${addr.toString(16).padStart(4, '0')}.0,L=${formatIeee(deviceIeee)},${rejoin ? "True" : "False"},${removeChildren ? "True" : "False"}]`;
    },
    
    // ZCL Commands
    ZCL_REQ_UNICAST: (addr: number, endpoint: number, sourceEndpoint: number, clusterId: number, payload: string) =>
        `[Zcl,Req,S=0x${addr.toString(16).padStart(4, '0')}.${endpoint},${clusterId},${payload},${sourceEndpoint}]`,
    ZCL_REQ_BROADCAST: (broadcastAddr: number, endpoint: number, sourceEndpoint: number, clusterId: number, payload: string) =>
        `[Zcl,Req,B=0x${broadcastAddr.toString(16).padStart(4, '0')}.${endpoint},${clusterId},${payload},${sourceEndpoint}]`,
    ZCL_REQ_GROUP: (groupId: number, clusterId: number, payload: string, sourceEndpoint: number) =>
        `[Zcl,Req,G=0x${groupId.toString(16).padStart(4, '0')},${clusterId},${payload},${sourceEndpoint}]`,
    
    // Cluster and Endpoint Initialization Commands
    ZGP_SET_GROUP_ID: (groupId: number) => `[Zgp,SetGroupId,${groupId}]`,
    GROUPS_ADD_TO_GROUP: (endpoint: number, groupId: number) => `[Groups,AddToGroup,${endpoint},${groupId}]`,
    
    ZCL_REGISTER_CLUSTER: (endpoint: number, clusterId: number, role: number) =>
        `[Zcl,RegisterCluster,0x${endpoint.toString(16).padStart(4, '0')},0x${clusterId.toString(16).padStart(4, '0')},0x${role.toString(16).padStart(2, '0')}]`,
    
    ZCL_REGISTER_ENDPOINT: (endpoint: number, profileId: number, deviceId: number, version: number, flags: number, inCount: number, outCount: number) =>
        `[Zcl,RegisterEndpoint,0x${endpoint.toString(16).padStart(2, '0')},0x${profileId.toString(16).padStart(4, '0')},0x${deviceId.toString(16).padStart(4, '0')},0x${version.toString(16).padStart(2, '0')},0x${flags.toString(16).padStart(2, '0')},0x${inCount.toString(16).padStart(2, '0')},0x${outCount.toString(16).padStart(2, '0')}]`,
    
    ZCL_ADD_CLUSTER_TO_DESCRIPTOR: (endpoint: number, direction: number, clusterId: number) =>
        `[Zcl,AddClusterToSimpleDescriptor,0x${endpoint.toString(16).padStart(2, '0')},0x${direction.toString(16).padStart(2, '0')},0x${clusterId.toString(16).padStart(4, '0')}]`,
    
    ZCL_REGISTER_FOUNDATION_CMD: (cmdId: number) =>
        `[Zcl,RegisterFoundationCommand,0x${cmdId.toString(16).padStart(2, '0')}]`,
    
    STREAM_REGISTER_PROXY: (endpoint: number) =>
        `[Stream,RegisterProxy,0x${endpoint.toString(16).padStart(2, '0')}]`,
    
    BRIDGE_SET_MIGRATION_CODE: (code: number) =>
        `[Bridge,SetMigrationCode,0x${code.toString(16).toUpperCase()}]`,

    // Touchlink
    LINK_TOUCHLINK: () => `[Link,Touchlink]`,
    
} as const;
