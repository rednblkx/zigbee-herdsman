import net from 'node:net';

import type * as Models from '../../../models/index.js';
import {Waitress} from '../../../utils/waitress.js';
import * as Zcl from '../../../zspec/zcl/index.js';
import * as Zdo from '../../../zspec/zdo/index.js';
import type * as ZdoTypes from '../../../zspec/zdo/definition/tstypes.js';
import type {BroadcastAddress} from '../../../zspec/enums.js';
import Adapter from '../../adapter.js';
import type * as AdapterEvents from '../../events.js';
import type * as TsType from '../../tstype.js';
import {SerialPort} from '../../serialPort.js';
import {isTcpPath, parseTcpPath} from '../../utils.js';
import {DelimiterParser} from '@serialport/parser-delimiter';
import {type ParsedMessage} from '../driver/messageParser.js';
import {CommandQueue} from '../utils/queue.js';
import {COMMANDS, DEFAULTS, SERIAL_PORT_OPTIONS, MESSAGE_TERMINATOR} from '../driver/constants.js';
import {logger} from "../../../utils/logger.js";

interface WaitressMatcher {
    address?: number | string;
    endpoint: number;
    transactionSequenceNumber?: number;
    clusterID: number;
    commandIdentifier: number;
}

var NS = "zh:huebridge";

/**
 * HueBridge adapter for zigbee-herdsman
 *
 * Enables zigbee2mqtt and other applications to use Philips Hue Bridge
 * as a Zigbee coordinator
 */
export class HueBridgeAdapter extends Adapter {
    private serialPort?: SerialPort;
    private socketPort?: net.Socket;
    private parser: DelimiterParser;
    private queue: CommandQueue;
    private coordinatorIeee: string | null = null;
    private coordinatorVersion: TsType.CoordinatorVersion | null = null;
    private networkParams: TsType.NetworkParameters | null = null;
    private waitress: Waitress<AdapterEvents.ZclPayload, WaitressMatcher>;

    constructor(
        networkOptions: TsType.NetworkOptions,
        serialPortOptions: TsType.SerialPortOptions,
        backupPath: string,
        adapterOptions: TsType.AdapterOptions,
    ) {
        super(networkOptions, serialPortOptions, backupPath, adapterOptions);

        this.waitress = new Waitress<AdapterEvents.ZclPayload, WaitressMatcher>(
            this.waitressValidator.bind(this),
            this.waitressTimeoutFormatter.bind(this)
        );

        this.parser = new DelimiterParser({delimiter: MESSAGE_TERMINATOR, includeDelimiter: false});
        // @ts-expect-error - queue initialized in start
        this.queue = null;
    }

    /**
     * Start the adapter
     */
    async start(): Promise<TsType.StartResult> {
        const path = this.serialPortOptions.path!;

        if (isTcpPath(path)) {
            await this.openSocketPort(path);
        } else {
            await this.openSerialPort(path);
        }

        await this.queue.send(COMMANDS.TH_RESET);
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const versionResp = await this.queue.execute(COMMANDS.TH_GET_SW_VERSION, (msg) => msg.type === 'version');

        if (versionResp.type === 'version') {
            this.coordinatorVersion = {
                type: versionResp.name,
                meta: {
                    revision: versionResp.version,
                    keyBitmask: versionResp.keyBitmask,
                },
            };
        }

        const addrResp = await this.queue.execute(COMMANDS.CONNECTION_GET_ADDRESS, (msg) => msg.type === 'address');

        if (addrResp.type === 'address') {
            this.coordinatorIeee = addrResp.ieee;
        }

        await this.initializeClustersAndEndpoints();

        return 'resumed';
    }

    /**
     * Initialize clusters and endpoints after reset
     * This is REQUIRED for ZCL commands to work properly - they need source endpoints configured
     * Based on actual UART protocol capture from Philips Hue bridge
     */
    private async initializeClustersAndEndpoints(): Promise<void> {
        logger.info('Initializing clusters and endpoints...', NS);

        const groupRangeStart = 0x6bda;
        const groupRangeEnd = 0x6bea;
        const gpGroupId = 27627;

        const anyResponseMatcher = () => true;

        await this.queue.execute(COMMANDS.ZGP_SET_GROUP_ID(gpGroupId), anyResponseMatcher);
        await this.queue.execute(COMMANDS.GROUPS_ADD_TO_GROUP(242, gpGroupId), anyResponseMatcher);

        const coordClusters = [
            0x0000, // Basic
            0x0003, // Identify
            0x0004, // Groups
            0x0005, // Scenes
            0x0006, // On/Off
            0x0008, // Level Control
            0x0300, // Color Control
            0x0400, // Illuminance Measurement
            0x0402, // Temperature Measurement
            0x0406, // Occupancy Sensing
            0x1000, // Touchlink Commissioning
        ];

        for (const clusterId of coordClusters) {
            await this.queue.execute(COMMANDS.ZCL_REGISTER_CLUSTER(0x0000, clusterId, 0x01), anyResponseMatcher);
        }

        const ep100bClusters = [
            0x0000, 0x0005, 0xfc00, 0xfc01, 0xfc03, 0xfc04, 0xfc06, 0xfc07
        ];

        for (const clusterId of ep100bClusters) {
            await this.queue.execute(COMMANDS.ZCL_REGISTER_CLUSTER(0x100b, clusterId, 0x01), anyResponseMatcher);
        }

        await this.queue.execute(COMMANDS.ZCL_REGISTER_CLUSTER(0x0000, 0x0019, 0x00), anyResponseMatcher);
        await this.queue.execute(COMMANDS.ZCL_REGISTER_CLUSTER(0x0000, 0x1000, 0x00), anyResponseMatcher);
        await this.queue.execute(COMMANDS.ZCL_REGISTER_ENDPOINT(0x40, 0xc05e, 0x0840, 0x02, 0x04, 0x0d, 0x11), anyResponseMatcher);

        const ep40InputClusters = [0x0000, 0x0003, 0x0004, 0x0005, 0x0006, 0x0008, 0x0300, 0x1000, 0xfc00, 0xfc01, 0xfc03, 0xfc04, 0xfc07];

        for (const clusterId of ep40InputClusters) {
            await this.queue.execute(COMMANDS.ZCL_ADD_CLUSTER_TO_DESCRIPTOR(0x40, 0x01, clusterId), anyResponseMatcher);
        }

        const ep40OutputClusters = [0x0000, 0x0019, 0x1000, 0xfc01];

        for (const clusterId of ep40OutputClusters) {
            await this.queue.execute(COMMANDS.ZCL_ADD_CLUSTER_TO_DESCRIPTOR(0x40, 0x00, clusterId), anyResponseMatcher);
        }

        await this.queue.execute(COMMANDS.ZCL_REGISTER_ENDPOINT(0x41, 0x0104, 0x0007, 0x00, 0x00, 0x07, 0x00), anyResponseMatcher);

        const ep41InputClusters = [0x0001, 0x000f, 0x0400, 0x0402, 0x0406, 0xfc00, 0xfc06];

        for (const clusterId of ep41InputClusters) {
            await this.queue.execute(COMMANDS.ZCL_ADD_CLUSTER_TO_DESCRIPTOR(0x41, 0x01, clusterId), anyResponseMatcher);
        }

        const foundationCmds = [0x01, 0x04, 0x06, 0x07, 0x0a, 0x0b];

        for (const cmdId of foundationCmds) {
            await this.queue.execute(COMMANDS.ZCL_REGISTER_FOUNDATION_CMD(cmdId), anyResponseMatcher);
        }

        await this.queue.execute(COMMANDS.STREAM_REGISTER_PROXY(0x40), anyResponseMatcher);

        await this.queue.execute(COMMANDS.BRIDGE_SET_MIGRATION_CODE(0x1f6d800), anyResponseMatcher);

        logger.info('Clusters and endpoints initialized successfully', NS);
    }

    /**
     * Stop the adapter
     */
    async stop(): Promise<void> {
        this.queue.clear();
        
        if (this.serialPort) {
            await this.serialPort.asyncClose();
        } else if (this.socketPort) {
            this.socketPort.destroy();
        }
    }

    /**
     * Get coordinator IEEE address
     */
    async getCoordinatorIEEE(): Promise<string> {
        if (!this.coordinatorIeee) {
            throw new Error('Coordinator IEEE not available');
        }
        return this.coordinatorIeee;
    }

    /**
     * Get coordinator version
     */
    async getCoordinatorVersion(): Promise<TsType.CoordinatorVersion> {
        if (!this.coordinatorVersion) {
            throw new Error('Coordinator version not available');
        }
        return this.coordinatorVersion;
    }

    /**
     * Reset coordinator
     */
    async reset(type: 'soft' | 'hard'): Promise<void> {
        if (type === 'hard') {
            throw new Error('Hard reset not supported (requires GPIO control)');
        }

        // Soft reset
        await this.queue.send(COMMANDS.TH_RESET);

        // Wait for ready
        await this.queue.execute('[TH,Ready', (msg) => msg.type === 'ready', 10000);
    }

    /**
     * Backup support
     */
    async supportsBackup(): Promise<boolean> {
        return false;
    }

    /**
     * Create backup
     */
    async backup(ieeeAddressesInDatabase: string[]): Promise<Models.Backup> {
        throw new Error('Backup not implemented');
    }

    /**
     * Get network parameters
     */
    async getNetworkParameters(): Promise<TsType.NetworkParameters> {
        if (this.networkParams) {
            return this.networkParams;
        }

        // Wait for network settings to be received from the bridge
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                (this as any).removeListener('internalNetworkSettings', listener);
                reject(new Error('Timeout waiting for network parameters'));
            }, 10000);

            const listener = (params: TsType.NetworkParameters) => {
                clearTimeout(timeout);
                resolve(params);
            };

            (this as any).once('internalNetworkSettings', listener);
        });
    }

    async addInstallCode(ieeeAddress: string, key: Buffer, hashed: boolean): Promise<void> {
        throw new Error('Install codes not implemented');
    }

    waitFor(
        networkAddress: number | undefined,
        endpoint: number,
        _frameType: Zcl.FrameType,
        _direction: Zcl.Direction,
        transactionSequenceNumber: number | undefined,
        clusterID: number,
        commandIdentifier: number,
        timeout: number,
    ): {promise: Promise<AdapterEvents.ZclPayload>; cancel: () => void} {
        const waiter = this.waitress.waitFor(
            {
                address: networkAddress,
                endpoint,
                clusterID,
                commandIdentifier,
                transactionSequenceNumber,
            },
            timeout,
        );
        const cancel = (): void => this.waitress.remove(waiter.ID);
        return {promise: waiter.start().promise, cancel};
    }

    private waitressTimeoutFormatter(matcher: WaitressMatcher, timeout: number): string {
        return (
            `Timeout - ${matcher.address} - ${matcher.endpoint}` +
            ` - ${matcher.transactionSequenceNumber} - ${matcher.clusterID}` +
            ` - ${matcher.commandIdentifier} after ${timeout}ms`
        );
    }

    private waitressValidator(payload: AdapterEvents.ZclPayload, matcher: WaitressMatcher): boolean {
        const result = Boolean(
            payload.header &&
                (!matcher.address || payload.address === matcher.address) &&
                payload.endpoint === matcher.endpoint &&
                (matcher.transactionSequenceNumber === undefined || payload.header.transactionSequenceNumber === matcher.transactionSequenceNumber) &&
                payload.clusterID === matcher.clusterID &&
                matcher.commandIdentifier === payload.header.commandIdentifier,
        );
        
        if (!result) {
            logger.debug(
                `Waitress no match: payload[addr=${payload.address}, ep=${payload.endpoint}, ` +
                `txSeq=${payload.header?.transactionSequenceNumber}, cluster=${payload.clusterID}, ` +
                `cmd=${payload.header?.commandIdentifier}] vs matcher[addr=${matcher.address}, ` +
                `ep=${matcher.endpoint}, txSeq=${matcher.transactionSequenceNumber}, ` +
                `cluster=${matcher.clusterID}, cmd=${matcher.commandIdentifier}]`,
                NS
            );
        }
        
        return result;
    }

    async sendZdo(
        ieeeAddress: string,
        networkAddress: number,
        clusterId: Zdo.ClusterId,
        payload: Buffer,
        disableResponse: true,
    ): Promise<void>;
    async sendZdo<K extends keyof ZdoTypes.RequestToResponseMap>(
        ieeeAddress: string,
        networkAddress: number,
        clusterId: K,
        payload: Buffer,
        disableResponse: false,
    ): Promise<ZdoTypes.RequestToResponseMap[K]>;
    async sendZdo<K extends keyof ZdoTypes.RequestToResponseMap>(
        ieeeAddress: string,
        networkAddress: number,
        clusterId: K,
        payload: Buffer,
        disableResponse: boolean,
    ): Promise<ZdoTypes.RequestToResponseMap[K] | undefined> {
        const seq = this.queue.nextSequence();
        let command: string = "";
        let matcher: (msg: ParsedMessage) => boolean = () => false;
        if(networkAddress === 0){
            networkAddress = 1;                    
        }
        logger.debug(`Sending ZDO command ${clusterId} to ${networkAddress}`, NS);
        logger.debug(`Payload: ${payload.toString('hex')}`, NS);
        switch (clusterId) {
            case Zdo.ClusterId.NODE_DESCRIPTOR_REQUEST:
                command = COMMANDS.ZDP_NODE_DESC_REQ(networkAddress, seq);
                matcher = (msg) => msg.type === 'nodeDescRsp';
                break;

            case Zdo.ClusterId.ACTIVE_ENDPOINTS_REQUEST:
                command = COMMANDS.ZDP_ACTIVE_EP_REQ(networkAddress, seq);
                matcher = (msg) => msg.type === 'activeEpRsp';
                break;

            case Zdo.ClusterId.SIMPLE_DESCRIPTOR_REQUEST: {
                const endpoint = payload[3];
                command = COMMANDS.ZDP_SIMPLE_DESC_REQ(networkAddress, seq, endpoint);
                matcher = (msg) => msg.type === 'simpleDescRsp';
                break;
            }

            case Zdo.ClusterId.IEEE_ADDRESS_REQUEST:
                command = COMMANDS.ZDP_IEEE_ADDR_REQ(networkAddress, seq);
                matcher = (msg) => msg.type === 'address';
                break;

            case Zdo.ClusterId.LQI_TABLE_REQUEST: {
                const startIndex = payload[0];
                command = COMMANDS.ZDP_MGMT_LQI_REQ(networkAddress, startIndex);
                matcher = (msg) => msg.type === 'mgmtLqiRsp';
                break;
            }

            case Zdo.ClusterId.BIND_REQUEST: {
                const srcIeee = '0x' + payload.subarray(1, 9).reverse().toString('hex');
                const srcEndpoint = payload[9];
                const clusterIdFromPayload = payload.readUInt16LE(10);
                const destAddrMode = payload[12];
                
                logger.debug(`Bind request: src=${srcIeee}:${srcEndpoint}, cluster=${clusterIdFromPayload}, destMode=${destAddrMode}`, NS);
                
                if (destAddrMode === 0x03) {
                    // IEEE address mode (unicast binding)
                    const destIeee = '0x' + payload.subarray(13, 21).reverse().toString('hex');
                    const destEndpoint = payload[21];
                    logger.debug(`Bind to IEEE: dest=${destIeee}:${destEndpoint}`, NS);
                    command = COMMANDS.ZDP_BIND_REQ(networkAddress, srcIeee, srcEndpoint, clusterIdFromPayload, destAddrMode, destIeee, destEndpoint);
                } else if (destAddrMode === 0x01) {
                    // Group address mode
                    const destGroup = payload.readUInt16LE(13);
                    logger.debug(`Bind to group: ${destGroup}`, NS);
                    command = COMMANDS.ZDP_BIND_REQ(networkAddress, srcIeee, srcEndpoint, clusterIdFromPayload, destAddrMode, destGroup.toString(16), 0);
                }
                logger.debug(`Generated bind command: ${command}`, NS);
                matcher = () => true; // Accept any response
                break;
            }

            case Zdo.ClusterId.UNBIND_REQUEST: {
                const srcIeee = '0x' + payload.subarray(1, 9).reverse().toString('hex');
                const srcEndpoint = payload[9];
                const clusterIdFromPayload = payload.readUInt16LE(10);
                const destAddrMode = payload[12];
                
                if (destAddrMode === 0x03) {
                    const destIeee = '0x' + payload.subarray(13, 21).reverse().toString('hex');
                    const destEndpoint = payload[21];
                    command = COMMANDS.ZDP_UNBIND_REQ(networkAddress, srcIeee, srcEndpoint, clusterIdFromPayload, destAddrMode, destIeee, destEndpoint);
                } else if (destAddrMode === 0x01) {
                    const destGroup = payload.readUInt16LE(13);
                    command = COMMANDS.ZDP_UNBIND_REQ(networkAddress, srcIeee, srcEndpoint, clusterIdFromPayload, destAddrMode, destGroup.toString(16), 0);
                }
                matcher = () => true;
                break;
            }

            case Zdo.ClusterId.LEAVE_REQUEST: {
                const deviceIeee = '0x' + payload.subarray(1, 9).reverse().toString('hex');
                const flags = payload[9];
                const rejoin = (flags & 0x80) !== 0;
                const removeChildren = (flags & 0x40) !== 0;
                
                logger.debug(`Leave request: device=${deviceIeee}, rejoin=${rejoin}, removeChildren=${removeChildren}`, NS);
                command = COMMANDS.ZDP_MGMT_LEAVE_REQ(networkAddress, deviceIeee, rejoin, removeChildren);
                matcher = () => true;
                break;
            }

            default:
                logger.warning(`ZDO cluster ${clusterId} not implemented`, NS);
        }

        if (disableResponse && command) {
            await this.queue.send(command);
            return;
        }
        const response = await this.queue.execute(command, matcher);

        if (clusterId === Zdo.ClusterId.ACTIVE_ENDPOINTS_REQUEST && response.type === 'activeEpRsp') {
            const zdoResponse: ZdoTypes.ActiveEndpointsResponse = {
                nwkAddress: response.networkAddress,
                endpointList: response.endpoints,
            };
            return [response.status as Zdo.Status, zdoResponse] as any;
        }

        if (clusterId === Zdo.ClusterId.IEEE_ADDRESS_REQUEST && response.type === 'address') {
            const zdoResponse: ZdoTypes.IEEEAddressResponse = {
                eui64: `0x${response.ieee}`,
                nwkAddress: response.networkAddress,
                startIndex: 0,
                assocDevList: []
            };
            return [response.status as Zdo.Status, zdoResponse] as any;
        }

        if (clusterId === Zdo.ClusterId.SIMPLE_DESCRIPTOR_REQUEST && response.type === 'simpleDescRsp') {
            const zdoResponse: ZdoTypes.SimpleDescriptorResponse = {
                nwkAddress: response.networkAddress,
                length: response.data.length,
                endpoint: response.data.endpoint,
                profileId: response.data.profileId,
                deviceId: response.data.deviceId,
                deviceVersion: response.data.deviceVersion,
                inClusterList: response.data.inputClusters,
                outClusterList: response.data.outputClusters,
            };
            return [response.status as Zdo.Status, zdoResponse] as any;
        }

        if (clusterId === Zdo.ClusterId.NODE_DESCRIPTOR_REQUEST && response.type === 'nodeDescRsp') {
             const zdoResponse: ZdoTypes.NodeDescriptorResponse = {
                nwkAddress: response.networkAddress,
                logicalType: response.data.logicalType,
                fragmentationSupported: false,
                apsFlags: 0,
                frequencyBand: 0, // Unknown
                capabilities: {
                    alternatePANCoordinator: 0,
                    deviceType: (response.data.capability >> 1) & 1,
                    powerSource: (response.data.capability >> 2) & 1,
                    rxOnWhenIdle: (response.data.capability >> 3) & 1,
                    reserved1: 0,
                    reserved2: 0,
                    securityCapability: (response.data.capability >> 6) & 1,
                    allocateAddress: (response.data.capability >> 7) & 1,
                },
                manufacturerCode: response.data.manufacturerCode,
                maxBufSize: response.data.maxBufferSize,
                maxIncTxSize: response.data.maxTransferSize,
                serverMask: {
                    primaryTrustCenter: 0,
                    backupTrustCenter: 0,
                    deprecated1: 0,
                    deprecated2: 0,
                    deprecated3: 0,
                    deprecated4: 0,
                    networkManager: 0,
                    reserved1: 0,
                    reserved2: 0,
                    stackComplianceRevision: 0,
                },
                maxOutTxSize: response.data.maxTransferSize,
                deprecated1: 0,
                tlvs: []
            };
            return [response.status as Zdo.Status, zdoResponse] as any;
        }

        if (clusterId === Zdo.ClusterId.LQI_TABLE_REQUEST && response.type === 'mgmtLqiRsp') {
            const zdoResponse: ZdoTypes.LQITableResponse = {
                neighborTableEntries: response.neighborTableEntries,
                startIndex: response.startIndex,
                entryList: response.neighborTableList.map(entry => ({
                    extendedPanId: [...Buffer.from(entry.extendedPanId, 'hex')],
                    eui64: `0x${entry.ieeeAddr}`,
                    nwkAddress: entry.networkAddress,
                    deviceType: entry.deviceType,
                    rxOnWhenIdle: entry.rxOnWhenIdle,
                    relationship: entry.relationship,
                    reserved1: 0,
                    permitJoining: entry.permitJoin,
                    reserved2: 0,
                    depth: entry.depth,
                    lqi: entry.linkQuality
                }))
            };
            return [response.status as Zdo.Status, zdoResponse] as any;
        }

        return [0 as Zdo.Status, undefined] as any;
    }

    async permitJoin(seconds: number, networkAddress?: number): Promise<void> {
        await this.queue.execute(COMMANDS.ZGP_COMMISSIONING_ENTER(seconds), (msg) => msg.type === 'unknown');

        await this.queue.execute(COMMANDS.ZDP_PERMIT_JOINING(seconds, networkAddress), (msg) => msg.type === 'joinPermitted');
    }

    async sendZclFrameToEndpoint(
        ieeeAddr: string,
        networkAddress: number,
        endpoint: number,
        zclFrame: Zcl.Frame,
        timeout: number,
        disableResponse: boolean,
        disableRecovery: boolean,
        sourceEndpoint?: number,
        profileId?: number,
    ): Promise<AdapterEvents.ZclPayload | undefined> {
        const payload = zclFrame.toBuffer().toString('hex').toUpperCase();
        const command = COMMANDS.ZCL_REQ_UNICAST(networkAddress, endpoint, sourceEndpoint || 64, zclFrame.cluster.ID, payload);

        logger.debug(`Sending ZCL to ${networkAddress}/${endpoint}, disableResponse=${disableResponse}`, NS);

        let waiter: {promise: Promise<AdapterEvents.ZclPayload>; cancel: () => void} | undefined;
        
        if (!disableResponse) {
            const command = zclFrame.command;
            if (command.response !== undefined) {
                logger.debug(
                    `Setting up waiter for TX seq=${zclFrame.header.transactionSequenceNumber}, ` +
                    `cluster=${zclFrame.cluster.ID}, cmd=${command.response}`,
                    NS
                );
                waiter = this.waitFor(
                    networkAddress,
                    endpoint,
                    Zcl.FrameType.GLOBAL,
                    Zcl.Direction.SERVER_TO_CLIENT,
                    zclFrame.header.transactionSequenceNumber,
                    zclFrame.cluster.ID,
                    command.response,
                    timeout,
                );
            } else if (!zclFrame.header.frameControl.disableDefaultResponse) {
                logger.debug(
                    `Setting up waiter for default response, TX seq=${zclFrame.header.transactionSequenceNumber}, ` +
                    `cluster=${zclFrame.cluster.ID}`,
                    NS
                );
                waiter = this.waitFor(
                    networkAddress,
                    endpoint,
                    Zcl.FrameType.GLOBAL,
                    Zcl.Direction.SERVER_TO_CLIENT,
                    zclFrame.header.transactionSequenceNumber,
                    zclFrame.cluster.ID,
                    Zcl.Foundation.defaultRsp.ID,
                    timeout,
                );
            }
        }

        try {
            // Send the command and wait for ACK (Zcl,Req response with sequence number)
            const ackResponse = await this.queue.execute(command, (msg) => msg.type === 'zclReq');
            
            if (ackResponse.type !== 'zclReq') {
                waiter?.cancel();
                throw new Error('Failed to send ZCL request');
            }

            const txSequence = ackResponse.sequence;
            logger.debug(`ZCL request ACK received, seq=${txSequence}`, NS);

            // Wait for Conf message and check status
            const confResponse = await this.queue.execute(
                '', 
                (msg) => msg.type === 'zclConf' && msg.sequence === txSequence,
                timeout
            );

            if (confResponse.type === 'zclConf') {
                logger.debug(`ZCL Conf received, seq=${confResponse.sequence}, status=${confResponse.status}`, NS);
                
                // If conf status is non-zero, the command failed
                if (confResponse.status !== 0) {
                    waiter?.cancel();
                    throw new Error(`ZCL command failed with status ${confResponse.status}`);
                }
            }

            // If we have a waiter, wait for the actual response (already started above!)
            if (waiter) {
                const result = await waiter.promise;
                logger.debug(`ZCL response received: ${JSON.stringify(result)}`, NS);
                return result;
            }

            return undefined;
        } catch (error) {
            waiter?.cancel();
            throw error;
        }
    }

    async sendZclFrameToGroup(groupID: number, zclFrame: Zcl.Frame, sourceEndpoint?: number, profileId?: number): Promise<void> {
        const payload = zclFrame.toBuffer().toString('hex').toUpperCase();

        const command = COMMANDS.ZCL_REQ_GROUP(groupID, zclFrame.cluster.ID, payload, sourceEndpoint || 64);

        await this.queue.execute(command, (msg) => msg.type === 'zclReq');
    }

    async sendZclFrameToAll(
        endpoint: number,
        zclFrame: Zcl.Frame,
        sourceEndpoint: number,
        destination: BroadcastAddress,
        profileId?: number,
    ): Promise<void> {
        const payload = zclFrame.toBuffer().toString('hex').toUpperCase();

        const command = COMMANDS.ZCL_REQ_BROADCAST(destination, endpoint, sourceEndpoint || 64, zclFrame.cluster.ID, payload);

        await this.queue.execute(command, (msg) => msg.type === 'zclReq');
    }

    async setChannelInterPAN(channel: number): Promise<void> {
        logger.debug('InterPAN setChannelInterPAN not yet implemented', NS);
    }

    async sendZclFrameInterPANToIeeeAddr(zclFrame: Zcl.Frame, ieeeAddress: string): Promise<void> {
        logger.debug('InterPAN sendZclFrameInterPANToIeeeAddr not yet implemented', NS);
    }

    async sendZclFrameInterPANBroadcast(zclFrame: Zcl.Frame, timeout: number, disableResponse: false): Promise<AdapterEvents.ZclPayload>;
    async sendZclFrameInterPANBroadcast(zclFrame: Zcl.Frame, timeout: number, disableResponse: true): Promise<undefined>;
    async sendZclFrameInterPANBroadcast(
        zclFrame: Zcl.Frame,
        timeout: number,
        disableResponse: boolean,
    ): Promise<AdapterEvents.ZclPayload | undefined> {
        logger.debug('InterPAN sendZclFrameInterPANBroadcast not implemented', NS);
        return {
            clusterID: zclFrame.cluster.ID,
            address: 0,
            endpoint: 0,
            data: Buffer.from([]),
            header: undefined,
            linkquality: DEFAULTS.LINK_QUALITY,
            groupID: 0,
            wasBroadcast: false,
            destinationEndpoint: 0,
        };
    }

    async restoreChannelInterPAN(): Promise<void> {
        logger.debug('InterPAN restoreChannelInterPAN not implemented', NS);
        return;
    }

    private processMessages(msg: ParsedMessage): void {
        switch (msg.type) {
            case 'deviceAnnounce':
                this.emit('deviceJoined', {
                    networkAddress: msg.networkAddress,
                    ieeeAddr: msg.ieee,
                });
                break;

            case 'zclInd': {
                const payload: AdapterEvents.ZclPayload = {
                    clusterID: msg.clusterId,
                    address: msg.source.address,
                    endpoint: msg.source.endpoint,
                    data: Buffer.from(msg.payload, 'hex'),
                    header: Zcl.Header.fromBuffer(Buffer.from(msg.payload, 'hex')),
                    linkquality: DEFAULTS.LINK_QUALITY,
                    groupID: 0,
                    wasBroadcast: false,
                    destinationEndpoint: msg.dest.endpoint,
                };

                try {
                    logger.debug(
                        `Attempting waitress.resolve for TX seq=${payload?.header?.transactionSequenceNumber}, ` +
                        `cluster=${payload?.clusterID}, cmd=${payload?.header?.commandIdentifier}`,
                        NS
                    );

                    const resolved = this.waitress.resolve(payload);
                    
                    logger.debug(`Waitress.resolve returned: ${resolved}`, NS);
                    
                    if (!resolved) {
                        this.emit('zclPayload', payload);
                    }
                } catch {
                    this.emit('zclPayload', payload);
                }
                break;
            }

            case 'networkSettings':
                this.networkParams = {
                    panID: msg.panId,
                    extendedPanID: msg.extendedPanId.replace(/:/g, '').toLowerCase(),
                    channel: msg.channel,
                    nwkUpdateID: msg.nwkUpdateId,
                };
                (this as any).emit('internalNetworkSettings', this.networkParams);
                break;

            default:
                break;
        }
    }
    private async openSerialPort(path: string): Promise<void> {
        const options = {
            path,
            ...SERIAL_PORT_OPTIONS,
            autoOpen: false,
        };

        this.serialPort = new SerialPort(options);
        this.serialPort.pipe(this.parser);
        this.queue = new CommandQueue(this.serialPort, this.parser);

        this.queue.on('rxMsg', (msg: ParsedMessage) => {
            this.processMessages(msg);
        });

        await this.serialPort.asyncOpen();
    }

    private async openSocketPort(path: string): Promise<void> {
        const info = parseTcpPath(path);
        this.socketPort = new net.Socket();
        this.socketPort.setNoDelay(true);
        this.socketPort.setKeepAlive(true, 15000);

        this.socketPort.pipe(this.parser);
        this.queue = new CommandQueue(this.socketPort, this.parser);

        this.queue.on('rxMsg', (msg: ParsedMessage) => {
            this.processMessages(msg);
        });

        return new Promise((resolve, reject) => {
            this.socketPort!.on('connect', () => {
            });

            this.socketPort!.on('ready', () => {
                resolve();
            });

            this.socketPort!.once('error', (error) => {
                reject(new Error(`Socket error: ${error.message}`));
            });

            this.socketPort!.connect(info.port, info.host);
        });
    }
}
