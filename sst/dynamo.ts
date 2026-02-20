// DynamoDB single-table for Isambard memory system
export const memoryTable = new sst.aws.Dynamo('IsambardMemory', {
    fields: {
        PK:     'string',        // Partition key
        SK:     'string',        // Sort key
        GSI1PK: 'string',    // GSI1 partition key
        GSI1SK: 'string',    // GSI1 sort key
        GSI2PK: 'string',    // GSI2 partition key
        GSI2SK: 'string',    // GSI2 sort key
    },
    primaryIndex: {
        hashKey:  'PK',
        rangeKey: 'SK',
    },
    globalIndexes: {
        GSI1: {
            hashKey:  'GSI1PK',
            rangeKey: 'GSI1SK',
        },
        GSI2: {
            hashKey:  'GSI2PK',
            rangeKey: 'GSI2SK',
        },
    },
    ttl:       'TTL',  // Enable TTL on TTL attribute
    transform: {
        table: {
            billingMode:            'PROVISIONED',
            readCapacity:           5,
            writeCapacity:          2,
            globalSecondaryIndexes: [
                {
                    name:           'GSI1',
                    hashKey:        'GSI1PK',
                    rangeKey:       'GSI1SK',
                    readCapacity:   2,
                    writeCapacity:  2,
                    projectionType: 'ALL',
                },
                {
                    name:           'GSI2',
                    hashKey:        'GSI2PK',
                    rangeKey:       'GSI2SK',
                    readCapacity:   1,
                    writeCapacity:  1,
                    projectionType: 'ALL',
                },
            ],
        },
    },
});
