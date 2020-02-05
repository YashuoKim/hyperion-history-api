import {ConfigurationModule} from "./config";
import {ConnectionManager} from "../connections/manager.class";
import {JsonRpc} from "eosjs/dist";
import {ApiResponse, Client} from "@elastic/elasticsearch";
import {HyperionModuleLoader} from "./loader";

import {
    getLastIndexedABI,
    getLastIndexedBlock,
    getLastIndexedBlockByDelta,
    getLastIndexedBlockByDeltaFromRange,
    getLastIndexedBlockFromRange,
    messageAllWorkers
} from "../helpers/common_functions";

import {GetInfoResult} from "eosjs/dist/eosjs-rpc-interfaces";
import * as pm2io from '@pm2/io';

import {createWriteStream, existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, WriteStream} from "fs";

import {join} from "path";
import * as cluster from "cluster";
import {HyperionWorkerDef} from "../interfaces/hyperionWorkerDef";
import moment = require("moment");
import Timeout = NodeJS.Timeout;
import {HyperionConfig} from "../interfaces/hyperionConfig";

// const doctor = require('./modules/doctor');

export class HyperionMaster {

    // global configuration
    conf: HyperionConfig;

    // connection manager
    manager: ConnectionManager;

    // eosjs rpc
    rpc: JsonRpc;

    // live producer schedule
    private currentSchedule: any;

    // elasticsearch client
    private client: Client;

    // hyperion module loader
    mLoader: HyperionModuleLoader;

    // Chain/Queue Prefix
    chain: string;

    // Chain API Info
    private chain_data: GetInfoResult;

    // Main workers
    private workerMap: HyperionWorkerDef[];
    private worker_index: number;

    // Scaling params
    private max_readers: number;
    private IndexingQueues: any;
    private maxBatchSize: number;
    private dsErrorStream: WriteStream;

    // mem-optimized deserialization pool
    private dsPoolMap: Map<number, cluster.Worker> = new Map();
    private globalUsageMap = {};
    private totalContractHits = 0;

    // producer monitoring
    private producedBlocks: object = {};
    private lastProducedBlockNum = 0;
    private lastProducer: string = null;
    private handoffCounter: number = 0;
    private missedRounds: object = {};
    private blockMsgQueue: any[] = [];

    // IPC Messaging
    private totalMessages = 0;

    // Repair
    private doctorId = 0;
    private missingRanges = [];
    private doctorIdle = true;

    // Indexer Monitoring
    private lastProcessedBlockNum = 0;
    private allowMoreReaders = true;
    private allowShutdown = false;
    private readonly log_interval = 5000;
    private consumedBlocks = 0;
    private deserializedActions = 0;
    private total_indexed_blocks = 0;
    private indexedObjects = 0;
    private deserializedDeltas = 0;
    private liveConsumedBlocks = 0;
    private livePushedBlocks = 0;
    private pushedBlocks = 0;
    private total_read = 0;
    private total_blocks = 0;
    private total_actions = 0;
    private total_deltas = 0;
    private consume_rates: number[] = [];
    private total_range = 0;
    private range_completed = false;
    private head: number;
    private starting_block: number;
    private shutdownTimer: Timeout;
    private idle_count = 0;
    private auto_stop = 0;

    // IPC Messages Handling
    private msgHandlerMap: any;

    private cachedInitABI = false;
    private activeReadersCount = 0;
    private lastAssignedBlock: number;


    constructor() {
        const cm = new ConfigurationModule();
        this.conf = cm.config;
        this.manager = new ConnectionManager(cm);
        this.mLoader = new HyperionModuleLoader(cm);
        this.chain = this.conf.settings.chain;
        this.initHandlerMap();
    }

    initHandlerMap() {
        this.msgHandlerMap = {
            'consumed_block': (msg: any) => {
                if (msg.live === 'false') {
                    this.consumedBlocks++;
                    if (msg.block_num > this.lastProcessedBlockNum) {
                        this.lastProcessedBlockNum = msg.block_num;
                    }
                } else {
                    this.liveConsumedBlocks++;
                    this.onLiveBlock(msg);
                }
            },
            'init_abi': (msg: any) => {
                if (!this.cachedInitABI) {
                    this.cachedInitABI = msg.data;
                    setTimeout(() => {
                        messageAllWorkers(cluster, {
                            event: 'initialize_abi',
                            data: msg.data
                        });
                    }, 1000);
                }
            },
            'router_ready': () => {
                messageAllWorkers(cluster, {
                    event: 'connect_ws'
                });
            },
            'save_abi': (msg: any) => {
                if (msg.live_mode === 'true') {
                    console.log(`deserializer ${msg.worker_id} received new abi! propagating changes to other workers...`);
                    for (const worker of this.workerMap) {
                        if (worker.worker_role === 'deserializer' && worker.worker_id !== parseInt(msg.worker_id)) {
                            worker.wref.send({
                                event: 'update_abi',
                                abi: msg.data
                            });
                        }
                    }
                }
            },
            'completed': (msg: any) => {
                if (msg.id === this.doctorId.toString()) {
                    console.log('repair worker completed', msg);
                    console.log('queue size [before]:', this.missingRanges.length);
                    if (this.missingRanges.length > 0) {
                        const range_data = this.missingRanges.shift();
                        console.log('New repair range', range_data);
                        console.log('queue size [after]:', this.missingRanges.length);
                        this.doctorIdle = false;
                        messageAllWorkers(cluster, {
                            event: 'new_range',
                            target: msg.id,
                            data: {
                                first_block: range_data.start,
                                last_block: range_data.end
                            }
                        });
                    } else {
                        this.doctorIdle = true;
                    }
                } else {
                    this.activeReadersCount--;
                    if (this.activeReadersCount < this.max_readers && this.lastAssignedBlock < this.head && this.allowMoreReaders) {
                        // Assign next range
                        const start = this.lastAssignedBlock;
                        let end = this.lastAssignedBlock + this.maxBatchSize;
                        if (end > this.head) {
                            end = this.head;
                        }
                        this.lastAssignedBlock += this.maxBatchSize;
                        const def = {
                            first_block: start,
                            last_block: end
                        };
                        this.activeReadersCount++;
                        messageAllWorkers(cluster, {
                            event: 'new_range',
                            target: msg.id,
                            data: def
                        });
                    }
                }
            },
            'add_index': (msg: any) => {
                this.indexedObjects += msg.size;
            },
            'ds_report': (msg: any) => {
                this.deserializedActions += msg.actions;
                this.deserializedDeltas += msg.deltas;
            },
            'ds_error': (msg: any) => {
                const str = JSON.stringify(msg.data);
                this.dsErrorStream.write(str + '\n');
            },
            'read_block': (msg: any) => {
                if (!msg.live) {
                    this.pushedBlocks++;
                } else {
                    this.livePushedBlocks++;
                }
            },
            'new_schedule': (msg: any) => {
                this.onScheduleUpdate(msg);
            },
            'ds_ready': (msg: any) => {
                console.log(msg);
            },
            'contract_usage_report': (msg: any) => {
                if (msg.data) {
                    this.totalContractHits += msg.total_hits;
                    for (const contract in msg.data) {
                        if (msg.data.hasOwnProperty(contract)) {
                            if (this.globalUsageMap[contract]) {
                                this.globalUsageMap[contract][0] += msg.data[contract];
                            } else {
                                this.globalUsageMap[contract] = [msg.data[contract], 0, []];
                            }
                        }
                    }
                }
            }
        };
    }

    printMode() {
        const package_json = JSON.parse(readFileSync('./package.json').toString());
        console.log(`--------- Hyperion Indexer ${package_json.version} ---------`);
        console.log(`Using parser version ${this.conf.settings.parser}`);
        console.log(`Chain: ${this.conf.settings.chain}`);
        if (this.conf.indexer.abi_scan_mode) {
            console.log('-------------------\n ABI SCAN MODE \n-------------------');
        } else {
            console.log('---------------\n INDEXING MODE \n---------------');
        }
    }

    private async purgeQueues() {
        if (this.conf.indexer.purge_queues) {
            if (this.conf.indexer.disable_reading) {
                console.log('Cannot purge queue with disabled reading! Exiting now!');
                process.exit(1);
            } else {
                await this.manager.purgeQueues();
            }
        }
    }

    private async verifyIngestClients() {
        for (const ingestClient of this.manager.ingestClients) {
            try {
                const ping_response: ApiResponse = await ingestClient.ping();
                if (ping_response.body) {
                    console.log(`Ingest client ready at ${ping_response.meta.connection.id}`);
                }
            } catch (e) {
                console.log(e);
                console.log('Failed to connect to one of the ingestion nodes. Please verify the connections.json file');
                process.exit(1);
            }
        }
    }

    private addStateTables(indicesList, index_queues) {
        const queue_prefix = this.conf.settings.chain;
        const index_queue_prefix = queue_prefix + ':index';
        const table_feats = this.conf.features.tables;
        if (table_feats.proposals) {
            indicesList.push("table-proposals");
            index_queues.push({type: 'table-proposals', name: index_queue_prefix + "_table_proposals"});
        }
        if (table_feats.accounts) {
            indicesList.push("table-accounts");
            index_queues.push({type: 'table-accounts', name: index_queue_prefix + "_table_accounts"});
        }
        if (table_feats.voters) {
            indicesList.push("table-voters");
            index_queues.push({type: 'table-voters', name: index_queue_prefix + "_table_voters"});
        }
        if (table_feats.delband) {
            indicesList.push("table-delband");
            index_queues.push({type: 'table-delband', name: index_queue_prefix + "_table_delband"});
        }
        if (table_feats.userres) {
            indicesList.push("table-userres");
            index_queues.push({type: 'table-userres', name: index_queue_prefix + "_table_userres"});
        }
    }

    private async getCurrentSchedule() {
        this.currentSchedule = await this.rpc.get_producer_schedule();
    }

    private async applyUpdateScript() {
        const script_status = await this.client.putScript({
            id: "updateByBlock",
            body: {
                script: {
                    lang: "painless",
                    source: `
                    boolean valid = false;
                    if(ctx._source.block_num != null) {
                      if(params.block_num < ctx._source.block_num) {
                        ctx['op'] = 'none';
                        valid = false;
                      } else {
                        valid = true;
                      } 
                    } else {
                      valid = true;
                    }
                    if(valid == true) {
                      for (entry in params.entrySet()) {
                        if(entry.getValue() != null) {
                          ctx._source[entry.getKey()] = entry.getValue();
                        } else {
                          ctx._source.remove(entry.getKey());
                        }
                      }
                    }
                `
                }
            }
        });
        if (!script_status.body['acknowledged']) {
            console.log('Failed to load script updateByBlock. Aborting!');
            process.exit(1);
        } else {
            console.log('Painless Update Script loaded!');
        }
    }

    private async addLifecyclePolicies(indexConfig) {
        if (indexConfig.ILPs) {
            for (const ILP of indexConfig.ILPs) {
                try {
                    await this.client.ilm.getLifecycle({
                        policy: ILP.policy
                    });
                } catch (e) {
                    console.log(e);
                    try {
                        const ilm_status: ApiResponse = await this.client.ilm.putLifecycle(ILP);
                        if (!ilm_status.body['acknowledged']) {
                            console.log(`Failed to create ILM Policy`);
                        }
                    } catch (e) {
                        console.log(`[FATAL] :: Failed to create ILM Policy`);
                        console.log(e);
                        process.exit(1);
                    }
                }
            }
        }
    }

    private async appendExtraMappings(indexConfig) {
        // Modify mappings
        for (const exM of this.mLoader.extraMappings) {
            if (exM['action']) {
                for (const key in exM['action']) {
                    if (exM['action'].hasOwnProperty(key)) {
                        indexConfig['action']['mappings']['properties'][key] = exM['action'][key];
                        console.log(`Mapping added for ${key}`);
                    }
                }
            }
        }
    }

    private async updateIndexTemplates(indicesList: string[], indexConfig) {
        // Update index templates
        for (const index of indicesList) {
            try {
                const creation_status: ApiResponse = await this.client['indices'].putTemplate({
                    name: `${this.conf.settings.chain}-${index}`,
                    body: indexConfig[index]
                });
                if (!creation_status['body']['acknowledged']) {
                    console.log(`Failed to create template: ${this.conf.settings.chain}-${index}`);
                }
            } catch (e) {
                console.log(e);
                process.exit(1);
            }
        }
        console.log('Index templates updated');
    }

    private async createIndices(indicesList: string[]) {
        // Create indices
        const queue_prefix = this.conf.settings.chain;
        if (this.conf.settings.index_version) {
            // Create indices
            let version;
            if (this.conf.settings.index_version === 'true') {
                version = 'v1';
            } else {
                version = this.conf.settings.index_version;
            }
            for (const index of indicesList) {
                const new_index = `${queue_prefix}-${index}-${version}-000001`;
                const exists = await this.client.indices.exists({
                    index: new_index
                });
                if (!exists.body) {
                    console.log(`Creating index ${new_index}...`);
                    await this.client['indices'].create({
                        index: new_index
                    });
                    console.log(`Creating alias ${queue_prefix}-${index} >> ${new_index}`);
                    await this.client.indices.putAlias({
                        index: new_index,
                        name: `${queue_prefix}-${index}`
                    });
                }
            }
        }

        // Check for indexes
        for (const index of indicesList) {
            const status = await this.client.indices.existsAlias({
                name: `${queue_prefix}-${index}`
            });
            if (!status) {
                console.log('Alias ' + `${queue_prefix}-${index}` + ' not found! Aborting!');
                process.exit(1);
            }
        }
    }

    private async defineBlockRange() {
        // Define block range
        if (this.conf.indexer.start_on !== 0) {
            this.starting_block = this.conf.indexer.start_on;
            // Check last indexed block again
            if (!this.conf.indexer.rewrite) {
                let lastIndexedBlockOnRange;
                if (this.conf.features.index_deltas) {
                    lastIndexedBlockOnRange = await getLastIndexedBlockByDeltaFromRange(this.client, this.chain, this.starting_block, this.head);
                } else {
                    lastIndexedBlockOnRange = await getLastIndexedBlockFromRange(this.client, this.chain, this.starting_block, this.head);
                }
                if (lastIndexedBlockOnRange > this.starting_block) {
                    console.log('WARNING! Data present on target range!');
                    console.log('Changing initial block num. Use REWRITE = true to bypass.');
                    this.starting_block = lastIndexedBlockOnRange;
                }
            }
            console.log(' |>> First Block: ' + this.starting_block);
            console.log(' >>| Last  Block: ' + this.head);
        }
    }

    private static printWorkerMap(wmp) {
        console.log('---------------- PROPOSED WORKER LIST ----------------------');
        for (const w of wmp) {
            const str = [];
            for (const key in w) {
                if (w.hasOwnProperty(key) && key !== 'worker_id') {
                    switch (key) {
                        case 'worker_role': {
                            str.push(`Role: ${w[key]}`);
                            break;
                        }
                        case 'worker_queue': {
                            str.push(`Queue Name: ${w[key]}`);
                            break;
                        }
                        case 'first_block': {
                            str.push(`First Block: ${w[key]}`);
                            break;
                        }
                        case 'last_block': {
                            str.push(`Last Block: ${w[key]}`);
                            break;
                        }
                        case 'live_mode': {
                            str.push(`Live Mode: ${w[key]}`);
                            break;
                        }
                        case 'type': {
                            str.push(`Index Type: ${w[key]}`);
                            break;
                        }
                        case 'worker_last_processed_block': {
                            str.push(`Last Processed Block: ${w[key]}`);
                            break;
                        }
                        case 'queue': {
                            str.push(`Indexing Queue: ${w[key]}`);
                            break;
                        }
                        default: {
                            str.push(`${key}: ${w[key]}`);
                        }
                    }
                }
            }
            console.log(`Worker ID: ${w.worker_id} \t ${str.join(" | ")}`)
        }
        console.log('--------------------------------------------------');
    }

    private async setupDeserializers() {
        for (let i = 0; i < this.conf.scaling.ds_queues; i++) {
            for (let j = 0; j < this.conf.scaling.ds_threads; j++) {
                this.addWorker({
                    worker_role: 'deserializer',
                    worker_queue: this.chain + ':blocks' + ":" + (i + 1),
                    live_mode: 'false'
                });
            }
        }
    }

    private async setupIndexers() {
        let qIdx = 0;
        this.IndexingQueues.forEach((q) => {
            let n = this.conf.scaling.indexing_queues;
            if (q.type === 'abi') {
                n = 1;
            }
            qIdx = 0;
            for (let i = 0; i < n; i++) {
                let m = 1;
                if (q.type === 'action' || q.type === 'delta') {
                    m = this.conf.scaling.ad_idx_queues;
                }
                for (let j = 0; j < m; j++) {
                    this.addWorker({
                        worker_role: 'ingestor',
                        queue: q.name + ":" + (qIdx + 1),
                        type: q.type
                    });
                    qIdx++;
                }
            }
        });
    }

    private async setupStreaming() {
        const _streaming = this.conf.features.streaming;
        if (_streaming.enable) {
            this.addWorker({worker_role: 'router'});
            if (_streaming.deltas) console.log('Delta streaming enabled!');
            if (_streaming.traces) console.log('Action trace streaming enabled!');
            if (!_streaming.deltas && !_streaming.traces) {
                console.log('WARNING! Streaming is enabled without any datatype,' +
                    'please enable STREAM_TRACES and/or STREAM_DELTAS');
            }
        }
    }

    private addWorker(def: any) {
        this.worker_index++;
        def.worker_id = this.worker_index;
        this.workerMap.push(def);
    }

    private async setupDSPool() {
        for (let i = 0; i < this.conf.scaling.ds_pool_size; i++) {
            this.addWorker({
                worker_role: 'ds_pool_worker',
                local_id: i
            });
        }
    }

    private async waitForLaunch(): Promise<void> {

        return new Promise(resolve => {

            console.log(`Use "pm2 trigger ${pm2io.getConfig()['module_name']} start" to start the indexer now or restart without preview mode.`);

            const idleTimeout = setTimeout(() => {
                console.log('No command received after 10 minutes.');
                console.log('Exiting now! Disable the PREVIEW mode to continue.');
                process.exit(1);
            }, 60000 * 10);

            pm2io.action('start', (reply) => {
                resolve();
                reply({ack: true});
                clearTimeout(idleTimeout);
            });

        });
    }

    setupDSElogs() {
        const logPath = './logs/' + this.chain;
        if (!existsSync(logPath)) mkdirSync(logPath, {recursive: true});
        const dsLogFileName = (new Date().toISOString()) + "_ds_err_" + this.starting_block + "_" + this.head + ".log";
        const dsErrorsLog = logPath + '/' + dsLogFileName;
        if (existsSync(dsErrorsLog)) unlinkSync(dsErrorsLog);
        const symbolicLink = logPath + '/deserialization_errors.log';
        if (existsSync(symbolicLink)) unlinkSync(symbolicLink);
        symlinkSync(dsLogFileName, symbolicLink);
        this.dsErrorStream = createWriteStream(dsErrorsLog, {flags: 'a'});
        console.log(`📣️  Deserialization errors are being logged in: ${join(__dirname, symbolicLink)}`);
    }

    onLiveBlock(msg) {
        if (msg.block_num === this.lastProducedBlockNum + 1 || this.lastProducedBlockNum === 0) {
            const prod = msg.producer;

            if (this.conf.settings.bp_logs) {
                console.log(`Received block ${msg.block_num} from ${prod}`);
            }
            if (this.producedBlocks[prod]) {
                this.producedBlocks[prod]++;
            } else {
                this.producedBlocks[prod] = 1;
            }
            if (this.lastProducer !== prod) {
                this.handoffCounter++;
                if (this.lastProducer && this.handoffCounter > 2) {
                    const activeProds = this.currentSchedule.active.producers;
                    const newIdx = activeProds.findIndex(p => p['producer_name'] === prod) + 1;
                    const oldIdx = activeProds.findIndex(p => p['producer_name'] === this.lastProducer) + 1;
                    if ((newIdx === oldIdx + 1) || (newIdx === 1 && oldIdx === activeProds.length)) {
                        if (this.conf.settings.bp_logs) {
                            console.log(`[${msg.block_num}] producer handoff: ${this.lastProducer} [${oldIdx}] -> ${prod} [${newIdx}]`);
                        }
                    } else {
                        let cIdx = oldIdx + 1;
                        while (cIdx !== newIdx) {
                            try {
                                if (activeProds[cIdx - 1]) {
                                    const missingProd = activeProds[cIdx - 1]['producer_name'];
                                    this.reportMissedBlocks(missingProd, this.lastProducedBlockNum, 12);
                                    if (this.missedRounds[missingProd]) {
                                        this.missedRounds[missingProd]++;
                                    } else {
                                        this.missedRounds[missingProd] = 1;
                                    }
                                    console.log(`${missingProd} missed a round [${this.missedRounds[missingProd]}]`);
                                }
                            } catch (e) {
                                console.log(activeProds);
                                console.log(e);
                            }
                            cIdx++;
                            if (cIdx === activeProds.length) {
                                cIdx = 0;
                            }
                        }
                    }
                    if (this.producedBlocks[this.lastProducer]) {
                        if (this.producedBlocks[this.lastProducer] < 12) {
                            const _size = 12 - this.producedBlocks[this.lastProducer];
                            this.reportMissedBlocks(this.lastProducer, this.lastProducedBlockNum, _size);
                        }
                    }
                    this.producedBlocks[this.lastProducer] = 0;
                }
                this.lastProducer = prod;
            }
            this.lastProducedBlockNum = msg.block_num;
        } else {
            this.blockMsgQueue.push(msg);
            this.blockMsgQueue.sort((a, b) => a.block_num - b.block_num);
            while (this.blockMsgQueue.length > 0) {
                if (this.blockMsgQueue[0].block_num === this.lastProducedBlockNum + 1) {
                    this.onLiveBlock(this.blockMsgQueue.shift());
                } else {
                    break;
                }
            }
        }
    }

    handleMessage(msg) {
        this.totalMessages++;
        if (this.msgHandlerMap[msg.event]) {
            this.msgHandlerMap[msg.event](msg);
        } else {
            if (msg.type) {
                if (msg.type === 'axm:monitor') {
                    if (process.env['AXM_DEBUG'] === 'true') {
                        console.log(`----------- axm:monitor ------------`);
                        for (const key in msg.data) {
                            if (msg.data.hasOwnProperty(key)) {
                                console.log(`${key}: ${msg.data[key].value}`);
                            }
                        }
                    }
                }
            }
        }
    }

    private async setupReaders() {
        // Setup Readers
        this.lastAssignedBlock = this.starting_block;
        this.activeReadersCount = 0;
        if (!this.conf.indexer.repair_mode) {
            if (!this.conf.indexer.live_only_mode) {
                while (this.activeReadersCount < this.max_readers && this.lastAssignedBlock < this.head) {
                    const start = this.lastAssignedBlock;
                    let end = this.lastAssignedBlock + this.maxBatchSize;
                    if (end > this.head) {
                        end = this.head;
                    }
                    this.lastAssignedBlock += this.maxBatchSize;
                    this.addWorker({
                        worker_role: 'reader',
                        first_block: start,
                        last_block: end
                    });
                    this.activeReadersCount++;
                    console.log(`Setting parallel reader [${this.worker_index}] from block ${start} to ${end}`);
                }
            }
            // Setup Serial reader worker
            if (this.conf.indexer.live_reader) {
                const _head = this.chain_data.head_block_num;
                console.log(`Setting live reader at head = ${_head}`);
                // live block reader
                this.addWorker({
                    worker_role: 'continuous_reader',
                    worker_last_processed_block: _head,
                    ws_router: ''
                });
                // live deserializer
                this.addWorker({
                    worker_role: 'deserializer',
                    worker_queue: this.chain + ':live_blocks',
                    live_mode: 'true'
                });
            }
        }
    }

    private reportMissedBlocks(missingProd: any, lastProducedBlockNum: number, size: number) {
        console.log(`${missingProd} missed ${size} ${size === 1 ? "block" : "blocks"} after ${lastProducedBlockNum}`);
        this.client.index({
            index: this.chain + '-logs',
            body: {
                type: 'missed_blocks',
                '@timestamp': new Date().toISOString(),
                'missed_blocks': {
                    'producer': missingProd,
                    'last_block': lastProducedBlockNum,
                    'size': size,
                    'schedule_version': this.currentSchedule.schedule_version
                }
            }
        }).catch(console.log);
    }

    // private startRepairMode() {
    //     let doctorStarted = false;
    //     let doctorId = 0;
    //     doctor.run(this.missingRanges as any).then(() => {
    //         console.log('repair completed!');
    //     });
    //     setInterval(() => {
    //         if (this.missingRanges.length > 0 && !doctorStarted) {
    //             doctorStarted = true;
    //             console.log('repair worker launched');
    //             const range_data = this.missingRanges.shift();
    //             this.worker_index++;
    //             const def = {
    //                 worker_id: this.worker_index,
    //                 worker_role: 'reader',
    //                 first_block: range_data.start,
    //                 last_block: range_data.end
    //             };
    //             const self = cluster.fork(def);
    //             doctorId = def.worker_id;
    //             console.log('repair id =', doctorId);
    //             self.on('message', (msg) => {
    //                 this.handleMessage(msg);
    //             });
    //         } else {
    //             if (this.missingRanges.length > 0 && this.doctorIdle) {
    //                 const range_data = this.missingRanges.shift();
    //                 messageAllWorkers(cluster, {
    //                     event: 'new_range',
    //                     target: doctorId.toString(),
    //                     data: {
    //                         first_block: range_data.start,
    //                         last_block: range_data.end
    //                     }
    //                 });
    //             }
    //         }
    //     }, 1000);
    // }

    updateWorkerAssignments() {
        const pool_size = this.conf.scaling.ds_pool_size;
        const worker_max_pct = 1 / pool_size;
        const worker_shares = {};
        for (let i = 0; i < pool_size; i++) {
            worker_shares[i] = 0.0;
        }
        for (const code in this.globalUsageMap) {
            if (this.globalUsageMap.hasOwnProperty(code)) {
                const _pct = this.globalUsageMap[code][0] / this.totalContractHits;
                let used_pct = 0;
                const proposedWorkers = [];
                for (let i = 0; i < pool_size; i++) {
                    if (worker_shares[i] < worker_max_pct) {
                        const rem_pct = (_pct - used_pct);
                        if (rem_pct === 0) {
                            break;
                        }
                        if (rem_pct > worker_max_pct) {
                            used_pct += (worker_max_pct - worker_shares[i]);
                            worker_shares[i] = worker_max_pct;
                        } else {
                            if (worker_shares[i] + rem_pct > worker_max_pct) {
                                used_pct += (worker_max_pct - worker_shares[i]);
                                worker_shares[i] = worker_max_pct;
                            } else {
                                used_pct += rem_pct;
                                worker_shares[i] += rem_pct;
                            }
                        }
                        proposedWorkers.push(i);
                    }
                }
                this.globalUsageMap[code][1] = _pct;
                if (JSON.stringify(this.globalUsageMap[code][2]) !== JSON.stringify(proposedWorkers)) {

                    console.log(this.globalUsageMap[code][2], ">>", proposedWorkers);

                    proposedWorkers.forEach(w => {
                        const idx = this.globalUsageMap[code][2].indexOf(w);
                        if (idx === -1) {
                            console.log(`Worker ${w} assigned to ${code}`);
                        } else {
                            this.globalUsageMap[code][2].splice(idx, 1);
                        }
                    });

                    this.globalUsageMap[code][2].forEach(w_id => {
                        console.log(`>>>> Worker ${this.globalUsageMap[code][2]} removed from ${code}!`);
                        if (this.dsPoolMap.has(w_id)) {
                            this.dsPoolMap.get(w_id).send({
                                event: "remove_contract",
                                contract: code
                            });
                        }
                    });
                    this.globalUsageMap[code][2] = proposedWorkers;
                }
            }
        }
    }

    private startContractMonitoring() {
        // Monitor Global Contract Usage
        setInterval(() => {

            // const t0 = process.hrtime.bigint();
            this.updateWorkerAssignments();
            // const t1 = process.hrtime.bigint();

            // console.log('----------- Usage Report ----------');
            // console.log(`Total Hits: ${this.totalContractHits}`);
            // console.log(`Update time: ${parseInt((t1 - t0).toString()) / 1000000} ms`);
            // console.log(this.globalUsageMap);
            // console.log('-----------------------------------');

            // update on deserializers
            for (const w of this.workerMap) {
                if (w.worker_role === 'deserializer') {
                    w.wref.send({
                        event: 'update_pool_map',
                        data: this.globalUsageMap
                    });
                }
            }

            // clearUsageMap();
        }, 5000);
    }

    private onPm2Stop() {
        pm2io.action('stop', (reply) => {
            this.allowMoreReaders = false;
            console.info('Stop signal received. Shutting down readers immediately!');
            console.log('Waiting for queues...');
            messageAllWorkers(cluster, {
                event: 'stop'
            });
            reply({ack: true});
            setInterval(() => {
                if (this.allowShutdown) {
                    console.log('Shutting down master...');
                    process.exit(1);
                }
            }, 500);
        });
    }

    private startIndexMonitoring() {
        const reference_time = Date.now();
        setInterval(() => {
            const _workers = Object.keys(cluster.workers).length;
            const tScale = (this.log_interval / 1000);
            this.total_read += this.pushedBlocks;
            this.total_blocks += this.consumedBlocks;
            this.total_actions += this.deserializedActions;
            this.total_deltas += this.deserializedDeltas;
            this.total_indexed_blocks += this.indexedObjects;
            const consume_rate = this.consumedBlocks / tScale;
            this.consume_rates.push(consume_rate);
            if (this.consume_rates.length > 20) {
                this.consume_rates.splice(0, 1);
            }
            let avg_consume_rate = 0;
            if (this.consume_rates.length > 0) {
                for (const r of this.consume_rates) {
                    avg_consume_rate += r;
                }
                avg_consume_rate = avg_consume_rate / this.consume_rates.length;
            } else {
                avg_consume_rate = consume_rate;
            }
            const log_msg = [];

            log_msg.push(`W:${_workers}`);
            log_msg.push(`R:${(this.pushedBlocks + this.livePushedBlocks) / tScale} b/s`);
            log_msg.push(`C:${(this.liveConsumedBlocks + this.consumedBlocks) / tScale} b/s`);
            log_msg.push(`D:${(this.deserializedActions + this.deserializedDeltas) / tScale} a/s`);
            log_msg.push(`I:${this.indexedObjects / tScale} d/s`);

            if (this.total_blocks < this.total_range && !this.conf.indexer.live_only_mode) {
                const remaining = this.total_range - this.total_blocks;
                const estimated_time = Math.round(remaining / avg_consume_rate);
                const time_string = moment().add(estimated_time, 'seconds').fromNow(false);
                const pct_parsed = ((this.total_blocks / this.total_range) * 100).toFixed(1);
                const pct_read = ((this.total_read / this.total_range) * 100).toFixed(1);
                log_msg.push(`${this.total_blocks}/${this.total_read}/${this.total_range}`);
                log_msg.push(`syncs ${time_string} (${pct_parsed}% ${pct_read}%)`);
            }

            // Report completed range (parallel reading)
            if (this.total_blocks === this.total_range && !this.range_completed) {
                console.log(`-------- BLOCK RANGE COMPLETED -------------`);
                console.log(`Range: ${this.starting_block} >> ${this.head}`);
                const ttime = (Date.now() - reference_time) / 1000;
                console.log(`Total time: ${ttime} seconds`);
                console.log(`Blocks: ${this.total_range}`);
                console.log(`Actions: ${this.total_actions}`);
                console.log(`Deltas: ${this.total_deltas}`);
                console.log('--------------------------------------------');
                this.range_completed = true;
            }

            // print monitoring log
            if (this.conf.settings.rate_monitoring) {
                console.log(log_msg.join(', '));
            }

            if (this.indexedObjects === 0 && this.deserializedActions === 0 && this.consumedBlocks === 0) {

                // Allow 10s threshold before shutting down the process
                this.shutdownTimer = setTimeout(() => {
                    this.allowShutdown = true;
                }, 10000);

                // Auto-Stop
                if (this.pushedBlocks === 0) {
                    this.idle_count++;
                    if (this.auto_stop > 0 && (tScale * this.idle_count) >= this.auto_stop) {
                        console.log("Reached limit for no blocks processed, stopping now...");
                        process.exit(1);
                    } else {
                        console.log(`No blocks processed! Indexer will stop in ${this.auto_stop - (tScale * this.idle_count)} seconds!`);
                    }
                }
            } else {
                if (this.idle_count > 1) {
                    console.log('Processing resumed!');
                }
                this.idle_count = 0;
                if (this.shutdownTimer) {
                    clearTimeout(this.shutdownTimer);
                    this.shutdownTimer = null;
                }
            }

            // reset counters
            this.resetMonitoringCounters();


            if (_workers === 0) {
                console.log('FATAL ERROR - All Workers have stopped!');
                process.exit(1);
            }

        }, this.log_interval);
    }

    resetMonitoringCounters() {
        this.pushedBlocks = 0;
        this.livePushedBlocks = 0;
        this.consumedBlocks = 0;
        this.liveConsumedBlocks = 0;
        this.deserializedActions = 0;
        this.deserializedDeltas = 0;
        this.indexedObjects = 0;
    }

    private onScheduleUpdate(msg: any) {
        if (msg.live === 'true') {
            console.log(`Producer schedule updated at block ${msg.block_num}`);
            this.currentSchedule.active.producers = msg.new_producers.producers
        }
    }

    private launchWorkers() {
        this.workerMap.forEach((conf) => {
            conf['wref'] = cluster.fork(conf);
            if (conf.worker_role === 'ds_pool_worker') {
                this.dsPoolMap.set(conf.local_id, conf['wref']);
            }
        });
    }

    async runMaster() {

        this.printMode();

        // Preview mode - prints only the proposed worker map
        let preview = this.conf.settings.preview;
        const queue_prefix = this.conf.settings.chain;

        await this.purgeQueues();

        // Chain API
        this.rpc = this.manager.nodeosJsonRPC;
        await this.getCurrentSchedule();
        console.log(`${this.currentSchedule.active.producers.length} active producers`);

        // ELasticsearch
        this.client = this.manager.elasticsearchClient;
        await this.verifyIngestClients();
        this.max_readers = this.conf.scaling.readers;
        if (this.conf.indexer.disable_reading) {
            this.max_readers = 1;
        }
        const {index_queues} = require('../definitions/index-queues');
        this.IndexingQueues = index_queues;
        const indicesList = ["action", "block", "abi", "delta", "logs"];
        this.addStateTables(indicesList, index_queues);
        await this.applyUpdateScript();
        const indexConfig = require('../definitions/mappings');
        await this.addLifecyclePolicies(indexConfig);
        await this.appendExtraMappings(indexConfig);
        await this.updateIndexTemplates(indicesList, indexConfig);
        await this.createIndices(indicesList);

        // Prepare Workers
        this.workerMap = [];
        this.worker_index = 0;
        this.maxBatchSize = this.conf.scaling.batch_size;

        // Auto-stop
        if (this.conf.settings.auto_stop) {
            this.auto_stop = this.conf.settings.auto_stop;
        }

        // Find last indexed block
        let lastIndexedBlock;
        if (this.conf.features.index_deltas) {
            lastIndexedBlock = await getLastIndexedBlockByDelta(this.client, queue_prefix);
            console.log('Last indexed block (deltas):', lastIndexedBlock);
        } else {
            lastIndexedBlock = await getLastIndexedBlock(this.client, queue_prefix);
            console.log('Last indexed block (blocks):', lastIndexedBlock);
        }

        // Start from the last indexed block
        this.starting_block = 1;

        // Fecth chain lib
        this.chain_data = await this.rpc.get_info();
        this.head = this.chain_data.head_block_num;

        if (lastIndexedBlock > 0) {
            this.starting_block = lastIndexedBlock;
        }

        if (this.conf.indexer.stop_on !== 0) {
            this.head = this.conf.indexer.stop_on;
        }

        let lastIndexedABI = await getLastIndexedABI(this.client, queue_prefix);
        console.log(`Last indexed ABI: ${lastIndexedABI}`);
        if (this.conf.indexer.abi_scan_mode) {
            this.starting_block = lastIndexedABI;
        }

        await this.defineBlockRange();
        this.total_range = this.head - this.starting_block;
        await this.setupReaders();
        await this.setupDeserializers();
        await this.setupIndexers();
        await this.setupStreaming();
        await this.setupDSPool();

        // Quit App if on preview mode
        if (preview) {
            HyperionMaster.printWorkerMap(this.workerMap);
            await this.waitForLaunch();
        }

        // Setup Error Logging
        this.setupDSElogs();

        // Start Monitoring
        this.startIndexMonitoring();

        cluster.on('disconnect', (worker) => {
            console.log(`The worker #${worker.id} has disconnected`);
        });

        // Launch all workers
        this.launchWorkers();

        this.totalMessages = 0;
        setInterval(() => {
            console.log(`IPC Messaging Rate: ${(this.totalMessages / 10).toFixed(2)} msg/s`);
            this.totalMessages = 0;
        }, 10000);

        // Attach handlers
        for (const c in cluster.workers) {
            if (cluster.workers.hasOwnProperty(c)) {
                cluster.workers[c].on('message', (msg) => {
                    this.handleMessage(msg);
                });
            }
        }

        // TODO: reimplement the indexer repair mode in typescript modules
        // if (this.conf.indexer.repair_mode) {
        //     this.startRepairMode();
        // }

        this.startContractMonitoring();
        this.onPm2Stop();
    }
}
