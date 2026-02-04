// Non-secret configuration managed by SST
// Values vary by stage using $app.stage

export const config = {
    // Application
    app: {
        nodeEnv: new sst.Linkable('NodeEnv', {
            properties: { value: $app.stage === 'production' ? 'production' : 'development' },
        }),
        logLevel: new sst.Linkable('LogLevel', {
            properties: { value: $app.stage === 'production' ? 'info' : 'debug' },
        }),
        port: new sst.Linkable('Port', {
            properties: { value: '3000' },
        }),
    },
};
