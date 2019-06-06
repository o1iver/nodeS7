//@ts-check
/*
    Copyright (c) 2019 Guilherme Francescon Cittolin

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.
*/
/*jshint esversion: 6, node: true*/

const { EventEmitter } = require('events');
//@ts-ignore
const constants = require('./constants.json');
const util = require('util');
const debug = util.debuglog('nodes7');

const S7Item = require('./s7item.js');
const S7Endpoint = require('./s7endpoint.js');

class S7ItemGroup extends EventEmitter {

    /**
     * 
     * @param {S7Endpoint} s7endpoint 
     * @param {object} [opts]
     * @param {boolean} [opts.skipOptimization=false] whether item optimization should be skipped
     * @param {number} [opts.optimizationGap=5] how many bytes away from the last item we may still try to optimize
     */
    constructor(s7endpoint, opts) {
        debug('new S7ItemGroup');

        opts = opts || {};

        super();

        this._endpoint = s7endpoint;
        this._skipOptimization = opts.skipOptimization;
        this._optimizationGap = opts.optimizationGap || 5;
        this._initParams();

        this._endpoint.on('pdu-size', () => this._invalidateReadPackets());
    }

    _initParams() {
        debug('S7ItemGroup _initParams');
        this._items = new Map();
        this._readPackets = null;
        this._translationCallback = this._defaultTranslationCallback;
        this._lastRequestTime = null;
        this._lastResponseTime = null;
    }

    _defaultTranslationCallback(tag) {
        return tag;
    }

    _prepareReadPackets() {
        debug('S7ItemGroup _prepareReadPackets');
        
        // we still don't have the pdu size, so abort computation
        if (!this._endpoint.pduSize) {
            debug('S7ItemGroup _prepareReadPackets no-pdu-size');
            return;
        }

        this._readPackets = [];

        //get array of items
        let items = Array.from(this._items.values());

        if (!items.length) {
            return;
        }

        //sort them according to our rules
        items.sort(itemListSorter);

        const reqHeaderSize = 12;
        const resHeaderSize = 14;
        const reqPartSize = 12;
        const resPartSize = 4;
        const maxPayloadSize = this._endpoint.pduSize - 18;

        let packet;
        let part;
        let pktReqLength;
        let pktResLength;
        let lastItem;

        debug('S7ItemGroup _prepareReadPackets maxPayloadSize', maxPayloadSize);

        /**
         * Group all items in packets with their parts
         */
        for (const item of items) {

            /* conditions to add to the same part*/
            if (packet && part
                && this._isOptimizable(lastItem, item)
                && maxPayloadSize >= (pktResLength + (item.offset + item.byteLength - part.address))
            ) {
                debug('S7ItemGroup _prepareReadPackets item-group', item._string);

                // compute the new part length to accomodate the new item
                let newLength = Math.max(part.length, item.offset - part.address + item.byteLength);
                pktResLength += newLength - part.length;
                part.length = newLength;

                //add the item to the part
                part.items.push(item);

                /* conditions to just add a new part to the packet, without creating a new one*/
            } else if (packet
                && maxPayloadSize >= (pktReqLength + reqPartSize)
                && maxPayloadSize >= (pktResLength + resPartSize + item.byteLength)
            ) {
                debug('S7ItemGroup _prepareReadPackets item-new-part', item._string);

                part = {
                    items: [item],
                    area: item.areaCode,
                    db: item.dbNumber,
                    transport: item.readTransportCode,
                    address: item.offset,
                    length: item.byteLength
                };
                packet.push(part);

                pktReqLength += reqPartSize;
                pktResLength += resPartSize + item.byteLength;

                /* nothing else we can optimize, create a new packet */
            } else {
                debug('S7ItemGroup _prepareReadPackets item-new-packet', item._string);

                //none of the conditions above met, add a new packet ...
                packet = [];
                this._readPackets.push(packet);

                pktReqLength = reqHeaderSize;
                pktResLength = resHeaderSize;

                // ... and a new part with the item to it
                part = {
                    items: [item],
                    area: item.areaCode,
                    db: item.dbNumber,
                    transport: item.readTransportCode,
                    address: item.offset,
                    length: item.byteLength
                };
                packet.push(part);

                pktReqLength += reqPartSize;
                pktResLength += resPartSize + item.byteLength;
            }

            lastItem = item;
        }

        // just for debugging purposes
        for (let i = 0; i < this._readPackets.length; i++) {

            const packet = this._readPackets[i];
            let lengthReq = reqHeaderSize;
            let lengthRes = resHeaderSize;
            debug('S7ItemGroup _prepareReadPackets pkt  #', i);

            for (let j = 0; j < packet.length; j++) {

                const part = packet[j];
                lengthReq += reqPartSize;
                lengthRes += resPartSize + part.length;
                debug('S7ItemGroup _prepareReadPackets part #', i, j, part.area, part.db, part.address, part.length);

                for (let k = 0; k < part.items.length; k++) {
                    const item = part.items[k];
                    debug('S7ItemGroup _prepareReadPackets item #', i, j, k, item._string);
                }
            }
            debug('S7ItemGroup _prepareReadPackets pkt  #', i, lengthReq, lengthRes);
        }
    }

    _invalidateReadPackets() {
        debug('S7ItemGroup _invalidateReadPackets');

        this._readPackets = null;
    }


    /**
     * Checks whether two S7Items can be grouped into the same request
     * 
     * @param {S7Item} a the first S7Item
     * @param {S7Item} b the second S7Item
     * @returns a boolean indicating whether the two items can be grouped into the same request
     */
    _isOptimizable(a, b) {
        let result = !this._skipOptimization
            // a and b exist
            && a && b
            // same area code
            && a.areaCode === b.areaCode
            // is of type DB, I, Q or M
            && (b.areaCode === constants.proto.area.DB
                || b.areaCode === constants.proto.area.INPUTS
                || b.areaCode === constants.proto.area.OUTPUTS
                || b.areaCode === constants.proto.area.FLAGS
            )
            // same DB number (or both undefined)
            && a.dbNumber === b.dbNumber
            // within our gap factor
            && (b.offset - a.offset - a.byteLength) < this._optimizationGap;
        debug('S7ItemGroup _isOptimizable', result);
        return result;
    }

    // ----- public methods

    /**
     * Sets a function that will be called whenever a tag name needs to be 
     * resolved to an address. By default, if none is given, then no translation
     * is performed
     * 
     * @param {null|undefined|function} func the function that translates tags to addresses
     * @throws an error when the supplied parameter is not a function
     */
    setTranslationCB(func) {
        debug("S7Endpoint setTranslationCB");

        if (typeof func === 'function') {
            this._translationCallback = func;
        } else if (func === null || func === undefined) {
            //set the default one
            this._translationCallback = this._defaultTranslationCallback;
        } else {
            throw new Error("Parameter must be a function");
        }
    }

    /**
     * Add an item or a group of items to be read from "readAllItems"
     * 
     * @param {string|Array<string>} tags the tag or list of tags to be added
     * @throws if the supplied parameter is not a string or an array of strings
     * @throws if the format of the address of the tag is invalid
     */
    addItems(tags) {
        debug("S7ItemGroup addItems", tags);

        if (typeof tags === 'string') {
            tags = [tags];
        } else if (!Array.isArray(tags)) {
            throw new Error("Parameter must be a string or an array of strings");
        }

        for (const tag of tags) {
            debug("S7ItemGroup addItems item", tag);

            if (typeof tag !== 'string') {
                throw new Error("Array elements must be all of string type");
            }

            let addr = this._translationCallback(tag);
            let item = new S7Item(tag, addr);

            this._items.set(tag, item);
        }

        // invalidate computed read packets
        this._invalidateReadPackets()
    }

    /**
     * Removes an item or a group of items to be read from "readAllItems"
     * 
     * @param {string|Array<string>} tags the tag or list of tags to be removed
     */
    removeItems(tags) {
        debug("S7ItemGroup removeItems", tags);

        if (!tags) {
            // clears all items by creating a new one
            this._items = new Map();
        } else if (Array.isArray(tags)) {
            for (const tag of tags) {
                this._items.delete(tag);
            }
        } else {
            this._items.delete(tags);
        }

        // invalidate computed read packets
        this._invalidateReadPackets();
    }

    /**
     * 
     * @param {string|Array<string>} tags 
     * @param {*|Array<*>} values 
     */
    async writeItems(tags, values) {
        debug("S7ItemGroup writeItems", tags, values);

        //TODO!
    }

    /**
     * 
     */
    async readAllItems() {
        debug("S7ItemGroup readAllItems");

        let result = {};

        // prepare read packets if needed
        if (!this._readPackets) {
            this._prepareReadPackets();
        }

        if (!this._readPackets.length) {
            return result;
        }

        // request items and await the response
        debug("S7ItemGroup readAllItems requests", this._readPackets);

        let requestTime = process.hrtime();
        let requests = this._readPackets.map(pkt => this._endpoint.readVars(pkt));
        let responses = await Promise.all(requests);
        this._lastRequestTime = process.hrtime(requestTime);
        
        debug("S7ItemGroup readAllItems responses", responses);
        debug("S7ItemGroup readAllItems requestTime", this._lastRequestTime);

        // parse response
        for (let i = 0; i < requests.length; i++){
            const req = this._readPackets[i];
            const res = responses[i];

            for(let j = 0; j < req.length; j++){
                const reqPart = req[j];
                const resPart = res[j];

                // check for empty response
                if (!resPart) {
                    throw new Error(`Empty response for request: Area [${reqPart.area}] DB [${reqPart.db}] Addr [${reqPart.address}] Len [${reqPart.length}]`);
                }

                // check response's error code
                if (resPart.returnCode != constants.proto.retval.DATA_OK) {
                    let errDesc = constants.proto.retvalDesc[resPart.returnCode] || `<Unknown error code ${resPart.returnCode}>`;
                    throw new Error(`Error returned from request of Area [${resPart.area}] DB [${resPart.db}] Addr [${resPart.address}] Len [${resPart.length}]: "${errDesc}"`)
                }

                // good to go, parse response
                for (const item of reqPart.items) {
                    const val = item.getValueFromResponse(resPart, reqPart);
                    result[item.name] = val;
                }
            }
        }

        return result;
    }

}

module.exports = S7ItemGroup;

/**
 * 
 * @param {S7Item} a 
 * @param {S7Item} b 
 */
function itemListSorter(a, b) {
    // Feel free to manipulate these next two lines...
    if (a.areaCode < b.areaCode) { return -1; }
    if (a.areaCode > b.areaCode) { return 1; }

    // Group first the items of the same DB
    if (a.addrtype === 'DB') {
        if (a.dbNumber < b.dbNumber) { return -1; }
        if (a.dbNumber > b.dbNumber) { return 1; }
    }

    // But for byte offset we need to start at 0.
    if (a.offset < b.offset) { return -1; }
    if (a.offset > b.offset) { return 1; }

    // Then bit offset
    if (a.bitOffset < b.bitOffset) { return -1; }
    if (a.bitOffset > b.bitOffset) { return 1; }

    // Then item length - most first.  This way smaller items are optimized into bigger ones if they have the same starting value.
    if (a.byteLength > b.byteLength) { return -1; }
    if (a.byteLength < b.byteLength) { return 1; }
}