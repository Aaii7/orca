const base = require('./electron-builder.config.cjs')
module.exports = {
  ...base,
  appId: 'com.stablyai.orca.teammatepreview',
  productName: 'Orca Teammate Preview',
  protocols: [{ name: 'Orca Teammate Preview', schemes: ['orca-teammate-preview'] }],
  publish: null,
  mac: { ...base.mac, identity: '-', notarize: false, hardenedRuntime: false }
}
