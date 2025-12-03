import {EventEmitter} from 'node:events';
import net from 'node:net';
import Debug from 'debug';

import {DEFAULT_TIMEOUT, MESSAGE_TERMINATOR} from '../driver/constants.js';
import {SerialPort} from '../../serialPort.js';
import {DelimiterParser} from '@serialport/parser-delimiter';
import {MessageParser, type ParsedMessage} from '../driver/messageParser.js';

const debug = Debug('zigbee-herdsman:huebridge:queue');

type CommandMatcher = (msg: ParsedMessage) => boolean;

interface PendingCommand {
    resolve: (value: ParsedMessage) => void;
    reject: (error: Error) => void;
    matcher: CommandMatcher;
    timeout: NodeJS.Timeout;
    command: string;
}

/**
 * Command queue with promise-based responses
 */
export class CommandQueue extends EventEmitter {
    private pending: Map<string, PendingCommand> = new Map();
    private sequenceNumber = 0;

    constructor(
        private readonly port: SerialPort | net.Socket,
        private readonly parser: DelimiterParser,
    ) {
        super();

        // Listen for incoming messages
        this.parser.on('data', (data: Buffer) => {
            const message = data.toString();
            debug('Received raw data:', message);
            this.handleMessage(message);
        });
    }

    /**
     * Get next sequence number
     */
    nextSequence(): number {
        return ++this.sequenceNumber;
    }

    /**
     * Execute a command and wait for response
     */
    async execute(command: string, matcher: CommandMatcher, timeoutMs: number = DEFAULT_TIMEOUT): Promise<ParsedMessage> {
        return new Promise((resolve, reject) => {
            const id = `${Date.now()}-${Math.random()}`;

            const timeout = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Command timeout after ${timeoutMs}ms: ${command}`));
            }, timeoutMs);

            this.pending.set(id, {
                resolve,
                reject,
                matcher,
                timeout,
                command,
            });
            if(command){
                // Send command
                this.send(command).catch((error) => {
                    clearTimeout(timeout);
                    this.pending.delete(id);
                    reject(error);
                });
            }
        });
    }

    /**
     * Handle incoming message
     */
    private handleMessage(message: string): void {
        const parsed = MessageParser.parse(message);
        debug('Parsed message:', JSON.stringify(parsed));

        // Try to match against pending commands
        for (const [id, pending] of this.pending.entries()) {
            if (pending.matcher(parsed)) {
                clearTimeout(pending.timeout);
                this.pending.delete(id);
                pending.resolve(parsed);
                return; // Message consumed
            }
        }

        // Not a pending response, emit as rxMsg message
        debug('Emitting rxMsg message:', parsed.type);
        this.emit('rxMsg', parsed);
    }

    /**
     * Clear all pending commands
     */
    clear(): void {
        for (const [id, pending] of this.pending.entries()) {
            clearTimeout(pending.timeout);
            pending.reject(new Error('Command queue cleared'));
        }
        this.pending.clear();
    }
    /**
     * Send a command without waiting for response
     */
    /**
     * Send a command without waiting for response
     */
    async send(command: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const data = command + MESSAGE_TERMINATOR;
            debug('Sending command:', data);
            this.port.write(data, (error) => {
                if (error) {
                    reject(new Error(`Failed to write to port: ${error.message}`));
                } else {
                    resolve();
                }
            });
        });
    }
}
